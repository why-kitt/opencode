// Exercise the compiled executable against a loopback-only fake provider; no paid API calls.
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"

const binary = path.resolve(
  process.argv[2] ?? "opencode-src/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe",
)
const root = await mkdtemp(path.join(tmpdir(), "opencode-patched-smoke-"))

async function scenario(budget: number, failures: number) {
  let calls = 0
  const timestamps: number[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const input = (await request.json()) as { stream?: boolean; model?: string }
      const chunk = { id: "smoke", object: "chat.completion.chunk", created: 1, model: "test-model" }
      if (!input.stream)
        return Response.json({
          ...chunk,
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      if (input.model === "test-model") {
        calls++
        timestamps.push(Date.now())
      }
      if (input.model === "test-model" && calls <= failures)
        return Response.json(
          { error: { message: "temporary service unavailable", type: "server_error" } },
          {
            status: 503,
            headers: { "retry-after": "900" },
          },
        )
      const events = [
        {
          ...chunk,
          choices: [{ index: 0, delta: { role: "assistant", content: "PATCHED_SMOKE_OK" }, finish_reason: null }],
        },
        {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const directory = path.join(root, `budget-${budget}`)
  await mkdir(directory)
  const config = {
    model: "test/test-model",
    small_model: "test/title-model",
    enabled_providers: ["test"],
    formatter: false,
    lsp: false,
    snapshot: false,
    plugin: [],
    reconnect: { mode: "fixed", interval_ms: 30, max_retries: budget },
    provider: {
      test: {
        name: "Test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "local-smoke-only", baseURL: `http://127.0.0.1:${server.port}/v1` },
        models: {
          "test-model": { name: "Test", limit: { context: 100000, output: 1000 }, tool_call: true },
          "title-model": { name: "Title", limit: { context: 100000, output: 1000 } },
        },
      },
    },
  }
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        binary,
        ["run", "--format", "json", "--model", "test/test-model", "Say PATCHED_SMOKE_OK without tools"],
        {
          cwd: directory,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OPENCODE_TEST_HOME: directory,
            OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
            XDG_CONFIG_HOME: path.join(directory, "config"),
            XDG_DATA_HOME: path.join(directory, "data"),
            XDG_CACHE_HOME: path.join(directory, "cache"),
            XDG_STATE_HOME: path.join(directory, "state"),
            OPENCODE_CONFIG: "",
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            OPENCODE_PURE: "1",
            OPENCODE_DISABLE_MODELS_FETCH: "1",
            OPENCODE_DISABLE_AUTOCOMPACT: "1",
            OPENCODE_AUTH_CONTENT: "{}",
          },
        },
      )
      let stdout = "",
        stderr = ""
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`CLI timed out; calls=${calls}\n${stderr}\n${stdout}`))
      }, 90000)
      child.stdout.on("data", (data) => {
        stdout += data
      })
      child.stderr.on("data", (data) => {
        stderr += data
      })
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
    assert.equal(calls, Math.min(failures + 1, budget + 1), JSON.stringify(result))
    if (failures <= budget) {
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /PATCHED_SMOKE_OK/)
    } else {
      assert.doesNotMatch(result.stdout, /"text":"PATCHED_SMOKE_OK"/)
      assert.match(result.stdout + result.stderr, /temporary service unavailable/)
    }
    const gaps = timestamps.slice(1).map((time, index) => time - timestamps[index])
    assert(
      gaps.every((gap) => gap >= 20 && gap < 10000),
      `fixed retry timing: ${gaps}`,
    )
    console.log(
      `PASS compiled CLI: budget=${budget}, failures=${failures}, requests=${calls}, gaps_ms=${gaps.join(",")}`,
    )
  } finally {
    server.stop(true)
  }
}

try {
  await scenario(8, 7)
  await scenario(2, 20)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
