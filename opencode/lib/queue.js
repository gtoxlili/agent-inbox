// Shared per-session message queue for the opencode plugins (v1 and v2).
// Format is shared with bin/agent-inbox: one .msg file per message under
// $XDG_STATE_HOME/agent-inbox/<session_id>/; a drain moves messages into a private
// claim directory before reading, so concurrent drains deliver each message once.
// $root/.by-cwd/<posix cksum of cwd> maps a session's working directory to its queue
// for `agent-inbox post` calls that run without AGENT_INBOX in the environment.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export const root = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-inbox")
export const header =
  "Messages left by programs running in this session (delivered through the session inbox; they may not appear in any command output):"

export const dir = (sid) => join(root, sid)
export const valid = (sid) => typeof sid === "string" && /^[A-Za-z0-9_-]+$/.test(sid)

export function ensure(sid) {
  if (valid(sid)) mkdirSync(dir(sid), { recursive: true })
}

export function rm(sid) {
  if (valid(sid)) rmSync(dir(sid), { recursive: true, force: true })
}

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
export function cksum(s) {
  const buf = Buffer.from(s, "utf8")
  let crc = 0
  const feed = (b) => (crc = ((crc << 8) ^ table[((crc >>> 24) ^ b) & 0xff]) >>> 0)
  for (const b of buf) feed(b)
  for (let n = buf.length; n > 0; n = Math.floor(n / 256)) feed(n & 0xff)
  return ~crc >>> 0
}

const canonical = (cwd) => {
  try {
    return realpathSync(cwd) // bin/agent-inbox canonicalizes with ${cwd:A}; keep the same key
  } catch {
    return cwd
  }
}

const mapPath = (cwd) => join(root, ".by-cwd", String(cksum(cwd)))

export function writeMap(cwd, target) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return
  mkdirSync(join(root, ".by-cwd"), { recursive: true })
  const f = mapPath(canonical(cwd))
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(tmp, `${target}\n${canonical(cwd)}\n`)
  renameSync(tmp, f)
}

// Remove every mapping that points at target; used when a session ends, whose event
// does not carry the session's working directory.
export function unmapTarget(target) {
  let names
  try {
    names = readdirSync(join(root, ".by-cwd"))
  } catch {
    return
  }
  for (const name of names) {
    const f = join(root, ".by-cwd", name)
    try {
      if (readFileSync(f, "utf8").split("\n")[0] === target) rmSync(f)
    } catch {}
  }
}

// The queue a process running in cwd belongs to, walking up to parent directories;
// mirrors the lookup bin/agent-inbox post does without AGENT_INBOX.
export function resolve(cwd) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return
  let d = canonical(cwd)
  for (;;) {
    try {
      const [target, mapped] = readFileSync(mapPath(d), "utf8").split("\n")
      if (mapped === d && target.startsWith(`${root}/`) && existsSync(target)) return target
    } catch {}
    if (d === "/") return
    d = join(d, "..")
  }
}

export function gc() {
  const week = 7 * 24 * 3600 * 1000
  let names
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name.startsWith(".")) continue
    try {
      if (Date.now() - statSync(join(root, name)).mtimeMs > week) rmSync(join(root, name), { recursive: true, force: true })
    } catch {}
  }
  try {
    for (const name of readdirSync(join(root, ".by-cwd"))) {
      const f = join(root, ".by-cwd", name)
      try {
        if (!existsSync(readFileSync(f, "utf8").split("\n")[0])) rmSync(f)
      } catch {}
    }
  } catch {}
}

export function drain(sid) {
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
