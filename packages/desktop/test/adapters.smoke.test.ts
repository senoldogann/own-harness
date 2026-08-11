import { afterEach, describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessStore } from "@own-harness/core"
import { createCodexDesktopAdapter } from "../src/codex-desktop.js"
import { CursorAdapter } from "../src/cursor.js"
import { VscodeAdapter } from "../src/vscode.js"

const previousEnv = new Map<string, string | undefined>()

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  previousEnv.clear()
})

describe("desktop adapters", () => {
  it("launches Codex Desktop against the harness proxy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-codex-desktop-"))
    writeFakeBinary(dir, "codex", "codex-desktop-ok")
    const adapter = createCodexDesktopAdapter()
    const command = adapter.launchCommand({
      baseUrl: "http://127.0.0.1:4103",
      cwd: dir,
      sessionId: "session-desktop",
      projectHash: "project-desktop"
    })
    expect(command).toContain("CODEX_HOME=")
    expect(command).toContain("openai_base_url=http://127.0.0.1:4103")
    expect(command).toContain("wire_api=responses")
    setEnv("PATH", `${dir}:${process.env.PATH ?? ""}`)
    const child = adapter.launch({
      baseUrl: "http://127.0.0.1:4103",
      cwd: dir,
      sessionId: "session-desktop",
      projectHash: "project-desktop",
      args: ["exec", "--json"]
    })
    const code = await waitExit(child)
    expect(code).toBe(0)
    const envFile = readFileSync(join(dir, "codex.env"), "utf8")
    expect(envFile).toContain("HARNESS_AGENT=chatgpt-desktop")
    expect(envFile).toContain("HARNESS_SESSION_ID=session-desktop")
    expect(envFile).toContain("HARNESS_PROJECT_HASH=project-desktop")
    rmSync(dir, { recursive: true, force: true })
  })

  it("records Cursor tool calls in the local store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cursor-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const adapter = new CursorAdapter(store)
    adapter.recordToolCall({
      tool: "Bash",
      command: "git status",
      sessionId: "session-cursor",
      projectHash: "project-cursor",
      durationMs: 12,
      exitCode: 0
    })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tool: "Bash",
      command: "git status",
      agent: "cursor",
      projectHash: "project-cursor",
      status: "ok"
    })
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("records VS Code tool calls in the local store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-vscode-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const adapter = new VscodeAdapter(store)
    adapter.recordToolCall({
      tool: "Bash",
      command: "npm test",
      sessionId: "session-vscode",
      projectHash: "project-vscode",
      durationMs: 40,
      exitCode: 1
    })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      tool: "Bash",
      command: "npm test",
      agent: "vscode",
      projectHash: "project-vscode",
      status: "error"
    })
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

function writeFakeBinary(dir: string, name: string, marker: string): void {
  const path = join(dir, name)
  const content = `#!/usr/bin/env bash
env | sort > "${dir}/${name}.env"
echo "${marker}"
exit 0
`
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 })
  chmodSync(path, 0o755)
}

function setEnv(key: string, value: string): void {
  previousEnv.set(key, process.env[key])
  process.env[key] = value
}

function waitExit(child: ReturnType<ReturnType<typeof createCodexDesktopAdapter>["launch"]>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
}
