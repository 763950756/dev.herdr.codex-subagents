# Codex Subagent Splits

在 Herdr 中自动显示 Codex CLI 子代理。主代理保留在左侧；第一个子代理在右侧分屏，更多子代理继续向下等高分屏，且不会抢占焦点。

子代理结束后，分屏会等待 10 秒再关闭。等待期间重新激活会取消关闭；已关闭的子代理再次激活时会重新创建分屏。

## 要求

- macOS
- Herdr 0.8.2 或更高版本
- Codex CLI 0.153.2 或更高版本
- Node.js 18 或更高版本

## 安装

在插件目录中运行：

```sh
herdr plugin link "$(pwd)"
```

然后重启 Herdr。首次启动 Codex 时，确认信任插件安装的 hooks。

请使用默认方式启动 Codex：

```sh
codex
```

使用会退回 embedded app-server 的 profile 或不可重放 CLI 覆盖时，插件无法实时附加子代理，这类启动方式暂不支持。

## 限制

- 同一用户环境只支持一个活动的 Herdr server；最后启动的实例会接管 Codex hooks。
- 插件只管理启动后收到事件的子代理，不恢复安装前已在运行的子代理 pane。

## 卸载

先清理插件安装的 Codex hooks：

```sh
herdr plugin action invoke dev.herdr.codex-subagents.prepare-uninstall
```

再按安装方式解除本地链接或卸载插件：

```sh
herdr plugin unlink dev.herdr.codex-subagents
# 或
herdr plugin uninstall dev.herdr.codex-subagents
```

## 测试

```sh
node --test
```
