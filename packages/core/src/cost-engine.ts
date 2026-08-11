import type { ProviderKind } from "@own-harness/contracts"
import type { PricingCatalog } from "./pricing-catalog.js"

export interface CostOptimizationSuggestion {
  readonly kind: "compress" | "cache" | "route" | "budget"
  readonly evidence: string
  readonly impact: string
}

export function suggestCostOptimizations(
  _pricing: PricingCatalog,
  requests: Array<{
    readonly provider: ProviderKind
    readonly model: string
    readonly tokensIn: number
    readonly tokensOut: number
    readonly inputHash: string
    readonly costUsd: number
  }>,
  toolCalls: Array<{
    readonly command: string
    readonly commandHash: string
    readonly costUsd: number
  }>
): CostOptimizationSuggestion[] {
  const suggestions: CostOptimizationSuggestion[] = []
  const repeatedRequests = groupBy(requests, (request) => request.inputHash)

  for (const [inputHash, sameRequests] of repeatedRequests) {
    if (sameRequests.length >= 3 && inputHash !== "") {
      const totalCost = sum(sameRequests.map((request) => request.costUsd))
      suggestions.push({
        kind: "cache",
        evidence: `repeated-request:${inputHash}`,
        impact: `Estimated savings $${totalCost.toFixed(4)} from ${sameRequests.length} requests`
      })
    }
  }

  const repeatedTools = groupBy(toolCalls, (call) => call.commandHash)
  for (const [commandHash, sameCalls] of repeatedTools) {
    if (sameCalls.length >= 5 && commandHash !== "") {
      const totalCost = sum(sameCalls.map((call) => call.costUsd))
      suggestions.push({
        kind: "compress",
        evidence: `repeated-tool:${commandHash}`,
        impact: `Estimated savings $${totalCost.toFixed(4)} from ${sameCalls.length} calls`
      })
    }
  }

  const byProvider = groupBy(requests, (request) => request.provider)
  for (const [provider, providerRequests] of byProvider) {
    const total = sum(providerRequests.map((request) => request.costUsd))
    if (providerRequests.length >= 10 && total > 1) {
      suggestions.push({
        kind: "route",
        evidence: `provider-cost:${provider}`,
        impact: `Total cost $${total.toFixed(4)} on ${provider}`
      })
    }
  }

  const totalCost = sum(requests.map((request) => request.costUsd))
  if (totalCost > 5) {
    suggestions.push({
      kind: "budget",
      evidence: "budget:total",
      impact: `Total cost $${totalCost.toFixed(4)} exceeds the budget`
    })
  }

  return suggestions
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const value = key(item)
    const list = map.get(value) ?? []
    list.push(item)
    map.set(value, list)
  }
  return map
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
