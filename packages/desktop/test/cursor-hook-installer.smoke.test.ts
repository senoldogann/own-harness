import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { describe, expect, it } from "vitest"
import { installCursorProjectHooks } from "../src/cursor-hook-installer.js"

describe("Cursor project hooks", () => {
  it("preserves existing hooks and reports correlated lifecycle events", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "own-harness-cursor-hooks-"))
    const cursorDirectory = join(workspace, ".cursor")
    const server = await createIngestServer()
    installCursorProjectHooks(workspace)
    const first = JSON.parse(readFileSync(join(cursorDirectory, "hooks.json"), "utf8")) as {
      readonly hooks: Readonly<Record<string, readonly { readonly command: string }[]>>
    }
    expect(first.hooks.preToolUse?.[0]?.command).toBe("node .cursor/own-harness-hook.cjs")

    writeFileSync(join(cursorDirectory, "hooks.json"), JSON.stringify({
      version: 1,
      hooks: {
        preToolUse: [
          { command: "node existing-hook.cjs", matcher: "Bash", timeout: 3 },
          ...first.hooks.preToolUse ?? []
        ],
        postToolUse: first.hooks.postToolUse,
        postToolUseFailure: first.hooks.postToolUseFailure
      }
    }), "utf8")
    const installation = installCursorProjectHooks(workspace)
    const merged = JSON.parse(readFileSync(installation.configPath, "utf8")) as {
      readonly hooks: Readonly<Record<string, readonly { readonly command: string }[]>>
    }
    expect(merged.hooks.preToolUse?.map((hook) => hook.command)).toEqual([
      "node existing-hook.cjs",
      "node .cursor/own-harness-hook.cjs"
    ])
    expect((merged as { readonly version?: number }).version).toBe(1)

    const baseInput = {
      tool_name: "Shell",
      tool_input: { command: "pnpm test" },
      tool_use_id: "cursor-tool-1",
      conversation_id: "cursor-session",
      cwd: workspace
    }
    await runHook(installation.scriptPath, workspace, server.baseUrl, {
      ...baseInput,
      hook_event_name: "preToolUse"
    })
    await runHook(installation.scriptPath, workspace, server.baseUrl, {
      ...baseInput,
      hook_event_name: "postToolUseFailure",
      duration_ms: 29,
      failure_type: "execution"
    })

    expect(server.bodies).toHaveLength(2)
    expect(server.bodies[0]).toMatchObject({
      agent: "cursor",
      hookEvent: "PreToolUse",
      toolUseId: "cursor-tool-1",
      command: "pnpm test"
    })
    expect(server.bodies[1]).toMatchObject({
      hookEvent: "PostToolUseFailure",
      toolUseId: "cursor-tool-1",
      exitCode: 1,
      durationMs: 29
    })

    await closeServer(server.server)
    rmSync(workspace, { recursive: true, force: true })
  })

  it("rejects a symbolic-link Cursor directory without writing outside the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "own-harness-cursor-path-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-cursor-outside-"))
    const marker = join(outside, "hooks.json")
    writeFileSync(marker, "unchanged", "utf8")
    symlinkSync(outside, join(workspace, ".cursor"))

    expect(() => installCursorProjectHooks(workspace)).toThrow("Unsafe directory component")
    expect(readFileSync(marker, "utf8")).toBe("unchanged")
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it("rejects symbolic-link Cursor hook targets", () => {
    const workspace = mkdtempSync(join(tmpdir(), "own-harness-cursor-target-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-cursor-target-outside-"))
    mkdirSync(join(workspace, ".cursor"), { recursive: true })
    const marker = join(outside, "hooks.json")
    writeFileSync(marker, "{}", "utf8")
    symlinkSync(marker, join(workspace, ".cursor", "hooks.json"))

    expect(() => installCursorProjectHooks(workspace)).toThrow("symbolic link")
    expect(readFileSync(marker, "utf8")).toBe("{}")
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
})

function runHook(
  scriptPath: string,
  cwd: string,
  baseUrl: string,
  input: Readonly<Record<string, unknown>>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env, HARNESS_INGEST_URL: baseUrl },
      stdio: ["pipe", "pipe", "pipe"]
    })
    let errorOutput = ""
    child.stderr?.on("data", (chunk) => {
      errorOutput += chunk.toString()
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Cursor hook exited with ${String(code)}: ${errorOutput}`))
    })
    child.stdin?.end(JSON.stringify(input))
  })
}

async function createIngestServer(): Promise<{
  readonly server: Server
  readonly baseUrl: string
  readonly bodies: Array<Record<string, unknown>>
}> {
  const bodies: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (chunk) => {
      raw += chunk.toString()
    })
    request.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>)
      response.writeHead(201, { "content-type": "application/json" })
      response.end(JSON.stringify({ status: "ok" }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("ingest server did not bind to a port")
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, bodies }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })
}
