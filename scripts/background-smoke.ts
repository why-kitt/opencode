// Compiled-server integration: actual parent model loop, task calls and completion callbacks.
import { spawn } from "node:child_process"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { removeSmokeDirectory, stopSmokeProcess } from "./smoke-cleanup"
import { smokeRequest, waitForSmokeServer } from "./smoke-http"

const binary = path.resolve(process.argv[2])
const root = await mkdtemp(path.join(tmpdir(), "opencode-background-"))
let releaseA!: () => void
let releaseB!: () => void
const a = new Promise<void>((resolve) => {
  releaseA = resolve
})
const b = new Promise<void>((resolve) => {
  releaseB = resolve
})
let bRunning = false
let reassigned = false
let dispatched = false
let parentContinued = false
const calls: string[] = []
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const input = await request.json()
    const serialized = JSON.stringify(input.messages)
    const chunk = {
      id: "bg-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: input.model,
    }
    let content = "DONE"
    let tasks: { id: string; prompt: string; task_id?: string }[] = []
    if (input.model === "parent") {
      calls.push("parent")
      if (!dispatched) {
        dispatched = true
        tasks = [
          { id: "call_A", prompt: "WORK_A" },
          { id: "call_B", prompt: "WORK_B" },
        ]
      } else if (serialized.includes("A_COMPLETE") && !reassigned) {
        assert(bRunning, "B must still be running at A callback")
        // Locate A's initial task result (tool message contains the resumable ID).
        const result = input.messages.find(
          (message: { role: string; tool_call_id?: string }) =>
            message.role === "tool" && message.tool_call_id === "call_A",
        )
        const id = JSON.stringify(result).match(/ses_[a-zA-Z0-9]+/)
        const aID = id?.[0] ?? ""
        assert(aID.startsWith("ses_"), `Missing A task id: ${JSON.stringify(result)}`)
        reassigned = true
        tasks = [{ id: "call_A2", prompt: "WORK_A2", task_id: aID }]
      } else {
        parentContinued = true
        if (bRunning) releaseA()
      }
    } else if (input.model === "child") {
      const last = JSON.stringify(input.messages.filter((message: { role: string }) => message.role === "user").at(-1))
      if (last.includes("WORK_A2")) {
        assert(bRunning, "B must still run when A2 executes")
        calls.push("A2")
        content = "A2_COMPLETE"
        releaseB()
      } else if (last.includes("WORK_B")) {
        calls.push("B")
        bRunning = true
        if (parentContinued) releaseA()
        await b
        bRunning = false
        content = "B_COMPLETE"
      } else {
        calls.push("A")
        await a
        content = "A_COMPLETE"
      }
    }
    const delta = tasks.length
      ? {
          role: "assistant",
          tool_calls: tasks.map((task, index) => ({
            index,
            id: task.id,
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                description: task.prompt,
                prompt: task.prompt,
                subagent_type: "general",
                ...(task.task_id ? { task_id: task.task_id } : {}),
              }),
            },
          })),
        }
      : { role: "assistant", content }
    const events = [
      { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: tasks.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const config = {
  subagent_default_background: true,
  model: "test/parent",
  small_model: "test/title",
  agent: { general: { model: "test/child" } },
  enabled_providers: ["test"],
  formatter: false,
  lsp: false,
  snapshot: false,
  plugin: [],
  provider: {
    test: {
      name: "Test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "local",
        baseURL: `http://127.0.0.1:${provider.port}/v1`,
      },
      models: Object.fromEntries(
        ["parent", "child", "title"].map((name) => [
          name,
          { name, limit: { context: 100000, output: 1000 }, tool_call: true },
        ]),
      ),
    },
  },
}
await mkdir(path.join(root, "project"))
const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
  cwd: path.join(root, "project"),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["http_proxy", "https_proxy", "all_proxy", "no_proxy"].includes(key.toLowerCase()),
      ),
    ),
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_SERVER_USERNAME: "",
    TEMP: tmpdir(),
    TMP: tmpdir(),
    OPENCODE_EXPERIMENTAL: "false",
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
    OPENCODE_TEST_HOME: root,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_CONFIG: "",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
  },
})
let logs = ""
child.stdout.on("data", (data) => {
  logs += data
})
child.stderr.on("data", (data) => {
  logs += data
})
let baseURL: string | undefined
async function api(route: string, body?: object) {
  assert(baseURL, "Server has not reported a healthy listening address")
  const response = await smokeRequest(baseURL, route, body)
  assert(response.status >= 200 && response.status < 300, `${route}: HTTP ${response.status}; ${response.body}`)
  return response.status === 204 ? undefined : JSON.parse(response.body)
}
try {
  baseURL = await waitForSmokeServer(child, () => logs)
  const deadline = Date.now() + 90000
  assert.equal((await api("/experimental/capabilities")).backgroundSubagents, true)
  const session = await api("/session", { title: "Background integration" })
  await api(`/session/${session.id}/prompt_async`, {
    parts: [{ type: "text", text: "Launch WORK_A and WORK_B" }],
  })
  while (!calls.includes("A2")) {
    if (Date.now() > deadline) throw new Error(`Callback/reassignment timeout: ${calls}\n${logs}`)
    await Bun.sleep(100)
  }
  assert(parentContinued)
  assert(reassigned)
} finally {
  releaseA()
  releaseB()
  // Give the backend a chance to release database/file watchers before terminating its process tree.
  if (baseURL) await smokeRequest(baseURL, "/global/dispose", {}, 5000).catch(() => undefined)
  try {
    await stopSmokeProcess(child)
  } finally {
    provider.stop(true)
  }
  await removeSmokeDirectory(root)
}
console.log(
  `PASS compiled background config, parent continuation, A callback and A2 reuse while B runs: ${calls.join(" -> ")}`,
)
