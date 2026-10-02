// Full TUI + real backend integration test using upstream's Windows ConPTY dependency.
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { createRequire } = require("node:module")

async function main() {
  const source = path.resolve(process.argv[2] || "opencode-src")
  const binary = path.resolve(
    process.argv[3] || path.join(source, "packages/opencode/dist/opencode-windows-x64/bin/opencode.exe"),
  )
  const requireCore = createRequire(path.join(source, "packages/core/package.json"))
  const pty = requireCore("@lydell/node-pty")
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tui-smoke-"))
  const calls = []
  const server = http.createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    if (input.model === "test-model") {
      calls.push(Date.now())
      response.writeHead(503, { "content-type": "application/json", "retry-after": "900" })
      response.end(JSON.stringify({ error: { message: "temporary service unavailable", type: "server_error" } }))
      return
    }
    const base = { id: "title", created: 1, model: "title-model" }
    if (!input.stream) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }],
        }),
      )
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      "data: " +
        JSON.stringify({
          ...base,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "Smoke" }, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    )
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const config = {
    model: "test/test-model",
    small_model: "test/title-model",
    enabled_providers: ["test"],
    formatter: false,
    lsp: false,
    snapshot: false,
    plugin: [],
    reconnect: { mode: "fixed", interval_ms: 1000, max_retries: 20 },
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        name: "Test",
        env: [],
        options: { apiKey: "local-test", baseURL: `http://127.0.0.1:${server.address().port}/v1` },
        models: {
          "test-model": { name: "Test Model", tool_call: true, limit: { context: 100000, output: 1000 } },
          "title-model": { name: "Title Model", limit: { context: 100000, output: 1000 } },
        },
      },
    },
  }
  let terminal
  let output = ""
  let exited = false
  async function wait(predicate, label, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (!predicate()) {
      if (exited) throw new Error(`TUI exited before ${label}\n${output.slice(-6000)}`)
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; request gaps=${calls.slice(1).map((time, index) => time - calls[index])}\n${output.slice(-6000)}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }
  async function send(text) {
    terminal.write(`\x1b[200~${text}\x1b[201~`)
    // Simulate a user completing a paste before pressing Enter.
    await new Promise((resolve) => setTimeout(resolve, 120))
    terminal.write("\r")
  }
  try {
    terminal = pty.spawn(binary, ["--model", "test/test-model"], {
      cwd: root,
      cols: 160,
      rows: 40,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        OPENCODE_TEST_HOME: root,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_CONFIG: "",
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_AUTH_CONTENT: "{}",
        OPENCODE_PURE: "1",
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOCOMPACT: "1",
      },
    })
    terminal.onExit(() => {
      exited = true
    })
    terminal.onData((data) => {
      if (data.includes("\x1b[6n")) terminal.write("\x1b[1;1R")
      output += data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    })
    await wait(() => output.includes("Test Model"), "model ready")
    await send("/reconnect ")
    await wait(() => output.includes("max_retries=20"), "initial settings")
    await send("/reconnect fixed 0")
    await wait(() => output.includes("Usage: /reconnect"), "invalid command response")
    assert.equal(calls.length, 0, "local commands must not submit model requests")
    await send("Say hello without tools")
    await wait(() => calls.length === 1, "first model request")
    await wait(() => /retrying (?:in \d+s )?attempt #1\b/.test(output), "session prompt mounted and retry visible")
    await send("/reconnect fixed 40")
    // ConPTY redraws only changed cells, so the text stream may omit unchanged letters.
    await wait(() => output.includes("config unchanged"), "running interval update acknowledgement")
    await send("/reconnect retries 3")
    await wait(() => calls.length >= 4, "retry budget exhaustion")
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(calls.length, 4, "one initial request plus three retries")
    const gaps = calls.slice(1).map((time, index) => time - calls[index])
    assert(gaps[0] >= 900, `already-started wait must not be interrupted: ${gaps}`)
    assert(
      gaps.slice(1).every((gap) => gap >= 30 && gap < 1000),
      `following waits use the runtime override: ${gaps}`,
    )
    console.log(
      `PASS full TUI: local query, invalid input, live interval/budget changes; requests=${calls.length}; gaps_ms=${gaps}`,
    )
  } finally {
    if (terminal && !exited) terminal.kill()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => {})
  }
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
