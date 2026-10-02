import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { smokeRequest, waitForSmokeServer } from "./smoke-http"
import { stopSmokeProcess } from "./smoke-cleanup"

function server(handler: string) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const { createServer } = require('node:http');
    let calls = 0;
    const server = createServer((req, res) => { calls++; ${handler} });
    server.listen(0, '127.0.0.1', () => {
      console.log('opencode server listening on http://127.0.0.1:' + server.address().port);
    });
  `,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  child.stdout!.on("data", (data) => {
    output += data
  })
  child.stderr!.on("data", (data) => {
    output += data
  })
  return { child, logs: () => output }
}

test("uses the reported port and retries HTTP 503 before accepting healthy JSON", async () => {
  const instance = server(
    `res.writeHead(calls === 1 ? 503 : 200); res.end(calls === 1 ? 'starting' : '{"healthy":true}');`,
  )
  try {
    const baseURL = await waitForSmokeServer(instance.child, instance.logs, 10000)
    expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect((await smokeRequest(baseURL, "/global/health")).status).toBe(200)
  } finally {
    await stopSmokeProcess(instance.child)
  }
})

test("reports HTTP status and response body instead of hiding a rejected probe", async () => {
  const instance = server(`res.writeHead(401); res.end('authentication required');`)
  try {
    await expect(waitForSmokeServer(instance.child, instance.logs, 10000)).rejects.toThrow(
      "HTTP 401; body=authentication required",
    )
  } finally {
    await stopSmokeProcess(instance.child)
  }
})

test("does not accept a successful HTTP response from the wrong service", async () => {
  const instance = server(`res.end('not the health endpoint');`)
  try {
    await expect(waitForSmokeServer(instance.child, instance.logs, 10000)).rejects.toThrow("invalid JSON")
  } finally {
    await stopSmokeProcess(instance.child)
  }
})

test("bounds hanging health requests and includes the last network error", async () => {
  const instance = server(`/* Leave the request open to exercise the request deadline. */`)
  try {
    await expect(waitForSmokeServer(instance.child, instance.logs, 2000)).rejects.toThrow(
      "Last probe: http://127.0.0.1:",
    )
  } finally {
    await stopSmokeProcess(instance.child)
  }
})
