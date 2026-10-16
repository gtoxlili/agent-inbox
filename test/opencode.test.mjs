import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"
import plugin from "../index.js"

const bin = fileURLToPath(new URL("../bin/agent-inbox", import.meta.url))
const state = realpathSync(mkdtempSync(join(tmpdir(), "agent-inbox-opencode-")))
process.env.XDG_STATE_HOME = state
after(() => rmSync(state, { recursive: true, force: true }))
const files = (sid) => readdirSync(join(state, "agent-inbox", sid)).filter((name) => name.endsWith(".msg"))
const post = (sid, text) =>
  execFileSync(bin, ["post", text], {
    cwd: state,
    env: { ...process.env, AGENT_INBOX: "", CODEX_SESSION_ID: "", OPENCODE_SESSION_ID: sid },
  })

async function load(t, synthetic) {
  const hooks = { session: {}, tool: {}, shell: {} }
  let events
  const stream = new ReadableStream({
    start(controller) {
      events = controller
    },
  })
  const ctx = {
    session: {
      hook: async (name, callback) => {
        hooks.session[name] = callback
      },
      synthetic,
    },
    tool: {
      hook: async (name, callback) => {
        hooks.tool[name] = callback
      },
    },
    shell: {
      hook: async (name, callback) => {
        hooks.shell[name] = callback
      },
    },
    event: {
      subscribe: ({ signal }) => {
        signal.addEventListener("abort", () => events.close(), { once: true })
        return stream
      },
    },
  }
  const cleanup = await plugin.setup(ctx)
  t.after(cleanup)
  return { hooks, events, cleanup }
}

// Upstream contract: OpenCode v2.0.28 tool/plugin/shell.ts sets OPENCODE_SESSION_ID.
// session.synthetic admits durably; resume:false leaves idle sessions asleep.
test("native session IDs isolate senders in the same cwd, even with concurrent tools", async (t) => {
  const admitted = []
  const { hooks } = await load(t, async (input) => {
    admitted.push(input)
  })
  for (const sessionID of ["ses_one", "ses_two"]) await hooks.tool["execute.before"]({ sessionID })
  post("ses_one", "one")
  post("ses_one", "two")
  post("ses_two", "private")
  await Promise.all([
    hooks.tool["execute.after"]({ sessionID: "ses_one", status: "completed" }),
    hooks.tool["execute.after"]({ sessionID: "ses_one", status: "error" }),
  ])
  assert.equal(admitted.length, 2)
  assert.ok(admitted[0].text.endsWith("\n\none"))
  assert.ok(admitted[1].text.endsWith("\n\ntwo"))
  for (const message of admitted) {
    assert.equal(message.sessionID, "ses_one")
    assert.equal(message.resume, false)
    assert.equal(message.delivery, "steer")
  }
  assert.equal(files("ses_one").length, 0)
  assert.equal(files("ses_two").length, 1)
})

test("files survive a failed admission and retry with the same durable message ID", async (t) => {
  t.mock.method(console, "error", () => {})
  const attempts = []
  let fail = true
  const { hooks } = await load(t, async (input) => {
    attempts.push(input)
    if (fail) throw new Error("connection lost after admission")
  })
  await hooks.tool["execute.before"]({ sessionID: "ses_retry" })
  post("ses_retry", "keep me")
  await hooks.tool["execute.after"]({ sessionID: "ses_retry" })
  assert.equal(files("ses_retry").length, 1)
  fail = false
  await hooks.tool["execute.after"]({ sessionID: "ses_retry" })
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0], attempts[1])
  assert.equal(files("ses_retry").length, 0)
})

test("a paused session delivers background mail on its next prompt after plugin reload", async (t) => {
  const first = await load(t, async () => {})
  await first.hooks.session.prompt({ sessionID: "ses_resume" })
  await first.cleanup()
  post("ses_resume", "background result")
  const admitted = []
  const second = await load(t, async (input) => {
    admitted.push(input)
  })
  await second.hooks.session.prompt({ sessionID: "ses_resume" })
  assert.equal(admitted.length, 1)
  assert.ok(admitted[0].text.endsWith("\n\nbackground result"))
  assert.equal(files("ses_resume").length, 0)
})

test("the queue is acknowledged only after the asynchronous native admission returns", async (t) => {
  let accept
  let received
  const receiving = new Promise((resolve) => {
    received = resolve
  })
  const accepted = new Promise((resolve) => {
    accept = resolve
  })
  const { hooks } = await load(t, async () => {
    received()
    await accepted
  })
  await hooks.tool["execute.before"]({ sessionID: "ses_ack" })
  post("ses_ack", "pending receipt")
  const delivery = hooks.tool["execute.after"]({ sessionID: "ses_ack" })
  await receiving
  try {
    assert.equal(files("ses_ack").length, 1)
  } finally {
    accept()
    await delivery
  }
  assert.equal(files("ses_ack").length, 0)
})

test("session deletion removes its queue", async (t) => {
  const { hooks, events, cleanup } = await load(t, async () => {})
  await hooks.tool["execute.before"]({ sessionID: "ses_delete" })
  events.enqueue({ type: "session.deleted", data: { sessionID: "ses_delete" } })
  await cleanup()
  assert.equal(existsSync(join(state, "agent-inbox", "ses_delete")), false)
})
