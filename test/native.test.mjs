// Opt-in integration tests against installed CLIs, using a local scripted model.
// No provider credentials or remote model calls. AGENT_INBOX_NATIVE_TEST=1 npm test
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("..", import.meta.url))
const enabled = process.env.AGENT_INBOX_NATIVE_TEST === "1"
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const sender = (dir, marker) =>
  `sh -c ${quote(`command -v agent-inbox > ${quote(join(dir, "sender-path"))} && agent-inbox post ${quote(marker)} >/dev/null 2>&1`)}`

async function fixture(t, respond) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-inbox-native space'-")))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    res.writeHead(200, { "content-type": "text/event-stream" })
    respond(body, res, requests)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const env = {
    PATH: process.env.PATH,
    SHELL: "/bin/zsh",
    TMPDIR: process.env.TMPDIR,
    XDG_STATE_HOME: join(dir, "state"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_CACHE_HOME: join(dir, "cache"),
  }
  return { dir, requests, url, env }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
    const out = []
    child.stdout.on("data", (chunk) => out.push(chunk))
    child.stderr.on("data", (chunk) => out.push(chunk))
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000)
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      const output = Buffer.concat(out).toString()
      if (code === 0) resolve(output)
      else reject(new Error(`${command} exited ${code}\n${output.slice(-6000)}`))
    })
  })
}

function checkHistory(requests, field, marker) {
  assert.equal(requests.length, 3, "tool continuations must reach the scripted model")
  const second = requests[1][field]
  const third = requests[2][field]
  // The command text includes the marker too; require the inbox's distinct header.
  const deliveries = (messages) => messages.filter((m) => JSON.stringify(m).includes("Messages left by programs"))
  assert.equal(deliveries(second).length, 1, JSON.stringify(second.filter((m) => m.role !== "system").slice(-4)))
  assert.ok(JSON.stringify(deliveries(second)).includes(marker))
  assert.equal(
    JSON.stringify(third.slice(0, second.length)),
    JSON.stringify(second),
    "delivered context must survive the next tool round byte for byte",
  )
}

test(
  "Codex delivers suppressed child output through hooks and persists it",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const marker = "codex-native-inbox-probe"
    let forbidden
    const f = await fixture(t, (_body, res, requests) => {
      const n = requests.length
      const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`)
      event({ type: "response.created", response: { id: `resp_${n}` } })
      const item =
        n < 3
          ? {
              type: "function_call",
              call_id: `call_${n}`,
              name: "exec_command",
              arguments: JSON.stringify({
                cmd:
                  n === 1
                    ? sender(f.dir, marker)
                    : `printf blocked > ${quote(forbidden)}`,
              }),
            }
          : { type: "message", role: "assistant", id: "msg_done", content: [{ type: "output_text", text: "done" }] }
      event({ type: "response.output_item.done", item })
      event({
        type: "response.completed",
        response: { id: `resp_${n}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      })
    })
    const testHome = join(f.dir, "codex")
    const state = mkdtempSync(join(homedir(), ".agent-inbox-native-"))
    forbidden = join(state, "sandbox-must-deny")
    t.after(() => rmSync(state, { recursive: true, force: true }))
    mkdirSync(testHome)
    writeFileSync(
      join(testHome, "config.toml"),
      `model = "inbox-test"\nmodel_provider = "local-test"\n[model_providers.local-test]\nname = "Local test"\nbase_url = "${f.url}"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\ncode_mode = false\n`,
    )
    const options = { cwd: f.dir, env: { ...f.env, XDG_STATE_HOME: state, CODEX_HOME: testHome } }
    await run("codex", ["plugin", "marketplace", "add", repo, "--json"], options)
    await run("codex", ["plugin", "add", "agent-inbox@agent-inbox", "--json"], options)
    const output = await run(
      "codex",
      [
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-hook-trust",
        "--sandbox",
        "workspace-write",
        "probe inbox",
      ],
      {
        cwd: f.dir,
        env: { ...f.env, XDG_STATE_HOME: state, CODEX_HOME: testHome },
      },
    )
    try {
      checkHistory(f.requests, "input", marker)
      assert.ok(readFileSync(join(f.dir, "sender-path"), "utf8").startsWith(join(testHome, "plugins/cache/")))
      assert.equal(existsSync(forbidden), false, "the PATH hook must preserve the workspace-write sandbox")
      const results = f.requests[2].input.filter((item) => item.type === "function_call_output")
      assert.match(JSON.stringify(results.at(-1)), /Operation not permitted|Permission denied|reject|sandbox/i)
    } catch (error) {
      t.diagnostic(output.slice(0, 4000))
      throw error
    }
  },
)

