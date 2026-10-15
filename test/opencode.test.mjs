// Contract tests for the opencode plugin: drives the hooks object with synthetic inputs
// against a temporary XDG_STATE_HOME; does not start opencode. Run: node test/opencode.test.mjs
import { execFileSync } from "node:child_process"
import { mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const state = mkdtempSync(join(tmpdir(), "agent-inbox-opencode-test-"))
process.env.XDG_STATE_HOME = state
process.on("exit", () => rmSync(state, { recursive: true, force: true }))

const { AgentInbox } = await import(join(here, "../opencode/agent-inbox.js"))
const bin = join(here, "../bin/agent-inbox")
const root = join(state, "agent-inbox")
const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-inbox-cwd-")))

let pass = 0,
  fail = 0
const check = (name, cond) => {
  if (cond) pass++, console.log(`ok    ${name}`)
  else fail++, console.log(`FAIL  ${name}`)
}

const hooks = await AgentInbox({ directory })

await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_1" } } } })
check("session.created creates the queue", existsSync(join(root, "ses_1")))

const mapNames = readdirSync(join(root, ".by-cwd"))
const expected = execFileSync("cksum", { input: directory }).toString().split(/\s+/)[0]
check("cwd mapping filename matches POSIX cksum (shared with bin/agent-inbox)", mapNames.includes(expected))
check(
  "cwd mapping points at the session queue",
  readFileSync(join(root, ".by-cwd", expected), "utf8").split("\n")[0] === join(root, "ses_1"),
)

// a message posted by the zsh CLI through the cwd mapping is drained by the JS hooks
execFileSync(bin, ["post", "from-cli"], { cwd: directory, env: { ...process.env, AGENT_INBOX: undefined } })
writeFileSync(join(root, "ses_1", "1.msg"), "from-fs")
const toolOut = { title: "", output: "tool says hi", metadata: {} }
await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_1", callID: "c1", args: {} }, toolOut)
check(
  "tool.execute.after appends queued messages to the tool output",
  toolOut.output.includes("tool says hi") &&
    toolOut.output.includes("from-cli") &&
    toolOut.output.includes("from-fs"),
)
check("a drained queue is empty", readdirSync(join(root, "ses_1")).length === 0)

writeFileSync(join(root, "ses_1", "2.msg"), "late message")
const messages = [
  {
    info: { id: "m1", sessionID: "ses_1", role: "user", agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text: "hello" }],
  },
]
await hooks["experimental.chat.messages.transform"]({}, { messages })
check(
  "messages.transform delivers what was posted after the last tool round as a synthetic user message",
  messages.length === 2 &&
    messages[1].info.role === "user" &&
    messages[1].parts[0].type === "text" &&
    messages[1].parts[0].synthetic === true &&
    messages[1].parts[0].text.includes("late message"),
)

const envOut = { env: {} }
await hooks["shell.env"]({ cwd: directory, sessionID: "ses_1" }, envOut)
check("shell.env exports AGENT_INBOX to the session's shell calls", envOut.env.AGENT_INBOX === join(root, "ses_1"))

await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "ses_1" } } } })
check(
  "session.deleted removes the queue and the cwd mapping",
  !existsSync(join(root, "ses_1")) && readdirSync(join(root, ".by-cwd")).length === 0,
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
