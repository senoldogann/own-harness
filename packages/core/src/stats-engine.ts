import type { CostRecord, RequestRecord, ToolCallRecord } from "@own-harness/contracts"
import type { HarnessStore } from "./store.js"

export interface StatsEngine {
  readonly summary: () => {
    readonly totalRequests: number
    readonly totalTokensIn: number
    readonly totalTokensOut: number
    readonly totalCostUsd: number
    readonly cacheHitRate: number
    readonly estimatedSavingsUsd: number
    readonly errorRate: number
    readonly averageDurationMs: number
    readonly blockedCount: number
    readonly auditCount: number
    readonly byAgent: Record<string, number>
  }
  readonly toolStats: () => Array<{
    readonly tool: string
    readonly count: number
    readonly totalCostUsd: number
    readonly averageDurationMs: number
    readonly errorCount: number
    readonly commandHashes: string[]
  }>
  readonly costStats: () => Array<{
    readonly provider: string
    readonly model: string
    readonly totalCostUsd: number
    readonly totalTokens: number
    readonly requestCount: number
  }>
}

export function createStatsEngine(store: HarnessStore): StatsEngine {
  return {
    summary: () => {
      const since = "1970-01-01T00:00:00Z"
      const totalRequests = store.countRequestsSince(since)
      const totalTokensIn = store.sumTokensInSince(since)
      const totalTokensOut = store.sumTokensOutSince(since)
      const totalCostUsd = store.sumCostRecords()
      const cacheHits = store.countCacheHitsSince(since)
      const errors = store.countRequestsWithStatusSince("error", since)
      const averageDurationMs = store.averageDurationMsSince(since)
      const byAgent = store.countRequestsByAgentSince(since)
      return {
        totalRequests,
        totalTokensIn,
        totalTokensOut,
        totalCostUsd: round4(totalCostUsd),
        cacheHitRate: totalRequests === 0 ? 0 : cacheHits / totalRequests,
        estimatedSavingsUsd: store.sumCacheSavingsSince(since),
        errorRate: totalRequests === 0 ? 0 : errors / totalRequests,
        averageDurationMs,
        blockedCount: store.countBlockedRequests(),
        auditCount: store.countAuditDecisions(),
        byAgent
      }
    },
    toolStats: () => {
      const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
      const requests = store.listRequestsSince("1970-01-01T00:00:00Z")
      const sessionCosts = sessionCostBySession(requests)
      const sessionToolCounts = toolCountBySession(calls)
      const byTool = new Map<string, ToolCallRecord[]>()
      for (const call of calls) {
        const list = byTool.get(call.tool) ?? []
        list.push(call)
        byTool.set(call.tool, list)
      }
      return Array.from(byTool.entries()).map(([tool, toolCalls]) => ({
        tool,
        count: toolCalls.length,
        totalCostUsd: round4(sum(toolCalls.map((call) => estimateToolCost(call, sessionCosts, sessionToolCounts)))),
        averageDurationMs: toolCalls.length === 0 ? 0 : sum(toolCalls.map((call) => call.durationMs)) / toolCalls.length,
        errorCount: toolCalls.filter((call) => call.status === "error").length,
        commandHashes: Array.from(new Set(toolCalls.map((call) => call.commandHash)))
      }))
    },
    costStats: () => {
      const costs = store.listCostRecords()
      const byKey = new Map<string, CostRecord[]>()
      for (const cost of costs) {
        const key = `${cost.provider}:${cost.model}`
        const list = byKey.get(key) ?? []
        list.push(cost)
        byKey.set(key, list)
      }
      return Array.from(byKey.entries()).map(([key, records]) => {
        const [provider, model] = key.split(":")
        return {
          provider: provider ?? "",
          model: model ?? "",
          totalCostUsd: round4(sum(records.map((record) => record.costUsd))),
          totalTokens: sum(records.map((record) => record.tokensIn + record.tokensOut)),
          requestCount: records.length
        }
      })
    }
  }
}

function sessionCostBySession(requests: readonly RequestRecord[]): Map<string, number> {
  const costs = new Map<string, number>()
  for (const request of requests) {
    costs.set(request.sessionId, (costs.get(request.sessionId) ?? 0) + request.costUsd)
  }
  return costs
}

function toolCountBySession(calls: readonly ToolCallRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const call of calls) {
    counts.set(call.sessionId, (counts.get(call.sessionId) ?? 0) + 1)
  }
  return counts
}

function estimateToolCost(
  call: ToolCallRecord,
  sessionCosts: ReadonlyMap<string, number>,
  sessionToolCounts: ReadonlyMap<string, number>
): number {
  const sessionCost = sessionCosts.get(call.sessionId) ?? 0
  const toolCount = sessionToolCounts.get(call.sessionId) ?? 0
  if (toolCount === 0) {
    return 0
  }
  return sessionCost / toolCount
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
