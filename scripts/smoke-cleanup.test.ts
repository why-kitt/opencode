import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { removeSmokeDirectory, stopSmokeProcess } from "./smoke-cleanup"

test.skipIf(process.platform !== "win32")(
  "stops the smoke process tree before deleting its working directory",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-cleanup-tree-"))
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    const { spawn } = require('node:child_process');
    const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    process.stdout.write(String(nested.pid));
    setInterval(() => {}, 1000);
  `,
      ],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    )
    try {
      const [data] = await once(child.stdout!, "data")
      const nestedPID = Number(String(data))
      expect(nestedPID).toBeGreaterThan(0)
      await stopSmokeProcess(child)
      expect(() => process.kill(nestedPID, 0)).toThrow()
      expect(await removeSmokeDirectory(root)).toBe(true)
      expect(await stat(root).catch(() => undefined)).toBeUndefined()
    } finally {
      await stopSmokeProcess(child)
      await removeSmokeDirectory(root)
    }
  },
)

test.skipIf(process.platform !== "win32")("retries a real Windows directory lock until its owner exits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-cleanup-lock-"))
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    await once(child.stdout!, "data")
    const cleanup = removeSmokeDirectory(root)
    await Bun.sleep(500)
    expect((await stat(root)).isDirectory()).toBe(true)
    await stopSmokeProcess(child)
    expect(await cleanup).toBe(true)
    expect(await stat(root).catch(() => undefined)).toBeUndefined()
  } finally {
    await stopSmokeProcess(child)
    await removeSmokeDirectory(root)
  }
})

test.skipIf(process.platform !== "win32")(
  "reports an exhausted Windows lock without failing the behavioral test",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-cleanup-busy-"))
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      await once(child.stdout!, "data")
      expect(await removeSmokeDirectory(root)).toBe(false)
      expect((await stat(root)).isDirectory()).toBe(true)
    } finally {
      await stopSmokeProcess(child)
      expect(await removeSmokeDirectory(root)).toBe(true)
    }
  },
  15000,
)

test("refuses cleanup outside smoke temporary directories", async () => {
  await expect(removeSmokeDirectory(tmpdir())).rejects.toThrow("Refusing to remove")
})
