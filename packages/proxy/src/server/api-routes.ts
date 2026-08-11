import type { FastifyInstance } from "fastify"
import type { HarnessStore } from "@own-harness/core"
import { createPolicyBundle, createStatsEngine, isoNow } from "@own-harness/core"
import type { StatsSummary } from "@own-harness/contracts"
import type { ProxyOptions } from "./proxy-server.js"

export function registerManagementRoutes(app: FastifyInstance, options: ProxyOptions): void {
  app.get("/health", async () => ({ status: "ok" }))

  app.get("/api/hello", async () => ({ message: "hello" }))

  app.get("/api/v1/sessions", async () => ({
    sessions: options.store.listSessions()
  }))

  app.get("/api/v1/requests", async () => ({
    requests: options.store.listRequestsSince("1970-01-01T00:00:00Z")
  }))

  app.get("/api/v1/stats/summary", async () => {
    return buildSummary(options.store)
  })

  app.get("/api/v1/stats/tools", async () => {
    const calls = options.store.listToolCallsSince("1970-01-01T00:00:00Z")
    return {
      tools: calls.map((call) => ({
        id: call.id,
        sessionId: call.sessionId,
        agent: call.agent,
        projectHash: call.projectHash,
        tool: call.tool,
        commandHash: call.commandHash,
        exitCode: call.exitCode,
        durationMs: call.durationMs,
        status: call.status
      }))
    }
  })

  app.get("/api/v1/stats/cost", async () => ({
    costs: options.store.listCostRecords()
  }))

  app.get("/api/v1/proposals", async () => ({
    proposals: options.store.listProposals()
  }))

  app.get("/api/v1/policy/bundle", async (_request, reply) => {
    const secret = options.policySignatureSecret
    if (secret === undefined) {
      reply.status(503).send({ error: "Policy signature secret is not configured" })
      return
    }
    return createPolicyBundle(options.policy, secret, isoNow())
  })

  app.get("/api/v1/stats/tools-summary", async () => ({
    tools: createStatsEngine(options.store).toolStats()
  }))

  app.get("/api/v1/stats/cost-summary", async () => ({
    costs: createStatsEngine(options.store).costStats()
  }))
}

function buildSummary(store: HarnessStore): StatsSummary {
  const since = "1970-01-01T00:00:00Z"
  const totalRequests = store.countRequestsSince(since)
  const cacheHits = store.countCacheHitsSince(since)
  const errors = store.countRequestsWithStatusSince("error", since)
  return {
    totalRequests,
    totalTokensIn: store.sumTokensInSince(since),
    totalTokensOut: store.sumTokensOutSince(since),
    totalCostUsd: store.sumCostRecords(),
    cacheHitRate: totalRequests === 0 ? 0 : cacheHits / totalRequests,
    estimatedSavingsUsd: store.sumCacheSavingsSince(since),
    errorRate: totalRequests === 0 ? 0 : errors / totalRequests,
    averageDurationMs: store.averageDurationMsSince(since),
    blockedCount: store.countBlockedRequests(),
    auditCount: store.countAuditDecisions(),
    byAgent: store.countRequestsByAgentSince(since)
  }
}
