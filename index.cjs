#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PLUGIN_ID = 'dev.herdr.codex-subagents';
const PLUGIN_VERSION = '0.1.1';
const PANE_ENTRYPOINT = 'subagent';
const HOOK_MARKER = 'HERDR_CODEX_SUBAGENTS_V1';
const CLOSE_DELAY_MS = 10_000;
const STATE_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultState() {
  return { version: STATE_VERSION, nextOrder: 1, roots: {} };
}

function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function findExecutable(command, env = process.env) {
  if (path.isAbsolute(command)) {
    fs.accessSync(command, fs.constants.X_OK);
    return command;
  }

  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new Error(`${command} was not found on PATH`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function ownedHookHandler(command, timeout, async = false) {
  return {
    type: 'command',
    command,
    timeout,
    ...(async ? { async: true } : {}),
  };
}

function stripOwnedHooks(document) {
  const hooks = document && typeof document === 'object' && !Array.isArray(document)
    ? document.hooks
    : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return document;

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.filter((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return true;
      group.hooks = group.hooks.filter((handler) =>
        typeof handler?.command !== 'string' || !handler.command.includes(HOOK_MARKER));
      return group.hooks.length > 0;
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
  return document;
}

function mergeOwnedHooks(document, command) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Codex hooks root must be a JSON object');
  }
  if (document.hooks === undefined) document.hooks = {};
  if (!document.hooks || typeof document.hooks !== 'object' || Array.isArray(document.hooks)) {
    throw new Error('Codex hooks.hooks must be a JSON object');
  }

  stripOwnedHooks(document);
  const definitions = [
    ['SessionStart', undefined, ownedHookHandler(command, 8)],
    ['SubagentStart', undefined, ownedHookHandler(command, 8)],
    ['SubagentStop', undefined, ownedHookHandler(command, 30, true)],
    ['PostToolUse', '(followup_task|resume_agent)$', ownedHookHandler(command, 8)],
  ];
  for (const [event, matcher, handler] of definitions) {
    const group = { hooks: [handler] };
    if (matcher) group.matcher = matcher;
    (document.hooks[event] ||= []).push(group);
  }
  return document;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch {}
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
}

function readHooksFile(file) {
  if (!fs.existsSync(file)) return { hooks: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendLog(stateDir, message) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(
      path.join(stateDir, 'plugin.log'),
      `${new Date().toISOString()} ${String(message).replaceAll('\n', ' ')}\n`,
    );
  } catch {}
}

async function acquireDirectoryLock(lockDir, timeoutMs = 8_000) {
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner'), `${process.pid}\n`);
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > 30_000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for ${lockDir}`);
      await sleep(25);
    }
  }
}

function readState(stateDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    if (state?.version === STATE_VERSION && state.roots && typeof state.roots === 'object') {
      state.nextOrder ||= 1;
      return state;
    }
  } catch {}
  return defaultState();
}

async function withState(stateDir, callback) {
  fs.mkdirSync(stateDir, { recursive: true });
  const release = await acquireDirectoryLock(path.join(stateDir, 'state.lock'));
  try {
    const state = readState(stateDir);
    const result = await callback(state);
    atomicWriteJson(path.join(stateDir, 'state.json'), state);
    return result;
  } finally {
    release();
  }
}

function probeUnixSocket(socketPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function cleanDaemonEnvironment(env = process.env) {
  const cleaned = { ...env, HERDR_CODEX_SUBAGENT_DAEMON: '1' };
  for (const key of Object.keys(cleaned)) {
    if (key.startsWith('HERDR_') && key !== 'HERDR_CODEX_SUBAGENT_DAEMON') delete cleaned[key];
  }
  delete cleaned.CODEX_THREAD_ID;
  return cleaned;
}

async function ensureSharedAppServer(codexBin, stateDir, env = process.env) {
  const home = codexHome(env);
  const socketPath = path.join(home, 'app-server-control', 'app-server-control.sock');
  if (await probeUnixSocket(socketPath)) return socketPath;

  return withState(stateDir, async () => {
    if (await probeUnixSocket(socketPath)) return socketPath;

    const managedCodex = path.join(home, 'packages', 'standalone', 'current', 'codex');
    if (fs.existsSync(managedCodex)) {
      const result = spawnSync(codexBin, ['app-server', 'daemon', 'start'], {
        encoding: 'utf8',
        timeout: 10_000,
        env: cleanDaemonEnvironment(env),
      });
      if (result.status === 0 && await probeUnixSocket(socketPath, 1_000)) return socketPath;
      appendLog(stateDir, `managed daemon start failed: ${result.stderr || result.error || result.status}`);
    }

    const child = spawn(codexBin, ['app-server', '--listen', 'unix://'], {
      detached: true,
      stdio: 'ignore',
      env: cleanDaemonEnvironment(env),
    });
    child.unref();

    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await probeUnixSocket(socketPath)) return socketPath;
      await sleep(50);
    }
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    throw new Error(`Codex app-server did not become ready at ${socketPath}`);
  });
}

function buildHookCommand() {
  return `${HOOK_MARKER}=1 exec "\${CODEX_HOME:-$HOME/.codex}/herdr-plugins/${PLUGIN_ID}/index.cjs" hook`;
}

async function setup() {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!stateDir || !socketPath) throw new Error('setup must run as a Herdr startup hook');

  const codexBin = findExecutable('codex');
  const feature = spawnSync(codexBin, ['features', 'enable', 'hooks'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (feature.status !== 0) {
    throw new Error(`failed to enable Codex hooks: ${feature.stderr || feature.error || feature.status}`);
  }

  await ensureSharedAppServer(codexBin, stateDir);
  const runtimeDir = path.join(codexHome(), 'herdr-plugins', PLUGIN_ID);
  const runtimeScript = path.join(runtimeDir, 'index.cjs');
  const temporary = `${runtimeScript}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.copyFileSync(fs.realpathSync(__filename), temporary);
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, runtimeScript);
  atomicWriteJson(path.join(runtimeDir, 'runtime.json'), { stateDir, socketPath, codexBin });

  const hooksPath = path.join(codexHome(), 'hooks.json');
  const command = buildHookCommand();
  const document = mergeOwnedHooks(readHooksFile(hooksPath), command);
  atomicWriteJson(hooksPath, document);
  process.stdout.write(`Installed ${PLUGIN_ID} Codex hooks.\n`);
}

function herdrRequest(socketPath, method, params = {}, timeoutMs = 1_500) {
  return new Promise((resolve, reject) => {
    const id = `${PLUGIN_ID}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(new Error(`${method} timed out`)));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.error) {
          finish(new Error(`${response.error.code || method}: ${response.error.message || 'request failed'}`));
        } else {
          finish(null, response.result);
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

function codexRpc(codexBin, method, params, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanDaemonEnvironment(),
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch {}
      const killTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
      }, 100);
      killTimer.unref();
      if (error) reject(error); else resolve(value);
    };
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4_096); });
    child.stdin.once('error', (error) => finish(error));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`Codex app-server exited ${code}: ${stderr.trim()}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message || 'initialize failed'));
          send({ method: 'initialized', params: {} });
          send({ id: 2, method, params });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || `${method} failed`));
          return finish(null, message.result);
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: PLUGIN_ID, title: 'Herdr Codex Subagent Splits', version: PLUGIN_VERSION },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function readThread(codexBin, threadId, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await codexRpc(codexBin, 'thread/read', { threadId });
      return result.thread;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(100);
    }
  }
  throw lastError;
}

