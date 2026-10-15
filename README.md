# agent-inbox

[![test](https://github.com/gtoxlili/agent-inbox/actions/workflows/test.yml/badge.svg)](https://github.com/gtoxlili/agent-inbox/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A plugin for [Claude Code](https://code.claude.com), [Codex](https://github.com/openai/codex) and [opencode](https://opencode.ai) that gives each session a message queue. Any process running inside the session can post to it, and the queued messages are added to the agent's context before its next model call.

Delivery does not go through the process's stdout or stderr. A message arrives even when the agent ran the command with `2>/dev/null`, captured it with `$(…)`, or invoked it through a tool that discards child output. Typical senders are credential helpers, command wrappers and background jobs that need the agent to know why something failed.

## Installation

**Claude Code** 2.1.275 or later:

```
/plugin install agent-inbox --marketplace gtoxlili/agent-inbox
```

Earlier versions:

```
/plugin marketplace add gtoxlili/agent-inbox
/plugin install agent-inbox@agent-inbox
```

The inbox exists only in sessions started after the plugin is enabled. Requirements are zsh and jq on macOS or Linux. The plugin is tested with Claude Code 2.1.296.

To use it without the plugin system, put `bin/agent-inbox` on `PATH` and copy the entries of [`hooks/hooks.json`](hooks/hooks.json) into `~/.claude/settings.json`, replacing `"${CLAUDE_PLUGIN_ROOT}"/bin/agent-inbox` with the script's path.

**Codex**: copy the entries of [`hooks/hooks-codex.json`](hooks/hooks-codex.json) into `~/.codex/hooks.json`, replacing `"${CLAUDE_PLUGIN_ROOT}"/bin/agent-inbox` with the script's path, and put `bin/agent-inbox` on `PATH`. The repo also carries a `.codex-plugin/plugin.json`, so installing it as a Codex plugin loads the same hooks from `hooks/hooks-codex.json` (review and trust the hooks when Codex asks).

**opencode**: copy `opencode/agent-inbox.js` into `~/.config/opencode/plugins/` (or a project's `.opencode/plugins/`) and put `bin/agent-inbox` on `PATH`. The opencode side is plain JavaScript with no dependencies; `post` still goes through the zsh CLI.

## Usage

```sh
agent-inbox post "deploy.sh: staging is locked until 14:00; retrying earlier fails the same way"
echo "multi-line message" | agent-inbox post
```

| Exit status | Meaning |
|---|---|
| 0 | message queued, or the message was empty |
| 1 | not inside a session with the plugin enabled |

A sender that may also run outside an agent session, where the command is absent or exits 1, can fall back to stderr:

```sh
agent-inbox post "$msg" 2>/dev/null || echo "$msg" >&2
```

## How it works

Claude Code:

| Hook | Action |
|---|---|
| `SessionStart` | creates `$XDG_STATE_HOME/agent-inbox/<session_id>/` and exports its path as `AGENT_INBOX` to the session's Bash calls through `CLAUDE_ENV_FILE` |
| `PostToolBatch` | claims the queued messages and returns them as `additionalContext` |
| `UserPromptSubmit` | same, for messages posted after the last tool round |
| `SessionEnd` | deletes the queue; queues untouched for 7 days are removed at the next `SessionStart` |

Codex fires `PostToolUse` once per tool call instead of `PostToolBatch`, and has no `CLAUDE_ENV_FILE`, so `post` falls back to a working-directory lookup: `SessionStart` records the session's (canonicalized) cwd in `$XDG_STATE_HOME/agent-inbox/.by-cwd/`, and `post` without `AGENT_INBOX` walks its own cwd upwards until it finds a live mapping. Senders running in a directory unrelated to the session still need `AGENT_INBOX` pointed at the queue by hand.

opencode has no hook JSON at all; `opencode/agent-inbox.js` implements the same queue in-process: `shell.env` exports `AGENT_INBOX` to the session's shell calls, `tool.execute.after` appends drained messages to the tool result, and `experimental.chat.messages.transform` delivers whatever is left as a synthetic user message before the next model call. opencode keeps sessions after the window closes, so queues of sessions that were never deleted are only removed by the 7-day cleanup; a message posted to a paused session is delivered when it resumes.

Each message is one file. `post` writes a temporary file and renames it into the queue. `drain` moves every message into a private directory before reading it, so each message is delivered exactly once even when drains run concurrently.

Behaviour observed on Claude Code 2.1.296:

- `PostToolBatch` fires after every tool round, including rounds with a single call and rounds whose calls failed.
- A subagent shares its parent's `session_id` and therefore its queue. Messages go to whichever agent of the session finishes a tool round first, which in practice is the agent whose command posted them.
- An idle session receives queued messages with the next prompt.

## Compared with the built-in session socket

Claude Code 2.1.224 and later bind a per-session [inbox socket](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket), exported as `CLAUDE_CODE_MESSAGING_SOCKET`, that also accepts messages from the session's own child processes.

| | Built-in socket | agent-inbox |
|---|---|---|
| Idle session | starts a new turn | message waits for the next prompt |
| Message posted from a subagent's command | delivered to the main conversation | stays with the subagent that ran the command |
| `crossSessionInbound: hold \| refuse` | holds or drops the message | not consulted |
| Transport | JSON lines over a Unix socket | one file per message |

## Development

```sh
zsh test/test.zsh                          # contract tests with synthetic hook payloads
node test/opencode.test.mjs                # opencode plugin tests
claude plugin validate .                   # manifest and hooks
claude --plugin-dir . -p "…"               # run a session against the working tree
```

## License

[MIT](LICENSE)
