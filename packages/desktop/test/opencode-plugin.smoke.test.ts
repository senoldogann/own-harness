import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:http"
import { createOpenCodeHarnessPlugin } from "../src/opencode-plugin.js"

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

describe("OpenCode plugin", () => {
  it("posts before and after tool events to the ingest endpoint", async () => {
    const server = await createIngestServer()
    setEnv("HARNESS_BASE_URL", server.baseUrl)
    setEnv("HARNESS_SESSION_ID", "session-opencode")
    setEnv("HARNESS_PROJECT_HASH", "project-opencode")
    const plugin = createOpenCodeHarnessPlugin()
    await plugin.hooks["tool.execute.before"]({
      tool: "Bash",
      sessionID: "opencode-session",
      callID: "call-1"
    }, {
      args: { command: "git status" }
    })
    await plugin.hooks["tool.execute.after"]({
      tool: "Bash",
      sessionID: "opencode-session",
      callID: "call-1",
      args: { command: "git status" }
    }, {
      metadata: { exitCode: 0, durationMs: 12 }
    })
    expect(server.bodies).toHaveLength(2)
    expect(server.bodies[0]).toMatchObject({
      tool: "Bash",
      command: "git status",
      agent: "opencode",
      projectHash: "project-opencode"
    })
    expect(server.bodies[0]?.exitCode).toBeNull()
    expect(server.bodies[0]?.hookEvent).toBe("PreToolUse")
    expect(server.bodies[0]?.toolUseId).toBe("call-1")
    expect(server.bodies[1]?.exitCode).toBe(0)
    expect(server.bodies[1]?.durationMs).toBe(12)
    expect(server.bodies[1]?.hookEvent).toBe("PostToolUse")
    expect(server.bodies[1]?.toolUseId).toBe("call-1")
    await closeServer(server.server)
  })

  it("reports nonzero tool results as correlated failures", async () => {
    const server = await createIngestServer()
    setEnv("HARNESS_BASE_URL", server.baseUrl)
    const plugin = createOpenCodeHarnessPlugin()
    await plugin.hooks["tool.execute.before"]({
      tool: "Bash",
      sessionID: "opencode-session",
      callID: "call-failed"
    }, {
      args: { command: "false" }
    })
    await plugin.hooks["tool.execute.after"]({
      tool: "Bash",
      sessionID: "opencode-session",
      callID: "call-failed",
      args: { command: "false" }
    }, {
      metadata: { exitCode: 7, durationMs: 9 }
    })

    expect(server.bodies[1]).toMatchObject({
      hookEvent: "PostToolUseFailure",
      toolUseId: "call-failed",
      exitCode: 7,
      durationMs: 9
    })
    await closeServer(server.server)
  })

  it("reports tool-state errors even when tool.execute.after is omitted", async () => {
    const server = await createIngestServer()
    setEnv("HARNESS_BASE_URL", server.baseUrl)
    const plugin = createOpenCodeHarnessPlugin()
    await plugin.hooks["tool.execute.before"]({
      tool: "Bash",
      sessionID: "opencode-session",
      callID: "call-error-event"
    }, {
      args: { command: "exit 23" }
    })
    await plugin.hooks.event({
      event: {
        type: "message.part.updated",
        properties: {
          sessionID: "opencode-session",
          part: {
            type: "tool",
            callID: "call-error-event",
            tool: "Bash",
            state: {
              status: "error",
              input: { command: "exit 23" },
              metadata: { exitCode: 23 },
              time: { start: 100, end: 137 }
            }
          }
        }
      }
    })
    await plugin.hooks["tool.execute.after"]({
      tool: "Bash",
      sessionID: "opencode-session",
      callID: "call-error-event",
      args: { command: "exit 23" }
    }, {
      metadata: { exitCode: 23, durationMs: 37 }
    })

    expect(server.bodies).toHaveLength(2)
    expect(server.bodies[1]).toMatchObject({
      hookEvent: "PostToolUseFailure",
      toolUseId: "call-error-event",
      exitCode: 23,
      durationMs: 37
    })
    await closeServer(server.server)
  })
})

function setEnv(key: string, value: string): void {
  previousEnv.set(key, process.env[key])
  process.env[key] = value
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
