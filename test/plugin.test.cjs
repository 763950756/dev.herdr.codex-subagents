'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  HOOK_MARKER,
  agentPathFromThread,
  buildHookCommand,
  chooseRootPane,
  defaultState,
  isEmbeddedCodex,
  mergeOwnedHooks,
  ratioUpdates,
  reactivationTarget,
  reconcileState,
  shellQuote,
  shouldCloseAgent,
  stripOwnedHooks,
} = require('../index.cjs');

const ownedHandlers = (document, event) => (document.hooks[event] || [])
  .flatMap((group) => group.hooks || [])
  .filter((handler) => handler.command?.includes(HOOK_MARKER));

test('hook command uses a portable runtime path', () => {
  const command = buildHookCommand();
  assert.match(command, /\$\{CODEX_HOME:-\$HOME\/\.codex\}/);
  assert.doesNotMatch(command, /\/Users\/|\/Downloads\/|index\.cjs' hook/);
});

test('Codex hooks merge idempotently and uninstall preserves third-party hooks', () => {
  const thirdParty = { type: 'command', command: '/opt/tools/report-session', timeout: 3 };
  const document = {
    custom: true,
    hooks: {
      SessionStart: [
        { matcher: 'startup', hooks: [thirdParty] },
        { hooks: [{ type: 'command', command: `${HOOK_MARKER}=1 old` }] },
      ],
    },
  };
  const command = `${HOOK_MARKER}=1 exec node plugin.cjs`;

  mergeOwnedHooks(document, command);
  mergeOwnedHooks(document, command);

  for (const event of ['SessionStart', 'SubagentStart', 'SubagentStop', 'PostToolUse']) {
    assert.equal(ownedHandlers(document, event).length, 1);
  }
  assert.equal(document.hooks.SessionStart[0].hooks[0], thirdParty);
  const postGroup = document.hooks.PostToolUse.find((group) =>
    group.hooks.some((handler) => handler.command === command));
  assert.equal(postGroup.matcher, '(followup_task|resume_agent)$');
  assert.equal(document.hooks.SubagentStop.at(-1).hooks[0].async, true);
  assert.equal(document.hooks.SubagentStop.at(-1).hooks[0].timeout, 30);

  stripOwnedHooks(document);
  assert.deepEqual(document, {
    custom: true,
    hooks: { SessionStart: [{ matcher: 'startup', hooks: [thirdParty] }] },
  });
});

test('shellQuote survives spaces, quotes, dollars, and newlines', () => {
  const value = "a b'c$d\nlast";
  const output = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], {
    encoding: 'utf8',
  });
  assert.equal(output, value);
});

test('agent path accepts Codex wire format and compatibility format', () => {
  assert.equal(agentPathFromThread({
    source: { subagent: { thread_spawn: { agent_path: '/root/reviewer' } } },
  }), '/root/reviewer');
  assert.equal(agentPathFromThread({
    source: { subAgent: { thread_spawn: { agent_path: '/root/worker' } } },
  }), '/root/worker');
  assert.equal(agentPathFromThread({ source: 'cli' }), null);
});

test('root pane selection isolates Codex windows by cwd', () => {
  const state = defaultState();
  state.roots.root = {
    paneId: null,
    agents: { child: { paneId: 'managed' } },
  };
  const snapshot = {
    focused_pane_id: 'new',
    panes: [
      { pane_id: 'old', tab_id: 'tab-1', agent: 'codex', foreground_cwd: '/old' },
      { pane_id: 'new', tab_id: 'tab-2', agent: 'codex', foreground_cwd: '/new' },
      { pane_id: 'managed', tab_id: 'tab-1', agent: 'codex', foreground_cwd: '/old' },
    ],
  };

  assert.equal(chooseRootPane(snapshot, '/old', state, 'root-old').pane_id, 'old');
  assert.equal(chooseRootPane(snapshot, '/old', state, 'root-old', 'new').pane_id, 'old');
  assert.equal(chooseRootPane(snapshot, '/old', state, 'root-old', 'managed').pane_id, 'old');

  snapshot.panes.push({ pane_id: 'old-2', tab_id: 'tab-3', agent: 'codex', cwd: '/old' });
  snapshot.focused_pane_id = 'old-2';
  assert.equal(chooseRootPane(snapshot, '/old', state, 'root-old').pane_id, 'old-2');
});

