import { describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { HarnessStore } from "@own-harness/core"
import { attachDesktop } from "../src/commands/attach.js"
import { initProject } from "../src/bootstrap.js"
import { writeTextFile } from "../src/fs-utils.js"

describe("desktop attach", () => {
  it("verifies the codex device without launching a session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-attach-verify-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    writeFakeCodex(dir)
    const previousPath = process.env.PATH
    process.env.PATH = `${dir}:${previousPath ?? ""}`
    try {
      const result = await attachDesktop(dir, "codex", [], true)
      expect(result.status).toBe("verified")
    } finally {
      restoreEnv("PATH", previousPath)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("launches a Codex Desktop session with an isolated CODEX_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-attach-launch-"))
    initProject(dir)
    const port = await freePort()
    writeTextFile(join(dir, "harness.config.yaml"), configWithPort(dir, port))
    writeFakeCodex(dir)
    const previousPath = process.env.PATH
    process.env.PATH = `${dir}:${previousPath ?? ""}`
    try {
      const result = await attachDesktop(dir, "codex", ["exec", "--json"], false)
      expect(result.status).toBe("launched")
      const store = new HarnessStore({ dbPath: join(dir, "state.db") })
      const sessions = store.listSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.agent).toBe("chatgpt-desktop")
      expect(sessions[0]?.status).toBe("ended")
      store.close()
    } finally {
      restoreEnv("PATH", previousPath)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects unsupported desktop adapters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-attach-unsupported-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    const result = await attachDesktop(dir, "cursor", [], true)
    expect(result.status).toBe("unsupported")
    rmSync(dir, { recursive: true, force: true })
  })
})

function writeFakeCodex(dir: string): void {
  const path = join(dir, "codex")
  writeFileSync(path, `#!/usr/bin/env bash
echo "fake-codex-ok"
exit 0
`, { encoding: "utf8", mode: 0o755 })
  chmodSync(path, 0o755)
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = previous
}

function configWithLocalStore(dir: string): string {
  return configWithPort(dir, 4103)
}

function configWithPort(dir: string, port: number): string {
  process.env.HARNESS_HOME = dir
  return `version: 1
proxy:
  host: "127.0.0.1"
  port: ${port}
store:
  home: "~/.own-harness"
  retentionDays: 90
telemetry:
  enabled: false
  optInFile: "~/.own-harness/telemetry.json"
pricing:
  defaultCurrency: "USD"
  models: []
`
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("free port lookup failed")))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}
