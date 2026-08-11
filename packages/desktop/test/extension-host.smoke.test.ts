import { describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { createCursorExtension } from "../src/cursor-extension.js"
import { createVscodeExtension } from "../src/vscode-extension.js"
import type { ExtensionApiLike } from "../src/extension-host.js"

describe("IDE extension host", () => {
  it("activates a command and reports tool events through the ingest endpoint", async () => {
    const server = await createIngestServer()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const api = fakeApi(registered)
    const extension = createVscodeExtension(api, {
      ingestUrl: server.baseUrl,
      sessionId: "session-vscode",
      projectHash: "project-vscode"
    })
    const registration = extension.activate()
    expect(extension.api.capabilities).toEqual({
      globalToolObservation: false,
      typedLifecycleApi: true,
      cursorProjectHooks: false
    })
    const listener = registered.get("own-harness.reportTool")
    if (listener === undefined) {
      throw new Error("reportTool command was not registered")
    }
    await listener({
      tool: "Bash",
      command: "npm test",
      durationMs: 40,
      exitCode: 1
    })
    expect(server.bodies).toHaveLength(1)
    expect(server.bodies[0]).toMatchObject({
      tool: "Bash",
      command: "npm test",
      agent: "vscode",
      sessionId: "session-vscode",
      projectHash: "project-vscode",
      durationMs: 40,
      exitCode: 1
    })
    registration.dispose()
    await closeServer(server.server)
  })

  it("uses the cursor agent kind through the shared host", async () => {
    const server = await createIngestServer()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const extension = createCursorExtension(fakeApi(registered), {
      ingestUrl: server.baseUrl,
      sessionId: "session-cursor",
      projectHash: "project-cursor"
    })
    extension.activate()
    expect(extension.api.capabilities.cursorProjectHooks).toBe(true)
    const listener = registered.get("own-harness.reportTool")
    if (listener === undefined) {
      throw new Error("reportTool command was not registered")
    }
    await listener({ tool: "Bash", command: "git status" })
    expect(server.bodies[0]).toMatchObject({
      agent: "cursor",
      sessionId: "session-cursor",
      projectHash: "project-cursor"
    })
    await closeServer(server.server)
  })

  it("exposes interception status and a typed correlated lifecycle API", async () => {
    const server = await createIngestServer()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const extension = createVscodeExtension(fakeApi(registered), {
      ingestUrl: server.baseUrl,
      sessionId: "session-vscode",
      projectHash: "project-vscode"
    })
    extension.activate()
    const status = registered.get("own-harness.interceptionStatus")?.()
    expect(status).toEqual({
      apiVersion: 1,
      agent: "vscode",
      capabilities: {
        globalToolObservation: false,
        typedLifecycleApi: true,
        cursorProjectHooks: false
      }
    })
    await extension.api.reportTool({
      tool: "Bash",
      command: "pnpm build",
      hookEvent: "PreToolUse",
      toolUseId: "vscode-tool-1"
    })
    expect(server.bodies[0]).toMatchObject({
      hookEvent: "PreToolUse",
      toolUseId: "vscode-tool-1"
    })
    await closeServer(server.server)
  })

  it("rejects malformed tool events", async () => {
    const server = await createIngestServer()
    const registered = new Map<string, (...args: unknown[]) => unknown>()
    const extension = createVscodeExtension(fakeApi(registered), {
      ingestUrl: server.baseUrl,
      sessionId: "session-vscode",
      projectHash: "project-vscode"
    })
    extension.activate()
    const listener = registered.get("own-harness.reportTool")
    if (listener === undefined) {
      throw new Error("reportTool command was not registered")
    }
    await expect(listener({ command: "missing tool" })).rejects.toThrow("requires tool and command")
    expect(server.bodies).toHaveLength(0)
    await closeServer(server.server)
  })
})

function fakeApi(registered: Map<string, (...args: unknown[]) => unknown>): ExtensionApiLike {
  return {
    commands: {
      registerCommand: (command, listener) => {
        registered.set(command, listener)
        return { dispose: () => registered.delete(command) }
      }
    }
  }
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
    server.close((error) => {
      if (error !== undefined) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