function agentPathFromThread(thread) {
  const subagent = thread?.source?.subagent || thread?.source?.subAgent;
  return subagent?.thread_spawn?.agent_path || thread?.agentPath || null;
}

async function threadIdentity(codexBin, threadId) {
  const thread = await readThread(codexBin, threadId);
  let rootId = thread.sessionId || thread.id;
  let current = thread;
  const visited = new Set([thread.id]);
  while (current.parentThreadId) {
    if (visited.has(current.parentThreadId)) break;
    visited.add(current.parentThreadId);
    current = await readThread(codexBin, current.parentThreadId, 1);
    rootId = current.sessionId || current.id;
  }
  return { thread, rootId, agentPath: agentPathFromThread(thread) };
}

function managedPaneIds(state) {
  const result = new Set();
  for (const root of Object.values(state.roots)) {
    for (const agent of Object.values(root.agents || {})) {
      if (agent.paneId) result.add(agent.paneId);
    }
  }
  return result;
}

function reconcileState(state, snapshot) {
  const panes = new Map((snapshot?.panes || []).map((pane) => [pane.pane_id, pane]));
  for (const root of Object.values(state.roots)) {
    root.agents ||= {};
    if (root.paneId && !panes.has(root.paneId)) root.paneId = null;
    for (const agent of Object.values(root.agents)) {
      if (agent.paneId && !panes.has(agent.paneId)) agent.paneId = null;
    }
  }
  return panes;
}

