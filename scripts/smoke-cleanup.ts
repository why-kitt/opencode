import { execFile } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

export async function stopSmokeProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (process.platform === "win32") {
      // Killing only the CLI can leave descendants holding its working directory open.
      await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10000,
      }).catch((error) => {
        if (child.exitCode === null && child.signalCode === null) throw error
      })
    } else {
      child.kill()
    }
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Smoke process ${child.pid} did not exit`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function removeSmokeDirectory(directory: string) {
  const target = path.resolve(directory)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("opencode-"))
    throw new Error(`Refusing to remove a directory outside the smoke-test temporary roots: ${target}`)
  // Explicit retries also work on Bun versions that do not honor fs.rm's retry options.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(target, { recursive: true, force: true })
      return true
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      if (process.platform !== "win32" || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(code))) throw error
      if (attempt === 20) {
        // A leftover runner temp directory is distinct from a failed behavioral assertion.
        console.warn(
          `WARNING: Windows kept smoke-test temporary files locked after cleanup retries (${code}): ${target}`,
        )
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}
