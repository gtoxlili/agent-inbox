# agent-inbox

[![test](https://github.com/gtoxlili/agent-inbox/actions/workflows/test.yml/badge.svg)](https://github.com/gtoxlili/agent-inbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

每个会话一个收件箱，Claude Code、Codex 和 OpenCode v2 都能用。跑在 agent shell 里的程序投一条消息，agent 在下一次工具调用或收到新提问时就能看到，不经过 stdout 和 stderr。

```sh
agent-inbox post "deploy.sh: staging is locked until 14:00"
echo "multi-line message" | agent-inbox post
```

命令把输出重定向了，用 `$(…)` 捕获了，或跑在会丢弃工具输出的 code mode 里，消息照样到达。空闲会话等到下一次收到提问才收信；发信本身不会开启新一轮运行。

## 安装

需要 zsh 和 jq，跑在 macOS 或 Linux 上。Claude Code 和 OpenCode 会把插件自带的发送器提供给 agent shell。Codex 用 npm 安装一个私有发送器，再配一条只在 Codex 里生效的 shell 环境设置，做法在下面。全程没有全局可执行文件、运行时 npm 依赖，也没有后台服务。

在 Claude Code 2.1.296、Codex 0.162.1 和 OpenCode 2.0.28 上测试过。Codex 适配器要求 shell 子进程里有 `CODEX_SESSION_ID`；OpenCode 要求 v2 插件 API 和 `OPENCODE_SESSION_ID`。

### Claude Code

```text
/plugin install agent-inbox --marketplace gtoxlili/agent-inbox
```

本地检出的话：

```sh
claude --plugin-dir /absolute/path/to/agent-inbox
```

Claude Code 会自动把已启用插件的 `bin/` 加进 Bash 工具的 `PATH`。

手动安装 hook 时，把 [`hooks/hooks.json`](hooks/hooks.json) 合并进 `~/.claude/settings.json`，把 `"${CLAUDE_PLUGIN_ROOT}"/bin/agent-inbox` 换成带引号的可执行文件绝对路径。启用 hook 后要开新会话。

### Codex

在 Codex 里用，需要私有发送器和 hook 插件，外加一条只需配置一次的 PATH，写在 `${CODEX_HOME:-$HOME/.codex}/config.toml` 里。装插件不会顺带装上发送器，这条 PATH 也不会自动写入。hook 不改 Codex 的配置；开始或恢复会话之前，先把下面的步骤走完。

先把发送器装进 `CODEX_HOME` 下的一个私有目录，再装 hook 插件：

```sh
agent_inbox_prefix="${CODEX_HOME:-$HOME/.codex}/tools/agent-inbox"
npm install --prefix "$agent_inbox_prefix" --no-save --package-lock=false github:gtoxlili/agent-inbox
codex plugin marketplace add gtoxlili/agent-inbox
codex plugin add agent-inbox@agent-inbox
```

生成只在 Codex 里生效的 PATH 设置：

```sh
jq -nr --arg bin "$agent_inbox_prefix/node_modules/.bin" --arg current "$PATH" \
  '"[shell_environment_policy.set]\nPATH = \(($bin + ":" + $current) | tojson)"'
```

把打印出来的表合并进 `${CODEX_HOME:-$HOME/.codex}/config.toml`，表里已有的键要保留。PATH 的值按字面处理，Codex 不展开里面的 `~` 和 `$PATH`。上面的命令把私有目录和你当前的 PATH 拼成一个完整的绝对值记下来，换了环境就重新生成。

Codex 把这条设置当作环境变量传给 shell 子进程，命令文本保持原样。不要把私有目录加进 shell profile 或全局 PATH。普通终端找不到发送器。

在 `/hooks` 里检查并信任插件的四个生命周期 hook，然后开始或恢复会话。Codex 0.162.1 不会自动暴露插件的可执行文件。私有 npm 目录的路径在升级后保持不变，插件只负责会话队列的初始化、排空和关闭，不注册 `PreToolUse` hook，也不改 shell 命令。

本地检出的话，marketplace 命令里用检出目录的绝对路径代替 `gtoxlili/agent-inbox`，生成 PATH 设置时把它的 `bin/` 传给 `--arg bin`。

升级时重新跑一遍私有 npm 安装命令，并更新插件 marketplace 和插件。卸载时先移除 hook 插件，运行 `npm uninstall --prefix "${CODEX_HOME:-$HOME/.codex}/tools/agent-inbox" --no-save --package-lock=false agent-inbox`，再从 Codex 的 PATH 设置里删掉私有目录。

手动安装时，把 [`hooks/hooks-codex.json`](hooks/hooks-codex.json) 合并进 `~/.codex/hooks.json`，把 `${PLUGIN_ROOT}` 换成检出目录的绝对路径，引号保留。检出目录不要删。插件和手动 hook 装其中一种即可；Codex 会运行所有匹配的 hook 来源。

### OpenCode v2

用户级安装：

```sh
opencode plugin add github:gtoxlili/agent-inbox
```

本地检出的话，把目录加进 `opencode.json` 或 `opencode.jsonc` 的 `plugins`：

```json
{
  "plugins": [
    { "package": "/absolute/path/to/agent-inbox" }
  ]
}
```

本地检出的目录不要删。OpenCode 加载 [`index.js`](index.js)，由它调用 `bin/agent-inbox` 操作队列，并通过 `shell.create.before` 把 `bin/` 加进 shell 子进程的 `PATH`。启用插件后重启 OpenCode，已有会话在再次收到提问时照常工作。不支持 OpenCode v1。

## 发送器行为

`post` 把参数用空格拼成消息，不带参数时改读 stdin。在已启用的会话里，空消息会被忽略。

| 退出码 | 含义 |
|---|---|
| 0 | 消息已入队，或空消息被忽略 |
| 1 | 没有启用中的会话队列，或写入失败 |
| 2 | 命令或适配器参数不合法 |

也需要在 agent 会话之外运行的辅助脚本，可以回退到 stderr：

```sh
if command -v agent-inbox >/dev/null 2>&1; then
  agent-inbox post "$msg" 2>/dev/null || echo "$msg" >&2
else
  echo "$msg" >&2
fi
```

普通终端找不到私有发送器。在启用的会话之外用绝对路径调用，或队列关闭后再调用，`post` 都返回 1，不创建队列。

显式设置 `AGENT_INBOX` 可以指定队列；否则 `post` 用 `OPENCODE_SESSION_ID` 或 `CODEX_SESSION_ID`。工作目录不参与会话识别，同一检出下的两个会话各自独立，切换目录不影响路由。

## 投递与生命周期

三个适配器共用 [`bin/agent-inbox`](bin/agent-inbox) 里的同一套文件队列。发送器先把每条消息写进一个私有临时文件，再靠原子重命名发布到队列里。队列目录和消息文件仅当前用户可访问。

| 客户端 | 会话标识 | 投递边界 | 清理 |
|---|---|---|---|
| Claude Code | `SessionStart` 通过 `CLAUDE_ENV_FILE` 导出 `AGENT_INBOX` | `PostToolBatch` 和 `UserPromptSubmit` 返回 `additionalContext` | `SessionEnd` |
| Codex | 原生 `CODEX_SESSION_ID`，与 hook 的 `session_id` 匹配 | `PostToolUse` 和 `UserPromptSubmit` 返回 `additionalContext` | `SessionEnd` |
| OpenCode v2 | 原生 `OPENCODE_SESSION_ID` | 在 `tool.execute.after` 和提示词准入时转入 `session.synthetic` | 会话删除 |

Claude Code 和 Codex 的队列放在 `${TMPDIR:-/tmp}/agent-inbox-<uid>/<session_id>/`，该目录在 Codex 默认的 `workspace-write` 沙箱下可写。OpenCode 的队列放在 `${XDG_STATE_HOME:-$HOME/.local/state}/agent-inbox/<session_id>/`，暂停的会话跨重启也不丢信。只读或更严格的自定义沙箱，需要放行对相应队列目录的写入。

Claude Code 和 Codex 读文件前先认领，并发排空不会把同一个文件投递两次。两者的 hook 协议没有投递回执，排空途中崩溃可能丢失已认领的消息。OpenCode 把每个文件保留到原生收件箱确认已持久接收，靠一个稳定的消息 ID 保证重试不会重复投递。原生准入会把消息留在会话历史里，`resume: false` 则不唤醒空闲会话。插件不修改组装好的模型请求，也不修改工具结果。

Claude Code 的子 agent 和 Codex 的子 agent 共用根会话的队列，谁先到投递边界，消息就归谁。OpenCode 的子会话有自己的 ID 和队列。

初始化队列时会清理七天未动的队列，清理前会先刷新当前队列。队列一旦关闭，写入方就无法重建。OpenCode 的会话跨重启保留，文件队列在暂停期间也能收到后台来信。

原生 API 的文档见 [Codex hooks](https://developers.openai.com/codex/hooks) 和 [OpenCode v2 plugins](https://dev.opencode.ai/v2/docs/build/plugins/)。

## 开发

```sh
npm test
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json

# 用真实安装的 CLI 和本地脚本模型，不产生付费 API 调用。
AGENT_INBOX_NATIVE_TEST=1 npm test
```

原生测试把 Codex 插件和私有发送器装进一个隔离的 Codex home，并配置其 shell 环境策略。在同样的启动环境里，普通 shell 必须找不到发送器，Codex 却必须能用它完成投递。Claude Code 和 OpenCode 用自带的发送器。三个客户端都从子 shell 调用裸命令，stdout 和 stderr 全部丢弃。Codex 必须原样显示不带 PATH 前缀的原始命令；另一项测试在 `workspace-write` 沙箱之外尝试写入，必须保持被拒。Codex 和 OpenCode 的请求必须逐字保留此前的消息前缀；Claude Code 的传输层缓存标记变化时，投递文本必须原样保留。

## 许可

[MIT](LICENSE)
