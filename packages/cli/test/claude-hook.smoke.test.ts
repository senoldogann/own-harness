import { describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { initProject } from "../src/bootstrap.js"

describe("claude hook", () => {
  it("posts tool input to the harness ingest endpoint", async () => {
    const server = await createIngestServer()
    const scriptPath = join(process.cwd(), "..", "..", "scripts", "claude-hooks.sh")
    const result = await runScript(
      scriptPath,
      {
        CLAUDE_HOOK_TOOL_NAME: "Bash",
        CLAUDE_HOOK_TOOL_INPUT: JSON.stringify({ command: "git status" }),
        HARNESS_INGEST_URL: server.baseUrl,
        HARNESS_SESSION_ID: "session-claude",
        HARNESS_AGENT: "claude",
        HARNESS_PROJECT_HASH: "project-claude"
      }
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(server.bodies).toHaveLength(1)
    expect(server.bodies[0]).toMatchObject({
      tool: "Bash",
      command: "git status",
      sessionId: "session-claude",
      agent: "claude",
      projectHash: "project-claude"
    })
    await closeServer(server.server)
  })

  it("returns Claude deny JSON when harness denies a PreToolUse command", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "denied" }))
    })
    await listen(server)
    const baseUrl = serverUrl(server)
    const result = await runScript(
      join(process.cwd(), "..", "..", "scripts", "claude-hooks.sh"),
      {
        CLAUDE_HOOK_EVENT: "PreToolUse",
        CLAUDE_HOOK_TOOL_NAME: "Bash",
        CLAUDE_HOOK_TOOL_INPUT: JSON.stringify({ command: "rm -rf /" }),
        HARNESS_INGEST_URL: baseUrl,
        HARNESS_SESSION_ID: "session-claude",
        HARNESS_AGENT: "claude",
        HARNESS_PROJECT_HASH: "project-claude"
      }
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("permissionDecision")
    expect(result.stdout).toContain("deny")
    await closeServer(server)
  })

  it("reads the real Claude PreToolUse payload from stdin", async () => {
    const server = await createIngestServer()
    const payload = JSON.stringify({
      session_id: "session-real",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "git status"
      }
    })
    const result = await runScript(
      join(process.cwd(), "..", "..", "scripts", "claude-hooks.sh"),
      {
        CLAUDE_HOOK_EVENT: "PreToolUse",
        HARNESS_INGEST_URL: server.baseUrl,
        HARNESS_SESSION_ID: "session-real",
        HARNESS_AGENT: "claude",
        HARNESS_PROJECT_HASH: "project-claude"
      },
      payload
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(server.bodies[0]).toMatchObject({
      tool: "Bash",
      command: "git status",
      sessionId: "session-real"
    })
    await closeServer(server.server)
  })

  it("reads hook event from stdin and denies without the env override", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "denied" }))
    })
    await listen(server)
    const baseUrl = serverUrl(server)
    const payload = JSON.stringify({
      session_id: "session-real",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "rm -rf /"
      }
    })
    const result = await runScript(
      join(process.cwd(), "..", "..", "scripts", "claude-hooks.sh"),
      {
        HARNESS_INGEST_URL: baseUrl,
        HARNESS_SESSION_ID: "session-real",
        HARNESS_AGENT: "claude",
        HARNESS_PROJECT_HASH: "project-claude"
      },
      payload
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("permissionDecision")
    expect(result.stdout).toContain("deny")
    await closeServer(server)
  })

  it("correlates PreToolUse with successful and failed result events", async () => {
    const server = await createIngestServer()
    const stateDir = mkdtempSync(join(tmpdir(), "own-harness-hook-state-"))
    const scriptPath = join(process.cwd(), "..", "..", "scripts", "claude-hooks.sh")
    const env = {
      HARNESS_INGEST_URL: server.baseUrl,
      HARNESS_SESSION_ID: "session-result",
      HARNESS_AGENT: "claude",
      HARNESS_PROJECT_HASH: "project-result",
      HARNESS_HOOK_STATE_DIR: stateDir
    }
    const pre = JSON.stringify({
      session_id: "session-result",
      hook_event_name: "PreToolUse",
      tool_use_id: "toolu-success",
      tool_name: "Bash",
      tool_input: { command: "git status" }
    })
    const post = JSON.stringify({
      session_id: "session-result",
      hook_event_name: "PostToolUse",
      tool_use_id: "toolu-success",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: { stdout: "clean", stderr: "", interrupted: false, isImage: false }
    })
    expect((await runScript(scriptPath, env, pre)).code).toBe(0)
    expect((await runScript(scriptPath, env, post)).code).toBe(0)
    expect(server.bodies[0]).toMatchObject({
      hookEvent: "PreToolUse",
      toolUseId: "toolu-success",
      exitCode: null
    })
    expect(server.bodies[1]).toMatchObject({
      hookEvent: "PostToolUse",
      toolUseId: "toolu-success",
      exitCode: 0
    })
    expect(server.bodies[1]?.durationMs).toEqual(expect.any(Number))

    const failure = JSON.stringify({
      session_id: "session-result",
      hook_event_name: "PostToolUseFailure",
      tool_use_id: "toolu-failure",
      tool_name: "Bash",
      tool_input: { command: "false" },
      error: "Command exited with non-zero status code 7",
      duration_ms: 4187
    })
    expect((await runScript(scriptPath, env, failure)).code).toBe(0)
    expect(server.bodies[2]).toMatchObject({
      hookEvent: "PostToolUseFailure",
      toolUseId: "toolu-failure",
      exitCode: 7,
      durationMs: 4187
    })
    await closeServer(server.server)
    rmSync(stateDir, { recursive: true, force: true })
  })

  it("copies a working hook script into initialized projects", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "own-harness-init-hook-"))
    initProject(tempDir)
    const server = await createIngestServer()
    const result = await runScript(
      join(tempDir, ".harness", "hooks", "claude-hooks.sh"),
      {
        CLAUDE_HOOK_TOOL_NAME: "Bash",
        CLAUDE_HOOK_TOOL_INPUT: JSON.stringify({ command: "git status" }),
        HARNESS_INGEST_URL: server.baseUrl,
        HARNESS_SESSION_ID: "session-init",
        HARNESS_AGENT: "claude",
        HARNESS_PROJECT_HASH: "project-init"
      }
    )
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(server.bodies[0]).toMatchObject({
      tool: "Bash",
      command: "git status",
      sessionId: "session-init",
      agent: "claude",
      projectHash: "project-init"
    })
    await closeServer(server.server)
    rmSync(tempDir, { recursive: true, force: true })
  })
})

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
  await listen(server)
  return { server, baseUrl: serverUrl(server), bodies }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
}

function serverUrl(server: Server): string {
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind to a port")
  }
  return `http://127.0.0.1:${address.port}`
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

async function runScript(
  scriptPath: string,
  env: Record<string, string>,
  stdin = ""
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", [scriptPath], {
      env: { ...process.env, ...env }
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.end(stdin)
  })
}
