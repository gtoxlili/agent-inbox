// agent-inbox for opencode v2: per-session message queue.
// Processes inside a session post with the agent-inbox CLI; queued messages reach the
// model appended to the next tool result and, for anything still queued, as a user
// message on the next primary model request ("context" runs before each one).
//
// V2's shell hook carries no session id, so AGENT_INBOX is resolved from the shell's
// cwd through the same .by-cwd mapping bin/agent-inbox falls back to. Queue logic
// lives in ./lib/queue.js, shared with agent-inbox.js (v1).
import { drain, ensure, gc, dir, rm, resolve, unmapTarget, valid, writeMap } from "./lib/queue.js"

export default {
  id: "agent-inbox",
  async setup(ctx) {
    const fallbackCwd = ctx.location.directory
    const controller = new AbortController()
    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const sid = event.data?.sessionID
        if (!valid(sid)) continue
        if (event.type === "session.created") {
          ensure(sid)
          writeMap(event.data?.location?.directory ?? fallbackCwd, dir(sid))
          gc()
        }
        if (event.type === "session.deleted") {
          unmapTarget(dir(sid))
          rm(sid)
        }
      }
    })().catch(() => {})

    await ctx.session.hook("context", (event) => {
      const body = drain(event.sessionID)
      if (body) event.messages.push({ role: "user", content: [{ type: "text", text: body }] })
    })

    await ctx.tool.hook("execute.after", (event) => {
      const body = drain(event.sessionID)
      if (!body) return
      if (event.status === "error") {
        event.error.message += `\n\n${body}`
        return
      }
      const result = event.result
      if (typeof result.content === "string") result.content += `\n\n${body}`
      else if (Array.isArray(result.content)) result.content = [...result.content, { type: "text", text: body }]
      else result.content = body
    })

    await ctx.shell.hook("create.before", (event) => {
      const queue = resolve(event.cwd)
      if (queue) event.env.AGENT_INBOX = queue
    })

    return () => {
      controller.abort()
      events.catch(() => {})
    }
  },
}
