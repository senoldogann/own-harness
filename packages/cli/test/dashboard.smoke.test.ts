import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { request as httpRequest } from "node:http"
import { HarnessStore } from "@own-harness/core"
import { createDashboardServer } from "../src/commands/dashboard.js"
import { initProject } from "../src/bootstrap.js"
import { readTextFile, writeTextFile } from "../src/fs-utils.js"

const PROPOSAL_ID = "aaaaaaaaaaaaaaaaaaaaaaaa"

describe("dashboard server", () => {
  it("rejects non-loopback dashboard hosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-dashboard-host-"))
    process.env.HARNESS_HOME = dir
    initProject(dir)
    await expect(createDashboardServer(dir, "0.0.0.0", 0, false)).rejects.toThrow(
      "Dashboard host must be 127.0.0.1"
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it("requires management auth for dashboard reads and proposal workflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-dashboard-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    seedStore(dir)

    const dashboard = await createDashboardServer(dir, "127.0.0.1", 0, true)
    const baseUrl = `http://127.0.0.1:${dashboard.port}`
    const managementToken = readTextFile(join(dir, "auth-token")).trim()
    const authorization = `Basic ${Buffer.from(`own-harness:${managementToken}`).toString("base64")}`
    const authenticatedHeaders = { authorization }
    try {
      const health = await fetch(`${baseUrl}/health`)
      expect(health.status).toBe(200)

      expect(await requestWithHost(dashboard.port, "attacker.example")).toBe(400)

      const crossOrigin = await fetch(`${baseUrl}/api/v1/sessions`, {
        headers: { ...authenticatedHeaders, origin: "https://attacker.example" }
      })
      expect(crossOrigin.status).toBe(400)

      const unauthenticatedPage = await fetch(`${baseUrl}/`)
      expect(unauthenticatedPage.status).toBe(401)
      expect(unauthenticatedPage.headers.get("www-authenticate")).toContain("Basic")

      const unauthenticatedSessions = await fetch(`${baseUrl}/api/v1/sessions`)
      expect(unauthenticatedSessions.status).toBe(401)

      const page = await fetch(`${baseUrl}/`, { headers: authenticatedHeaders })
      expect(page.status).toBe(200)
      const html = await page.text()
      expect(html).toContain("own-harness")
      expect(html).toContain("Proposals")
      expect(html).toContain("Raw commands")

      const proposals = await (await fetch(`${baseUrl}/api/v1/proposals`, {
        headers: authenticatedHeaders
      })).json() as {
        proposals: Array<{ id: string }>
      }
      expect(proposals.proposals[0]?.id).toBe(PROPOSAL_ID)

      const locked = await fetch(`${baseUrl}/api/v1/tools`)
      expect(locked.status).toBe(401)

      const raw = await (await fetch(`${baseUrl}/api/v1/tools?raw=true`, {
        headers: authenticatedHeaders
      })).json() as {
        tools: Array<{ command: string }>
      }
      expect(raw.tools[0]?.command).toBe("git status")

      const approve = await fetch(`${baseUrl}/api/v1/proposals/${PROPOSAL_ID}/approve`, {
        method: "POST",
        headers: authenticatedHeaders
      })
      expect(approve.status).toBe(200)
      const apply = await fetch(`${baseUrl}/api/v1/proposals/${PROPOSAL_ID}/apply`, {
        method: "POST",
        headers: authenticatedHeaders
      })
      expect(apply.status).toBe(200)
      expect(readTextFile(join(dir, ".harness", "policies", "default.yaml"))).toContain("cache-test-rule")

      const lockedMutation = await fetch(`${baseUrl}/api/v1/proposals/${PROPOSAL_ID}/reject`, { method: "POST" })
      expect(lockedMutation.status).toBe(401)
    } finally {
      await dashboard.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function seedStore(dir: string): void {
  const store = new HarnessStore({ dbPath: join(dir, "state.db") })
  const projectId = store.findOrCreateProject("abc", "demo")
  store.insertSession({
    id: "session-1",
    projectId,
    agent: "codex",
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null
  })
  store.insertRequest({
    id: "request-1",
    sessionId: "session-1",
    agent: "codex",
    provider: "openai",
    projectHash: "abc",
    model: "gpt-5",
    inputHash: "in",
    outputHash: "out",
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.01,
    cacheHit: false,
    decisionId: "default",
    durationMs: 120,
    status: "ok",
    createdAt: new Date().toISOString()
  })
  store.insertToolCall({
    id: "tool-1",
    sessionId: "session-1",
    agent: "codex",
    projectHash: "abc",
    tool: "Bash",
    command: "git status",
    commandHash: "hash",
    exitCode: 0,
    durationMs: 10,
    status: "ok"
  })
  store.insertProposal({
    id: PROPOSAL_ID,
    kind: "cache",
    evidence: "3 tekrar eden request abc12345",
    impact: "Exact-match cache acilabilir",
    ruleJson: JSON.stringify({
      type: "request",
      id: "cache-test-rule",
      match: {
        providers: ["anthropic"]
      },
      action: "cache",
      reason: "Repeated request detected by learning loop",
      config: {
        ttlMinutes: 60,
        exactOnly: true
      }
    }),
    ruleType: "request",
    status: "pending",
    createdAt: new Date().toISOString()
  })
  store.close()
}

function configWithLocalStore(dir: string): string {
  process.env.HARNESS_HOME = dir
  return `version: 1
proxy:
  host: "127.0.0.1"
  port: 4103
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

function requestWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/api/v1/sessions",
      headers: { host }
    }, (response) => {
      response.resume()
      response.once("end", () => resolve(response.statusCode ?? 0))
    })
    request.once("error", reject)
    request.end()
  })
}