test('root pane selection prefers an exact Codex session', () => {
  const state = defaultState();
  const snapshot = {
    focused_pane_id: 'new',
    panes: [
      {
        pane_id: 'old',
        agent: 'codex',
        foreground_cwd: '/old',
        agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: 'root-old' },
      },
      { pane_id: 'new', agent: 'codex', foreground_cwd: '/new' },
    ],
  };

  assert.equal(chooseRootPane(snapshot, '/new', state, 'root-old', 'new').pane_id, 'old');
});

test('state reconciliation clears only panes missing from the snapshot', () => {
  const state = {
    version: 1,
    nextOrder: 3,
    roots: {
      root: {
        paneId: 'main',
        agents: {
          live: { paneId: 'child-1' },
          stale: { paneId: 'child-2' },
        },
      },
    },
  };
  const panes = reconcileState(state, {
    panes: [{ pane_id: 'main' }, { pane_id: 'child-1' }],
  });

  assert.deepEqual([...panes.keys()], ['main', 'child-1']);
  assert.equal(state.roots.root.paneId, 'main');
  assert.equal(state.roots.root.agents.live.paneId, 'child-1');
  assert.equal(state.roots.root.agents.stale.paneId, null);
});

test('nested down splits rebalance managed panes to equal heights', () => {
  const layout = {
    type: 'split',
    direction: 'right',
    ratio: 0.5,
    first: { type: 'pane', pane_id: 'main' },
    second: {
      type: 'split',
      direction: 'down',
      ratio: 0.7,
      first: { type: 'pane', pane_id: 'a' },
      second: {
        type: 'split',
        direction: 'down',
        ratio: 0.8,
        first: { type: 'pane', pane_id: 'b' },
        second: { type: 'pane', pane_id: 'c' },
      },
    },
  };

  assert.deepEqual(ratioUpdates(layout, new Set(['a', 'b', 'c'])), [
    { path: [true, true], ratio: 0.5 },
    { path: [true], ratio: 1 / 3 },
  ]);
});

test('reactivation names and close generations reject stale timers', () => {
  assert.equal(reactivationTarget({
    tool_name: 'collaborationfollowup_task',
    tool_input: { target: '/root/reviewer' },
  }), '/root/reviewer');
  assert.equal(reactivationTarget({
    tool_name: 'multi_agent_v1resume_agent',
    tool_input: { id: 'agent-id' },
  }), 'agent-id');
  assert.equal(reactivationTarget({ tool_name: 'send_message', tool_input: {} }), null);

  const agent = { generation: 4, closeAfter: Date.now() + 10_000 };
  assert.equal(shouldCloseAgent(agent, 4), true);
  agent.generation += 1;
  assert.equal(shouldCloseAgent(agent, 4), false);
  agent.closeAfter = null;
  assert.equal(shouldCloseAgent(agent, 5), false);
});

test('embedded Codex detection excludes the plugin-managed daemon', () => {
  assert.equal(isEmbeddedCodex({ HERDR_ENV: '1', HERDR_PANE_ID: 'pane-1' }), false);
  assert.equal(isEmbeddedCodex({
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_CODEX_AGENT_ID: 'agent-1',
  }), true);
  assert.equal(isEmbeddedCodex({
    HERDR_ENV: '1',
    HERDR_PANE_ID: 'pane-1',
    HERDR_CODEX_AGENT_ID: 'agent-1',
    HERDR_CODEX_SUBAGENT_DAEMON: '1',
  }), false);
  assert.equal(isEmbeddedCodex({}), false);
});