function chooseRootPane(snapshot, cwd, state, rootId, preferredPaneId) {
  const managed = managedPaneIds(state);
  const panes = snapshot?.panes || [];
  const isCodexPane = (pane) => {
    if (managed.has(pane.pane_id)) return false;
    return pane.agent === 'codex' || pane.display_agent === 'codex';
  };
  const exact = panes.find((pane) => isCodexPane(pane)
    && pane.agent_session?.source === 'herdr:codex'
    && pane.agent_session.agent === 'codex'
    && pane.agent_session?.kind === 'id'
    && pane.agent_session.value === rootId);
  if (exact) return exact;

  const candidates = panes.filter((pane) => isCodexPane(pane)
    && cwd && (pane.foreground_cwd || pane.cwd) === cwd);
  const preferred = candidates.find((pane) => pane.pane_id === preferredPaneId);
  if (preferred) return preferred;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((pane) => pane.pane_id === snapshot?.focused_pane_id) || null;
}

function ensureRoot(state, rootId, snapshot, cwd, preferredPaneId) {
  const root = (state.roots[rootId] ||= { paneId: null, tabId: null, cwd, agents: {} });
  root.agents ||= {};
  const panes = reconcileState(state, snapshot);
  let pane = root.paneId ? panes.get(root.paneId) : null;
  const selected = chooseRootPane(snapshot, cwd, state, rootId, preferredPaneId);
  const exact = selected?.agent_session?.source === 'herdr:codex'
    && selected.agent_session.agent === 'codex'
    && selected.agent_session.kind === 'id'
    && selected.agent_session.value === rootId;
  if (exact || !pane || (cwd && (pane.foreground_cwd || pane.cwd) !== cwd)) {
    pane = selected;
    if (!pane) {
      root.paneId = null;
      root.tabId = null;
    }
  }
  if (pane) {
    root.paneId = pane.pane_id;
    root.tabId = pane.tab_id;
    root.cwd = cwd || pane.foreground_cwd || pane.cwd || root.cwd;
  }
  return root;
}

function ratioUpdates(root, managedIds) {
  const updates = [];
  const visit = (node, nodePath) => {
    if (!node || node.type === 'pane') return managedIds.has(node?.pane_id) ? 1 : 0;
    const firstCount = visit(node.first, [...nodePath, false]);
    const secondCount = visit(node.second, [...nodePath, true]);
    if (node.direction === 'down' && firstCount > 0 && secondCount > 0) {
      const ratio = firstCount / (firstCount + secondCount);
      if (Math.abs(Number(node.ratio) - ratio) > 0.005) updates.push({ path: nodePath, ratio });
    }
    return firstCount + secondCount;
  };
  visit(root, []);
  return updates;
}

async function rebalanceRoot(socketPath, root) {
  if (!root?.paneId) return;
  const managed = new Set(Object.values(root.agents || {}).map((agent) => agent.paneId).filter(Boolean));
  if (managed.size < 2) return;
  const exported = await herdrRequest(socketPath, 'layout.export', { pane_id: root.paneId });
  for (const update of ratioUpdates(exported.layout.root, managed)) {
    await herdrRequest(socketPath, 'layout.set_split_ratio', {
      tab_id: exported.layout.tab_id,
      path: update.path,
      ratio: update.ratio,
    });
  }
}

async function openAgentPane(context, state, rootId, agentId, agentPath, cwd, snapshot) {
  const root = ensureRoot(state, rootId, snapshot, cwd, context.rootPaneId);
  if (!root.paneId) throw new Error(`could not identify the root Codex pane for ${rootId}`);
  const livePanes = new Map((snapshot.panes || []).map((pane) => [pane.pane_id, pane]));
  const agent = (root.agents[agentId] ||= {
    agentPath,
    paneId: null,
    generation: 0,
    order: 0,
  });
  agent.agentPath = agentPath || agent.agentPath;
  agent.generation = (agent.generation || 0) + 1;
  agent.closeAfter = null;
  if (agent.paneId && livePanes.has(agent.paneId)) return agent.paneId;
  agent.paneId = null;
  agent.order = state.nextOrder++;

  const siblings = Object.entries(root.agents)
    .filter(([id, item]) => id !== agentId && item.paneId && livePanes.get(item.paneId)?.tab_id === root.tabId)
    .sort((left, right) => left[1].order - right[1].order);
  const targetPaneId = siblings.at(-1)?.[1].paneId || root.paneId;
  const direction = siblings.length > 0 ? 'down' : 'right';
  const result = await herdrRequest(context.socketPath, 'plugin.pane.open', {
    plugin_id: PLUGIN_ID,
    entrypoint: PANE_ENTRYPOINT,
    placement: 'split',
    target_pane_id: targetPaneId,
    direction,
    focus: false,
    env: {
      HERDR_CODEX_AGENT_ID: agentId,
      HERDR_CODEX_BIN: context.codexBin,
    },
  });
  agent.paneId = result.plugin_pane.pane.pane_id;
  try { await rebalanceRoot(context.socketPath, root); }
  catch (error) { appendLog(context.stateDir, `rebalance after open failed: ${error.message}`); }
  return agent.paneId;
}

