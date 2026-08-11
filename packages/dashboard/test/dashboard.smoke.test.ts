import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:http"
import { HarnessStore } from "@own-harness/core"
import { escapeHtml, renderDashboardHtml, renderRemoteDashboardHtml } from "../src/index.js"

describe("dashboard render", () => {
  it("renders dashboard content and escapes dynamic strings", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-dashboard-render-"))
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
    store.insertToolCall({
      id: "tool-1",
      sessionId: "session-1",
      agent: "codex",
      projectHash: "abc",
      tool: "<script>alert(1)</script>",
      command: "git status",
      commandHash: "hash",
      exitCode: 0,
      durationMs: 10,
      status: "ok"
    })
    store.insertProposal({
      id: "proposal-1",
      kind: "cache",
      evidence: "evidence",
      impact: "impact",
      ruleJson: "{}",
      ruleType: "request",
      status: "pending",
      createdAt: new Date().toISOString()
    })
    store.close()

    const html = renderDashboardHtml({ storePath: join(dir, "state.db"), debugEnabled: false })
    expect(html).toContain("own-harness")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("\\u003cscript")
    expect(escapeHtml(`<b>"x"</b>`)).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;")
    rmSync(dir, { recursive: true, force: true })
  })

  it("renders a read-only dashboard from a remote API", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const payload = remotePayload(url.pathname)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(payload))
    })
    await listen(server)
    const address = server.address()
    if (address === null || typeof address === "string") {
      throw new Error("dashboard remote server did not bind")
    }
    try {
      const html = await renderRemoteDashboardHtml({ serverUrl: `http://127.0.0.1:${address.port}` })
      expect(html).toContain("Read only")
      expect(html).toContain("remote-proposal")
      expect(html).toContain("remote-tool")
    } finally {
      await close(server)
    }
  })
})

function remotePayload(pathname: string): unknown {
  if (pathname === "/api/v1/stats/summary") {
    return {
      totalRequests: 1,
      totalTokensIn: 10,
      totalTokensOut: 5,
      totalCostUsd: 0.01,
      cacheHitRate: 0,
      estimatedSavingsUsd: 0,
      errorRate: 0,
      averageDurationMs: 100,
      blockedCount: 0,
      auditCount: 0,
      byAgent: { codex: 1 }
    }
  }
  if (pathname === "/api/v1/sessions") {
    return { sessions: [] }
  }
  if (pathname === "/api/v1/requests") {
    return { requests: [] }
  }
  if (pathname === "/api/v1/proposals") {
    return {
      proposals: [{
        id: "remote-proposal",
        kind: "cache",
        evidence: "remote evidence",
        impact: "remote impact",
        ruleJson: "{}",
        ruleType: "request",
        status: "pending",
        createdAt: "2026-08-10T00:00:00Z"
      }]
    }
  }
  if (pathname === "/api/v1/stats/tools-summary") {
    return {
      tools: [{
        tool: "remote-tool",
        count: 1,
        totalCostUsd: 0,
        averageDurationMs: 1,
        errorCount: 0,
        commandHashes: ["hash"]
      }]
    }
  }
  if (pathname === "/api/v1/stats/cost-summary") {
    return { costs: [] }
  }
  return {}
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
}

function close(server: Server): Promise<void> {
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
