// OpenCode v2. Synthetic admissions persist messages independently of tool output.
import { spawn } from "node:child_process"
import { dirname, delimiter } from "node:path"
import { fileURLToPath } from "node:url"

const bin = fileURLToPath(new URL("./bin/agent-inbox", import.meta.url))

function queue(command, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [`queue-${command}`, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    const output = []
    const errors = []
    child.stdout.on("data", (chunk) => output.push(chunk))
    child.stderr.on("data", (chunk) => errors.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`agent-inbox ${command} exited ${code}: ${Buffer.concat(errors)}`))
      else resolve(Buffer.concat(output).toString("utf8"))
    })
  })
}

export default {
  id: "agent-inbox",
  async setup(ctx) {
    await ctx.shell.hook("create.before", ({ env }) => {
      env.PATH = [dirname(bin), env.PATH ?? process.env.PATH].filter(Boolean).join(delimiter)
    })
    // Serial admission preserves post order within a session, including parallel tools.
    const pending = new Map()
    function flush(sessionID) {
      const work = (pending.get(sessionID) ?? Promise.resolve()).then(async () => {
        await queue("init", sessionID)
        const messages = await queue("pending", sessionID)
        for (const line of messages.split("\n").filter(Boolean)) {
          const { id, text } = JSON.parse(line)
          await ctx.session.synthetic({
            sessionID,
            id: `msg_agent_inbox_${sessionID}_${id}`,
            text,
            resume: false,
            delivery: "steer",
          })
          await queue("ack", sessionID, id)
        }
      })
      // Failed admissions leave their files for the next boundary to retry.
      const settled = work.catch((error) => console.error("[agent-inbox] Delivery failed:", error))
      pending.set(sessionID, settled)
      settled.finally(() => {
        if (pending.get(sessionID) === settled) pending.delete(sessionID)
      })
      return settled
    }

    await ctx.session.hook("prompt", ({ sessionID }) => flush(sessionID))
    await ctx.tool.hook("execute.before", ({ sessionID }) =>
      queue("init", sessionID).catch((error) => console.error("[agent-inbox] Queue initialization failed:", error)),
    )
    await ctx.tool.hook("execute.after", ({ sessionID }) => flush(sessionID))

    const controller = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.deleted") {
          await pending.get(event.data.sessionID)
          await queue("remove", event.data.sessionID).catch((error) =>
            console.error("[agent-inbox] Queue removal failed:", error),
          )
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("[agent-inbox] Event subscription failed:", error)
    })
    return async () => {
      controller.abort()
      await events
      await Promise.all(pending.values())
    }
  },
}
