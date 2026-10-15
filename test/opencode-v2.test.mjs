// Contract tests for the opencode v2 plugin: drives setup() with a mock context and
// synthetic events against a temporary XDG_STATE_HOME. Run: node test/opencode-v2.test.mjs
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const state = mkdtempSync(join(tmpdir(), "agent-inbox-opencode-v2-test-"))
process.env.XDG_STATE_HOME = state
process.on("exit", () => rmSync(state, { recursive: true, force: true }))

const { default: plugin } = await import(join(here, "../opencode/agent-inbox-v2.js"))
const bin = join(here, "../bin/agent-inbox")
const root = join(state, "agent-inbox")
const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-inbox-cwd-")))

let pass = 0,
  fail = 0
const check = (name, cond) => {
  if (cond) pass++, console.log(`ok    ${name}`)
  else fail++, console.log(`FAIL  ${name}`)
}

// --- mock v2 plugin context -------------------------------------------------
function eventStream() {
  const queued = []
  let wake
  return {
    push: (e) => (queued.push(e), wake?.()),
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          queued.length
            ? Promise.resolve({ value: queued.shift(), done: false })
            : new Promise((res) => (wake = () => res({ value: queued.shift(), done: false }))),
      }
    },
  }
}
const stream = eventStream()
const hooks = { session: {}, tool: {}, shell: {} }
const ctx = {
  location: { directory },
  event: { subscribe: () => stream },
  session: { hook: async (name, cb) => (hooks.session[name] = cb) },
  tool: { hook: async (name, cb) => (hooks.tool[name] = cb) },
  shell: { hook: async (name, cb) => (hooks.shell[name] = cb) },
}
const tick = () => new Promise((r) => setImmediate(r))

await plugin.setup(ctx)

stream.push({ type: "session.created", data: { sessionID: "ses_v2", location: { directory } } })
await tick()
check("session.created creates the queue", existsSync(join(root, "ses_v2")))

// a message posted by the zsh CLI through the cwd mapping is drained by the hooks
execFileSync(bin, ["post", "from-cli"], { cwd: directory, env: { ...process.env, AGENT_INBOX: undefined } })
const after = { status: "completed", result: { content: "tool says hi" } }
await hooks.tool["execute.after"]({ tool: "bash", sessionID: "ses_v2", ...after })
check(
  "tool execute.after appends queued messages to a string tool result",
  after.result.content.includes("tool says hi") && after.result.content.includes("from-cli"),
)

writeFileSync(join(root, "ses_v2", "1.msg"), "late message")
const request = { sessionID: "ses_v2", system: [], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
await hooks.session.context(request)
check(
  "session context hook delivers what was posted after the last tool call",
  request.messages.length === 2 &&
    request.messages[1].role === "user" &&
    request.messages[1].content[0].text.includes("late message"),
)

writeFileSync(join(root, "ses_v2", "2.msg"), "array result")
const afterArray = { status: "completed", result: { content: [{ type: "text", text: "first" }] } }
await hooks.tool["execute.after"]({ tool: "bash", sessionID: "ses_v2", ...afterArray })
check(
  "tool execute.after appends to an array tool result",
  afterArray.result.content.length === 2 && afterArray.result.content[1].text.includes("array result"),
)

writeFileSync(join(root, "ses_v2", "3.msg"), "error result")
const afterError = { status: "error", error: { message: "boom" } }
await hooks.tool["execute.after"]({ tool: "bash", sessionID: "ses_v2", ...afterError })
check("tool execute.after appends to a failed tool's error", afterError.error.message.includes("error result"))

const shell = { command: "true", cwd: join(directory, "sub"), timeout: 1, shell: "zsh", env: {} }
mkdirSync(join(directory, "sub"))
await hooks.shell["create.before"](shell)
check("shell create.before exports AGENT_INBOX resolved from the cwd mapping", shell.env.AGENT_INBOX === join(root, "ses_v2"))

stream.push({ type: "session.deleted", data: { sessionID: "ses_v2" } })
await tick()
check(
  "session.deleted removes the queue and the cwd mapping",
  !existsSync(join(root, "ses_v2")) && readdirSync(join(root, ".by-cwd")).length === 0,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