test(
  "Claude Code delivers through PostToolBatch and retains the inbox context",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const marker = "claude-native-inbox-probe"
    const f = await fixture(t, (_body, res, requests) => {
      const n = requests.length
      const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
      event("message_start", {
        message: {
          id: `msg_${n}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "local-fixture",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      })
      if (n < 3) {
        event("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: `tool_${n}`, name: "Bash", input: {} },
        })
        event("content_block_delta", {
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              command:
                n === 1 ? sender(f.dir, marker) : "true",
            }),
          },
        })
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } })
      }
      event("content_block_stop", { index: 0 })
      event("message_delta", {
        delta: { stop_reason: n < 3 ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      })
      event("message_stop", {})
    })
    await run(
      "claude",
      [
        "-p",
        "--model",
        "haiku",
        "--plugin-dir",
        repo,
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--dangerously-skip-permissions",
        "probe inbox",
      ],
      {
        cwd: f.dir,
        env: {
          ...f.env,
          CLAUDE_CONFIG_DIR: join(f.dir, "claude"),
          ANTHROPIC_BASE_URL: f.url,
          ANTHROPIC_API_KEY: "local-fixture",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    )
    assert.equal(f.requests.length, 3)
    // Claude moves cache_control markers and alternates string/text-block encoding.
    // The plugin owns the delivered text, not that transport representation.
    const mail = (request) =>
      request.messages
        .flatMap((m) =>
          typeof m.content === "string" ? [m.content] : (m.content ?? []).map((part) => part.text).filter(Boolean),
        )
        .filter((text) => text.includes("Messages left by programs"))
    assert.equal(mail(f.requests[1]).length, 1)
    assert.ok(mail(f.requests[1])[0].includes(marker))
    assert.deepEqual(mail(f.requests[2]), mail(f.requests[1]))
    assert.equal(readFileSync(join(f.dir, "sender-path"), "utf8").trim(), join(repo, "bin/agent-inbox"))
  },
)

test(
  "OpenCode v2 delivers via its durable inbox and keeps the request prefix",
  { skip: !enabled, timeout: 60_000 },
  async (t) => {
    const marker = "opencode-native-inbox-probe"
    const primary = []
    const f = await fixture(t, (body, res) => {
      const agent = body.tools?.length > 0
      if (agent) primary.push(body)
      const n = primary.length
      const delta =
        agent && n < 3
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${n}`,
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: JSON.stringify({
                      command:
                        n === 1
                          ? sender(f.dir, marker)
                          : "true",
                    }),
                  },
                },
              ],
            }
          : { content: "done" }
      const chunk = (delta, finish_reason) =>
        res.write(
          `data: ${JSON.stringify({ id: `chat_${n}`, object: "chat.completion.chunk", created: 1, model: "inbox-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        )
      chunk(delta, null)
      chunk({}, delta.tool_calls ? "tool_calls" : "stop")
      res.write("data: [DONE]\n\n")
    })
    const config = {
      plugins: [{ package: repo }],
      model: "inbox-test/inbox-test",
      providers: {
        "inbox-test": {
          package: "@opencode/ai/providers/openai-compatible",
          env: ["INBOX_TEST_KEY"],
          settings: { baseURL: f.url },
          models: { "inbox-test": { limit: { context: 128000, output: 1024 } } },
        },
      },
    }
    const output = await run(
      "opencode",
      ["run", "--standalone", "--auto", "--print-logs", "--format", "json", "probe inbox"],
      {
        cwd: f.dir,
        env: {
          ...f.env,
          OPENCODE_CONFIG_DIR: join(f.dir, "config"),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          INBOX_TEST_KEY: "local-fixture",
        },
      },
    )
    try {
      checkHistory(primary, "messages", marker)
      assert.equal(readFileSync(join(f.dir, "sender-path"), "utf8").trim(), join(repo, "bin/agent-inbox"))
    } catch (error) {
      t.diagnostic(
        output
          .split("\n")
          .filter((line) => /plugin|ERROR|WARN|failed/i.test(line))
          .join("\n")
          .slice(0, 7000),
      )
      throw error
    }
  },
)
