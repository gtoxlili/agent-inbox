# agent-inbox

[![test](https://github.com/gtoxlili/agent-inbox/actions/workflows/test.yml/badge.svg)](https://github.com/gtoxlili/agent-inbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

A per-session inbox for Claude Code, Codex and OpenCode v2. Programs running in an agent's shell can post messages that reach the agent at the next tool or prompt boundary, independently of stdout and stderr.

```sh
agent-inbox post "deploy.sh: staging is locked until 14:00"
echo "multi-line message" | agent-inbox post
```

Messages still arrive when the command redirects its output, captures it with `$(…)`, or runs through code mode that discards tool output. An idle session receives mail at its next prompt; posting does not start a turn.

## Installation

Requires zsh and jq, on macOS or Linux. Claude Code and OpenCode expose the bundled sender within agent shells. Codex uses npm to install a private sender and a Codex-only shell environment setting, as described below. No global executable, runtime npm dependencies or background service are required.

Tested with Claude Code 2.1.296, Codex 0.162.1 and OpenCode 2.0.28. The Codex adapter requires `CODEX_SESSION_ID` in shell children; OpenCode requires its v2 plugin API and `OPENCODE_SESSION_ID`.

### Claude Code

```text
/plugin install agent-inbox --marketplace gtoxlili/agent-inbox
```

For a local checkout:

```sh
claude --plugin-dir /absolute/path/to/agent-inbox
```

Claude Code automatically adds the enabled plugin's `bin/` to the Bash tool's `PATH`.

For manual hook installation, merge [`hooks/hooks.json`](hooks/hooks.json) into `~/.claude/settings.json`, replacing `"${CLAUDE_PLUGIN_ROOT}"/bin/agent-inbox` with the quoted absolute path to the executable. Start a new session after enabling the hooks.

### Codex

Codex setup requires the private sender, the hook plugin, and a one-time PATH setting in `${CODEX_HOME:-$HOME/.codex}/config.toml`. Installing the plugin does not install the private sender or write this setting. The hooks do not edit Codex configuration; complete the steps below before starting or resuming a session.

Install the sender into a private directory under `CODEX_HOME`, then install the hook plugin:

```sh
agent_inbox_prefix="${CODEX_HOME:-$HOME/.codex}/tools/agent-inbox"
npm install --prefix "$agent_inbox_prefix" --no-save --package-lock=false github:gtoxlili/agent-inbox
codex plugin marketplace add gtoxlili/agent-inbox
codex plugin add agent-inbox@agent-inbox
```

Generate the Codex-only PATH setting:

```sh
jq -nr --arg bin "$agent_inbox_prefix/node_modules/.bin" --arg current "$PATH" \
  '"[shell_environment_policy.set]\nPATH = \(($bin + ":" + $current) | tojson)"'
```

Merge the printed table into `${CODEX_HOME:-$HOME/.codex}/config.toml`, preserving any existing keys in that table. The PATH value is literal. Codex does not expand `~` or `$PATH` inside it. The command above records the private directory plus your current PATH as a complete absolute value. Regenerate it if you change that environment.

Codex passes this setting as an environment variable to its shell children, keeping command text unchanged. Do not add the private directory to your shell profile or global PATH. Ordinary terminals cannot find the sender.

Review and trust the plugin's four lifecycle hooks through `/hooks`, then start or resume a session. Codex 0.162.1 does not expose plugin executables automatically. The private npm directory stays stable across updates; the plugin only initializes, drains and closes session queues. It does not register a `PreToolUse` hook or modify shell commands.

For a local checkout, use its absolute directory instead of `gtoxlili/agent-inbox` in the marketplace command, and use its `bin/` as `--arg bin` when generating the Codex-only PATH setting.

When upgrading, run the private npm install command again and update the plugin marketplace and plugin. To uninstall, remove the hook plugin, run `npm uninstall --prefix "${CODEX_HOME:-$HOME/.codex}/tools/agent-inbox" --no-save --package-lock=false agent-inbox`, and remove its private directory from the Codex PATH setting.

For manual installation, merge [`hooks/hooks-codex.json`](hooks/hooks-codex.json) into `~/.codex/hooks.json`, replacing `${PLUGIN_ROOT}` with the absolute checkout directory and keeping the surrounding quotes. Keep the checkout intact. Install either the plugin or manual hooks once; Codex runs all matching hook sources.

### OpenCode v2

Install at user scope:

```sh
opencode plugin add github:gtoxlili/agent-inbox
```

For a local checkout, add its directory to `plugins` in `opencode.json` or `opencode.jsonc`:

```json
{
  "plugins": [
    { "package": "/absolute/path/to/agent-inbox" }
  ]
}
```

Keep a local checkout intact. OpenCode loads [`index.js`](index.js), which calls `bin/agent-inbox` for queue operations and uses `shell.create.before` to add its `bin/` to shell subprocesses' `PATH`. Restart OpenCode after enabling the plugin. Existing sessions work when prompted again. OpenCode v1 is not supported.

## Sender behaviour

`post` reads its arguments joined by spaces, or stdin when no arguments are supplied. Empty messages inside an enabled session are ignored.

| Exit status | Meaning |
|---|---|
| 0 | Message queued, or empty message ignored |
| 1 | No enabled session queue, or a write failed |
| 2 | Invalid command or adapter arguments |

Helpers that also run outside agent sessions can fall back to stderr:

```sh
if command -v agent-inbox >/dev/null 2>&1; then
  agent-inbox post "$msg" 2>/dev/null || echo "$msg" >&2
else
  echo "$msg" >&2
fi
```

Ordinary terminals cannot find the private sender. If invoked by absolute path outside an enabled session, or after its session queue has closed, `post` returns 1 without creating a queue.

An explicit `AGENT_INBOX` selects a queue. Otherwise, `post` uses `OPENCODE_SESSION_ID` or `CODEX_SESSION_ID`. Working directories do not identify sessions, so two sessions in the same checkout remain separate and changing directories does not affect routing.

## Delivery and lifecycle

All adapters use the same file queue in [`bin/agent-inbox`](bin/agent-inbox). The sender writes each message to a private temporary file, then renames it into the queue atomically. Queue directories and message files are private to the current user.

| Client | Session identity | Delivery boundary | Cleanup |
|---|---|---|---|
| Claude Code | `SessionStart` exports `AGENT_INBOX` through `CLAUDE_ENV_FILE` | `PostToolBatch` and `UserPromptSubmit` return `additionalContext` | `SessionEnd` |
| Codex | Native `CODEX_SESSION_ID`, matching hook `session_id` | `PostToolUse` and `UserPromptSubmit` return `additionalContext` | `SessionEnd` |
| OpenCode v2 | Native `OPENCODE_SESSION_ID` | `tool.execute.after` and prompt admission transfer mail into `session.synthetic` | Session deletion |

Claude Code and Codex store queues in `${TMPDIR:-/tmp}/agent-inbox-<uid>/<session_id>/`. This directory is writable under Codex's default `workspace-write` sandbox. OpenCode stores queues in `${XDG_STATE_HOME:-$HOME/.local/state}/agent-inbox/<session_id>/` so paused sessions can retain mail across restarts. Read-only or stricter custom sandboxes must permit writes to the relevant queue directory.

Claude Code and Codex claim files before reading them, so concurrent drains do not deliver the same file twice. Their hook protocols provide no delivery receipt; a crash during a drain can lose the claimed messages. OpenCode keeps each file until its native inbox confirms durable admission, using a stable message ID so retries do not duplicate it. Native admission preserves the message in session history and uses `resume: false` to leave idle sessions asleep. The plugin does not modify assembled model requests or tool results.

Claude Code subagents and Codex subagents share their root session's queue. The first agent to reach a delivery boundary receives the messages. OpenCode child sessions have their own IDs and queues.

Queues untouched for seven days are collected when a queue is initialized. Current queues are refreshed before collection. A writer cannot recreate a queue after it is closed. OpenCode sessions persist across restarts, and their file queues can receive background mail while paused.

The native APIs are documented in [Codex hooks](https://developers.openai.com/codex/hooks) and [OpenCode v2 plugins](https://dev.opencode.ai/v2/docs/build/plugins/).

## Development

```sh
npm test
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json

# Real installed CLIs with a local scripted model; no paid API calls.
AGENT_INBOX_NATIVE_TEST=1 npm test
```

The native tests install the Codex plugin and private sender into an isolated Codex home and configure its shell environment policy. An ordinary shell with the same launch environment must not find the sender, while Codex must deliver mail using it. Claude Code and OpenCode use their bundled sender. All three invoke the bare command from a child shell with stdout and stderr discarded. Codex must display the original commands without PATH prefixes, and a separate attempted write outside its `workspace-write` sandbox must remain denied. Codex and OpenCode requests must retain their previous message prefix exactly; Claude Code must retain the delivered text across its transport's cache-marker changes.

## License

[MIT](LICENSE)
