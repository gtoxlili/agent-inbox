// agent-inbox for opencode: per-session message queue.
// Processes inside a session post with the agent-inbox CLI; queued messages reach the
// model appended to the next tool result and, for messages posted after the last tool
// round, as a synthetic user message before the next model call.
//
// Queue format is shared with bin/agent-inbox: one .msg file per message under
// $XDG_STATE_HOME/agent-inbox/<session_id>/; a drain moves messages into a private
// claim directory before reading, so concurrent drains deliver each message once.
// $root/.by-cwd/<posix cksum of cwd> maps a session's working directory to its queue
// for `agent-inbox post` calls that run without AGENT_INBOX in the environment.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-inbox")
const header =
  "Messages left by programs running in this session (delivered through the session inbox; they may not appear in any command output):"

const dir = (sid) => join(root, sid)
const valid = (sid) => typeof sid === "string" && /^[A-Za-z0-9_-]+$/.test(sid)

// POSIX cksum (CRC-32, poly 0x04C11DB7, MSB-first, length appended little-endian),
// matching the cksum binary bin/agent-inbox uses for the same filenames.
const table = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 24
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0
    t[i] = c >>> 0
  }
  return t
})()
function cksum(s) {
  const buf = Buffer.from(s, "utf8")
  let crc = 0
  const feed = (b) => (crc = ((crc << 8) ^ table[((crc >>> 24) ^ b) & 0xff]) >>> 0)
  for (const b of buf) feed(b)
  for (let n = buf.length; n > 0; n = Math.floor(n / 256)) feed(n & 0xff)
  return ~crc >>> 0
}

const mapPath = (cwd) => join(root, ".by-cwd", String(cksum(cwd)))

function writeMap(cwd, target) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return
  try {
    cwd = realpathSync(cwd) // bin/agent-inbox canonicalizes with ${cwd:A}; keep the same key
  } catch {}
  mkdirSync(join(root, ".by-cwd"), { recursive: true })
  const f = mapPath(cwd)
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, `${target}\n${cwd}\n`)
  renameSync(tmp, f)
}

function unmap(cwd, target) {
  try {
    cwd = realpathSync(cwd)
  } catch {}
  try {
    const [t] = readFileSync(mapPath(cwd), "utf8").split("\n")
    if (t === target) rmSync(mapPath(cwd))
  } catch {}
}

function gc() {
  const week = 7 * 24 * 3600 * 1000
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue
    try {
      if (Date.now() - statSync(join(root, name)).mtimeMs > week) rmSync(join(root, name), { recursive: true, force: true })
    } catch {}
  }
  try {
    for (const name of readdirSync(join(root, ".by-cwd"))) {
      const f = join(root, ".by-cwd", name)
      try {
        const [t] = readFileSync(f, "utf8").split("\n")
        if (!existsSync(t)) rmSync(f)
      } catch {}
    }
  } catch {}
}

function drain(sid) {
  if (!valid(sid)) return ""
  const d = dir(sid)
  let names
  try {
    names = readdirSync(d)
      .filter((n) => n.endsWith(".msg"))
      .sort()
  } catch {
    return ""
  }
  if (!names.length) return ""
  const claim = join(d, `.claim.${process.pid}.${Math.random().toString(36).slice(2)}`)
  mkdirSync(claim, { recursive: true })
  const got = []
  for (const n of names)
    try {
      renameSync(join(d, n), join(claim, n))
      got.push(n)
    } catch {}
  const body = got
    .sort()
    .map((n) => {
      try {
        return readFileSync(join(claim, n), "utf8")
      } catch {
        return ""
      }
    })
    .filter(Boolean)
    .join("\n\n")
  rmSync(claim, { recursive: true, force: true })
  return body ? `${header}\n\n${body}` : ""
}

export const AgentInbox = async ({ directory }) => {
  let n = 0
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sid = event.properties.info.id
        if (!valid(sid)) return
        mkdirSync(dir(sid), { recursive: true })
        writeMap(directory, dir(sid))
        gc()
      }
      if (event.type === "session.deleted") {
        const sid = event.properties.info.id
        if (!valid(sid)) return
        unmap(directory, dir(sid))
        rmSync(dir(sid), { recursive: true, force: true })
      }
    },
    "shell.env": async (input, output) => {
      if (valid(input.sessionID)) output.env.AGENT_INBOX = dir(input.sessionID)
    },
    "tool.execute.after": async (input, output) => {
      const body = drain(input.sessionID)
      if (body && typeof output.output === "string") output.output += `\n\n${body}`
    },
    "experimental.chat.messages.transform": async (input, output) => {
      const last = output.messages[output.messages.length - 1]
      const sid = last?.info?.sessionID
      const body = drain(sid)
      if (!body) return
      const lastUser = [...output.messages].reverse().find((m) => m.info?.role === "user")
      if (!lastUser) return
      const t = Date.now()
      const mid = `msg_inbox_${t}_${n++}`
      output.messages.push({
        info: {
          id: mid,
          sessionID: sid,
          role: "user",
          time: { created: t },
          agent: lastUser.info.agent,
          model: lastUser.info.model,
        },
        parts: [{ id: `part_inbox_${t}_${n}`, sessionID: sid, messageID: mid, type: "text", text: body, synthetic: true }],
      })
    },
  }
}