async function recordRootSession(context, input) {
  await withState(context.stateDir, async (state) => {
    const snapshot = (await herdrRequest(context.socketPath, 'session.snapshot')).snapshot;
    const root = ensureRoot(state, input.session_id, snapshot, input.cwd, context.rootPaneId);
    if (!root.paneId) throw new Error(`could not identify focused pane for root ${input.session_id}`);
  });
}

async function startAgent(context, input) {
  const identity = await threadIdentity(context.codexBin, input.agent_id);
  await withState(context.stateDir, async (state) => {
    const snapshot = (await herdrRequest(context.socketPath, 'session.snapshot')).snapshot;
    return openAgentPane(
      context,
      state,
      identity.rootId,
      input.agent_id,
      identity.agentPath,
      input.cwd,
      snapshot,
    );
  });
}

async function findAgentForTarget(context, state, rootId, target) {
  const root = state.roots[rootId];
  if (!root) return null;
  if (root.agents[target]) return { agentId: target, agent: root.agents[target] };
  const matches = Object.entries(root.agents).filter(([agentId, agent]) =>
    agent.agentPath === target
      || agent.agentPath?.split('/').at(-1) === target
      || (UUID_RE.test(target) && agentId.startsWith(target)));
  if (matches.length === 1) return { agentId: matches[0][0], agent: matches[0][1] };

  let cursor = null;
  do {
    const result = await codexRpc(context.codexBin, 'thread/list', {
      cursor,
      limit: 100,
      ancestorThreadId: rootId,
    });
    const candidates = result.data.filter((thread) => {
      const agentPath = agentPathFromThread(thread);
      return thread.id === target || thread.id.startsWith(target)
        || agentPath === target || agentPath?.split('/').at(-1) === target;
    });
    if (candidates.length === 1) {
      const thread = candidates[0];
      return {
        agentId: thread.id,
        agent: root.agents[thread.id] ||= {
          agentPath: agentPathFromThread(thread),
          paneId: null,
          generation: 0,
          order: 0,
        },
      };
    }
    cursor = result.nextCursor;
  } while (cursor);
  return null;
}

function reactivationTarget(input) {
  const toolName = input.tool_name || '';
  if (toolName.endsWith('followup_task')) return input.tool_input?.target;
  if (toolName.endsWith('resume_agent')) return input.tool_input?.id;
  return null;
}

async function reactivateAgent(context, input) {
  const target = reactivationTarget(input);
  if (typeof target !== 'string' || !target) return;

  let identity;
  try { identity = await threadIdentity(context.codexBin, input.session_id); }
  catch { identity = { rootId: input.session_id }; }

  await withState(context.stateDir, async (state) => {
    const snapshot = (await herdrRequest(context.socketPath, 'session.snapshot')).snapshot;
    reconcileState(state, snapshot);
    let rootId = state.roots[identity.rootId] ? identity.rootId : null;
    if (!rootId) {
      rootId = Object.entries(state.roots)
        .find(([, root]) => root.agents?.[input.session_id])?.[0] || identity.rootId;
    }
    ensureRoot(state, rootId, snapshot, input.cwd, context.rootPaneId);
    const resolved = await findAgentForTarget(context, state, rootId, target);
    if (!resolved) throw new Error(`could not resolve reactivated agent ${target}`);
    await openAgentPane(
      context,
      state,
      rootId,
      resolved.agentId,
      resolved.agent.agentPath,
      input.cwd,
      snapshot,
    );
  });
}

function shouldCloseAgent(agent, generation) {
  return Boolean(agent && agent.generation === generation && agent.closeAfter);
}

