// agent-inbox for opencode v1: per-session message queue.
// Processes inside a session post with the agent-inbox CLI; queued messages reach the
// model appended to the next tool result and, for messages posted after the last tool
// round, as a synthetic user message before the next model call.
// Queue logic lives in ./lib/queue.js, shared with agent-inbox-v2.js.
import { drain, ensure, gc, dir, rm, unmapTarget, valid, writeMap } from "./lib/queue.js"

export const AgentInbox = async ({ directory }) => {
  let n = 0
  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sid = event.properties.info.id
        if (!valid(sid)) return
        ensure(sid)
        writeMap(directory, dir(sid))
        gc()
      }
      if (event.type === "session.deleted") {
        const sid = event.properties.info.id
        if (!valid(sid)) return
        unmapTarget(dir(sid))
        rm(sid)
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
