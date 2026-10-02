import type { ChildProcess } from "node:child_process"
import { request } from "node:http"

// Control requests must go directly to this test's loopback server, without proxy or pooled sockets.
export async function smokeRequest(baseURL: string, route: string, body?: object, timeoutMs = 5000) {
  const url = new URL(route, baseURL)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error(`Not a smoke loopback URL: ${url}`)
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: body === undefined ? "GET" : "POST",
        agent: false,
        headers: { "content-type": "application/json", connection: "close" },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", reject)
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on("error", reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

export async function waitForSmokeServer(child: ChildProcess, logs: () => string, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  let lastProbe = "Waiting for the server to report its listening address"
  let spawnError: Error | undefined
  const onError = (error: Error) => {
    spawnError = error
  }
  child.on("error", onError)
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Smoke server exited before readiness (exit=${child.exitCode}, signal=${child.signalCode})\n${logs()}`,
        )
      const baseURL = logs().match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
      if (baseURL) {
        // Log the concrete failure, including status/body; never turn every error into an unexplained false.
        const probe = await smokeRequest(
          baseURL,
          "/global/health",
          undefined,
          Math.max(1, Math.min(5000, deadline - Date.now())),
        )
          .then((response) => ({ response, error: undefined }))
          .catch((error: Error & { code?: string }) => ({
            response: undefined,
            error: `${error.code ?? error.name}: ${error.message}`,
          }))
        if (probe.response) {
          lastProbe = `${baseURL}/global/health: HTTP ${probe.response.status}; body=${probe.response.body.slice(0, 1000)}`
          if (probe.response.status >= 200 && probe.response.status < 300) {
            let health: { healthy?: boolean }
            try {
              health = JSON.parse(probe.response.body)
            } catch {
              throw new Error(`Smoke health returned invalid JSON: ${lastProbe}\n${logs()}`)
            }
            if (health?.healthy === true) return baseURL
            throw new Error(`Smoke health did not report healthy=true: ${lastProbe}\n${logs()}`)
          }
          if (probe.response.status >= 400 && probe.response.status < 500)
            throw new Error(`Smoke health request rejected: ${lastProbe}\n${logs()}`)
        } else {
          lastProbe = `${baseURL}/global/health: ${probe.error}`
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Server startup timeout after ${timeoutMs}ms. Last probe: ${lastProbe}\n${logs()}`)
  } finally {
    child.off("error", onError)
  }
}