async function stopAgent(context, input) {
  const generation = await withState(context.stateDir, async (state) => {
    for (const root of Object.values(state.roots)) {
      const agent = root.agents?.[input.agent_id];
      if (!agent) continue;
      agent.generation = (agent.generation || 0) + 1;
      agent.closeAfter = Date.now() + CLOSE_DELAY_MS;
      return agent.generation;
    }
    return null;
  });
  if (generation === null) return;

  await sleep(CLOSE_DELAY_MS);
  await withState(context.stateDir, async (state) => {
    const entry = Object.values(state.roots)
      .map((root) => ({ root, agent: root.agents?.[input.agent_id] }))
      .find(({ agent }) => shouldCloseAgent(agent, generation));
    if (!entry) return;
    const snapshot = (await herdrRequest(context.socketPath, 'session.snapshot')).snapshot;
    const panes = reconcileState(state, snapshot);
    const paneId = entry.agent.paneId;
    entry.agent.closeAfter = null;
    if (paneId && panes.has(paneId)) {
      try { await herdrRequest(context.socketPath, 'plugin.pane.close', { pane_id: paneId }); }
      catch (error) { appendLog(context.stateDir, `close ${paneId} failed: ${error.message}`); }
    }
    entry.agent.paneId = null;
    try { await rebalanceRoot(context.socketPath, entry.root); }
    catch (error) { appendLog(context.stateDir, `rebalance after close failed: ${error.message}`); }
  });
}

function isEmbeddedCodex(env = process.env) {
  return env.HERDR_ENV === '1'
    && Boolean(env.HERDR_PANE_ID)
    && Boolean(env.HERDR_CODEX_AGENT_ID)
    && env.HERDR_CODEX_SUBAGENT_DAEMON !== '1';
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.trim() ? JSON.parse(input) : {};
}

async function hook(stateDir, socketPath, codexBin) {
  const context = {
    stateDir,
    socketPath,
    codexBin,
    rootPaneId: process.env.HERDR_PANE_ID,
  };
  try {
    const input = await readStdin();
    if (isEmbeddedCodex()) {
      appendLog(stateDir, `skipped embedded Codex session ${input.session_id || 'unknown'}`);
      return;
    }
    switch (input.hook_event_name) {
      case 'SessionStart':
        await recordRootSession(context, input);
        break;
      case 'SubagentStart':
        await startAgent(context, input);
        break;
      case 'SubagentStop':
        await stopAgent(context, input);
        break;
      case 'PostToolUse':
        await reactivateAgent(context, input);
        break;
    }
  } catch (error) {
    appendLog(stateDir, `hook failed: ${error.stack || error}`);
  }
}

function view() {
  const agentId = process.env.HERDR_CODEX_AGENT_ID;
  const codexBin = process.env.HERDR_CODEX_BIN || findExecutable('codex');
  if (!agentId) throw new Error('HERDR_CODEX_AGENT_ID is missing');
  const result = spawnSync(codexBin, ['resume', '--remote', 'unix://', agentId], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

async function prepareUninstall() {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!stateDir) throw new Error('prepare-uninstall must run as a Herdr plugin action');

  const hooksPath = path.join(codexHome(), 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    const document = stripOwnedHooks(readHooksFile(hooksPath));
    atomicWriteJson(hooksPath, document);
  }

  if (socketPath) {
    let snapshot;
    try { snapshot = (await herdrRequest(socketPath, 'session.snapshot')).snapshot; }
    catch {}
    const live = new Set((snapshot?.panes || []).map((pane) => pane.pane_id));
    await withState(stateDir, async (state) => {
      for (const paneId of managedPaneIds(state)) {
        if (!live.has(paneId)) continue;
        try { await herdrRequest(socketPath, 'plugin.pane.close', { pane_id: paneId }); }
        catch (error) { appendLog(stateDir, `uninstall close ${paneId} failed: ${error.message}`); }
      }
      Object.assign(state, defaultState());
    });
  }
  fs.rmSync(path.join(codexHome(), 'herdr-plugins', PLUGIN_ID), {
    recursive: true,
    force: true,
  });
  process.stdout.write(`Removed ${PLUGIN_ID} Codex hooks and managed panes.\n`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'setup') return setup();
  if (command === 'hook') {
    let args = process.argv.slice(3, 6);
    if (args.length === 0) {
      const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'runtime.json'), 'utf8'));
      args = [config.stateDir, config.socketPath, config.codexBin];
    }
    return hook(...args);
  }
  if (command === 'view') return view();
  if (command === 'prepare-uninstall') return prepareUninstall();
  throw new Error('usage: node index.cjs <setup|hook|view|prepare-uninstall>');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CLOSE_DELAY_MS,
  HOOK_MARKER,
  agentPathFromThread,
  buildHookCommand,
  chooseRootPane,
  defaultState,
  isEmbeddedCodex,
  mergeOwnedHooks,
  reactivationTarget,
  ratioUpdates,
  reconcileState,
  shellQuote,
  shouldCloseAgent,
  stripOwnedHooks,
};
