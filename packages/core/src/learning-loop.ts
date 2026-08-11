import type { OptimizationProposal, OptimizationProposalKind } from "@own-harness/contracts"
import type { ProviderKind } from "@own-harness/contracts"
import type { HarnessStore } from "./store.js"
import { randomId } from "./hash.js"
import { isoNow } from "./time.js"
import { PolicyValidationError } from "./errors.js"
import { parsePolicyConfig } from "./policy-engine.js"
import type { PolicyRule } from "./policy-types.js"

export interface LearningLoop {
  readonly optimize: (since: string) => string[]
  readonly getProposal: (proposalId: string) => OptimizationProposal | undefined
  readonly listProposals: () => OptimizationProposal[]
  readonly approveProposal: (proposalId: string) => void
  readonly rejectProposal: (proposalId: string) => void
  readonly applyProposal: (proposalId: string, policy: string) => string
  readonly markProposalApplied: (proposalId: string) => void
  readonly proposalRule: (proposalId: string) => PolicyRule
  readonly hasOpenProposal: (kind: OptimizationProposalKind, evidence: string) => boolean
}

export function createLearningLoop(store: HarnessStore): LearningLoop {
  return {
    optimize: (since) => {
      const requests = store.listRequestsSince(since)
      const tools = store.listToolCallsSince(since).map((tool) => ({
        sessionId: tool.sessionId,
        commandHash: tool.commandHash,
        command: tool.command,
        tool: tool.tool,
        status: tool.status
      }))
      const proposalIds: string[] = []
      const supportedProposalKinds = new Set<OptimizationProposalKind>([
        "cache",
        "deny",
        "budget",
        "route",
        "prompt"
      ])

      const repeatedRequests = repeatedBy(requests.map((request) => request.inputHash))
      for (const [hash, count] of repeatedRequests) {
        const evidence = `repeated-request:${hash}`
        if (count >= 3 && supportedProposalKinds.has("cache") && !store.hasOpenProposal("cache", evidence)) {
          proposalIds.push(createProposal(store, {
            kind: "cache",
            evidence,
            impact: `Enable exact-match cache for ${count} repeated requests`,
            ruleType: "request",
            rule: {
              type: "request",
              id: `cache-${hash.slice(0, 8)}`,
              match: {
                providers: ["anthropic", "openai"]
              },
              action: "cache",
              reason: "Repeated request detected by learning loop",
              config: {
                ttlMinutes: 60,
                exactOnly: true
              }
            }
          }))
        }
      }

      const deniedCommandGroups = groupBlockedToolCallsBySelector(tools)
      for (const deniedTools of deniedCommandGroups.values()) {
        if (!supportedProposalKinds.has("deny")) {
          continue
        }
        const firstCall = deniedTools[0]
        if (firstCall === undefined) {
          continue
        }
        const commandRegex = exactCommandRegex(firstCall.command)
        if (commandRegex === undefined) {
          continue
        }
        const toolName = firstCall.tool
        const evidence = `blocked-command:${toolName}:${firstCall.commandHash}`
        if (!store.hasOpenProposal("deny", evidence)) {
          proposalIds.push(createProposal(store, {
            kind: "deny",
            evidence,
            impact: `Blocked ${deniedTools.length} calls for tool ${toolName}`,
            ruleType: "tool",
            rule: {
              type: "tool",
              id: `deny-${firstCall.commandHash.slice(0, 16)}`,
              match: {
                tools: [toolName],
                commandRegex
              },
              action: "deny",
              reason: `Blocked command for tool ${toolName} detected by learning loop`
            }
          }))
        }
      }

      const totalCost = sum(requests.map((request) => request.costUsd))
      if (totalCost > 5 && supportedProposalKinds.has("budget")) {
        const evidence = "budget:total"
        if (!store.hasOpenProposal("budget", evidence)) {
          proposalIds.push(createProposal(store, {
            kind: "budget",
            evidence,
            impact: `Total cost $${totalCost.toFixed(4)} exceeds budget`,
            ruleType: "session",
            rule: {
              type: "session",
              id: "budget-total-cost",
              match: {
                project: "*"
              },
              action: "budget",
              reason: "Total cost threshold detected by learning loop",
              config: {
                maxUsd: 5
              }
            }
          }))
        }
      }

      const providerGroups = groupRequestsByProvider(requests)
      for (const [provider, providerRequests] of providerGroups) {
        const providerCost = sum(providerRequests.map((request) => request.costUsd))
        if (providerRequests.length < 10 || providerCost <= 1) {
          continue
        }
        const routeTarget = compatibleRouteTarget(provider)
        if (routeTarget === undefined) {
          continue
        }
        const evidence = `provider-cost:${provider}`
        if (!store.hasOpenProposal("route", evidence)) {
          proposalIds.push(createProposal(store, {
            kind: "route",
            evidence,
            impact: `Total cost $${providerCost.toFixed(4)} on ${provider}`,
            ruleType: "request",
            rule: {
              type: "request",
              id: `route-${provider}-cost`,
              match: {
                providers: [provider]
              },
              action: "route",
              reason: "High provider cost detected by learning loop",
              config: {
                routeTo: routeTarget
              }
            }
          }))
        }
      }

      const reliabilityGroups = groupRequestsByProvider(requests)
      for (const [provider, providerRequests] of reliabilityGroups) {
        if (providerRequests.length < 10) {
          continue
        }
        const errorRate = errorRateForRequests(providerRequests)
        const averageDurationMs = averageDurationForRequests(providerRequests)
        if (errorRate < 0.2 && averageDurationMs < 15000) {
          continue
        }
        const routeTarget = compatibleRouteTarget(provider)
        if (routeTarget === undefined) {
          continue
        }
        const evidence = `provider-reliability:${provider}`
        if (!store.hasOpenProposal("route", evidence)) {
          proposalIds.push(createProposal(store, {
            kind: "route",
            evidence,
            impact: `Error rate: ${(errorRate * 100).toFixed(1)}%, average duration: ${averageDurationMs.toFixed(1)}ms`,
            ruleType: "request",
            rule: {
              type: "request",
              id: `route-${provider}-reliability`,
              match: {
                providers: [provider]
              },
              action: "route",
              reason: "High error rate or latency detected by learning loop",
              config: {
                routeTo: routeTarget
              }
            }
          }))
        }
      }

      const promptRequestGroups = groupRequestsByInputHash(requests)
      for (const [inputHash, promptRequests] of promptRequestGroups) {
        if (promptRequests.length < 3 || inputHash === "") {
          continue
        }
        const averageCost = sum(promptRequests.map((request) => request.costUsd)) / promptRequests.length
        if (averageCost < 0.01) {
          continue
        }
        const evidence = `repeated-prompt:${inputHash}`
        if (!store.hasOpenProposal("prompt", evidence)) {
          proposalIds.push(createProposal(store, {
            kind: "prompt",
            evidence,
            impact: `Average cost $${averageCost.toFixed(4)} per repeated prompt`,
            ruleType: "request",
            rule: {
              type: "request",
              id: `prompt-${inputHash.slice(0, 8)}`,
              match: {
                providers: ["anthropic", "openai"]
              },
              action: "compress",
              reason: "Repeated prompt detected by learning loop",
              config: {
                maxChars: 4000
              }
            }
          }))
        }
      }

      return proposalIds
    },
    getProposal: (proposalId) => store.getProposal(proposalId),
    listProposals: () => store.listProposals(),
    approveProposal: (proposalId) => {
      store.updateProposalStatus(proposalId, "approved")
    },
    rejectProposal: (proposalId) => {
      store.updateProposalStatus(proposalId, "rejected")
    },
    markProposalApplied: (proposalId) => {
      store.updateProposalStatus(proposalId, "applied")
    },
    proposalRule: (proposalId) => proposalRule(store, proposalId),
    hasOpenProposal: (kind: OptimizationProposalKind, evidence: string) => store.hasOpenProposal(kind, evidence),
    applyProposal: (proposalId, policySource) => {
      const proposal = store.getProposal(proposalId)
      if (proposal === undefined) {
        throw new PolicyValidationError(`Proposal not found: ${proposalId}`)
      }
      if (proposal.status !== "approved") {
        throw new PolicyValidationError(
          `Proposal ${proposalId} must be approved before it can be applied; current status: ${proposal.status}`
        )
      }
      const rule = proposalRule(store, proposalId)
      const policy = parsePolicyConfig(policySource)
      const nextRules = replaceOrAppendRule(policy.rules, rule)
      const nextSource = JSON.stringify({
        version: policy.version,
        mode: policy.mode,
        defaultAction: policy.defaultAction,
        project: policy.project,
        rules: nextRules
      })
      parsePolicyConfig(nextSource)
      return nextSource
    }
  }
}

interface ToolCallForLearning {
  readonly sessionId: string
  readonly commandHash: string
  readonly command: string
  readonly tool: string
  readonly status: "ok" | "blocked" | "error" | "unsupported"
}

interface RequestForLearning {
  readonly sessionId: string
  readonly provider: ProviderKind
  readonly inputHash: string
  readonly costUsd: number
  readonly durationMs: number
  readonly status: "ok" | "blocked" | "error" | "unsupported"
}

function groupBlockedToolCallsBySelector(calls: readonly ToolCallForLearning[]): Map<string, ToolCallForLearning[]> {
  const groups = new Map<string, ToolCallForLearning[]>()
  for (const call of calls) {
    if (call.status !== "blocked" || call.commandHash === "") {
      continue
    }
    const key = `${call.tool}\u0000${call.commandHash}`
    const list = groups.get(key) ?? []
    list.push(call)
    groups.set(key, list)
  }
  return groups
}

function exactCommandRegex(command: string): string | undefined {
  if (command.length === 0 || command.length > 4096 || command.includes("[REDACTED]")) {
    return undefined
  }
  return `^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
}

function compatibleRouteTarget(provider: ProviderKind): ProviderKind | undefined {
  const target: ProviderKind = "openai-compatible"
  if (provider === target || providerWireProtocol(provider) !== providerWireProtocol(target)) {
    return undefined
  }
  return target
}

function providerWireProtocol(provider: ProviderKind): "anthropic-messages" | "openai-responses" | "openai-chat" {
  if (provider === "anthropic") {
    return "anthropic-messages"
  }
  if (provider === "openai") {
    return "openai-responses"
  }
  return "openai-chat"
}

function groupRequestsByProvider(requests: readonly RequestForLearning[]): Map<ProviderKind, RequestForLearning[]> {
  const groups = new Map<ProviderKind, RequestForLearning[]>()
  for (const request of requests) {
    const list = groups.get(request.provider) ?? []
    list.push(request)
    groups.set(request.provider, list)
  }
  return groups
}

function groupRequestsByInputHash(requests: readonly RequestForLearning[]): Map<string, RequestForLearning[]> {
  const groups = new Map<string, RequestForLearning[]>()
  for (const request of requests) {
    const list = groups.get(request.inputHash) ?? []
    list.push(request)
    groups.set(request.inputHash, list)
  }
  return groups
}

function errorRateForRequests(requests: readonly RequestForLearning[]): number {
  const errors = requests.filter((request) => request.status === "error").length
  return errors / requests.length
}

function averageDurationForRequests(requests: readonly RequestForLearning[]): number {
  return sum(requests.map((request) => request.durationMs)) / requests.length
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function repeatedBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

function createProposal(
  store: HarnessStore,
  proposal: {
    readonly kind: OptimizationProposalKind
    readonly evidence: string
    readonly impact: string
    readonly ruleType: "tool" | "request" | "session"
    readonly rule: PolicyRule
  }
): string {
  const id = randomId()
  store.insertProposal({
    id,
    kind: proposal.kind,
    evidence: proposal.evidence,
    impact: proposal.impact,
    ruleJson: JSON.stringify(proposal.rule),
    ruleType: proposal.ruleType,
    status: "pending",
    createdAt: isoNow()
  })
  return id
}

function proposalRule(store: HarnessStore, proposalId: string): PolicyRule {
  const proposal = store.getProposal(proposalId)
  if (proposal === undefined) {
    throw new PolicyValidationError(`Proposal not found: ${proposalId}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(proposal.ruleJson)
  } catch {
    throw new PolicyValidationError(`Proposal rule is not valid JSON: ${proposalId}`)
  }
  const rule = parsePolicyRule(parsed)
  return rule
}

function parsePolicyRule(source: unknown): PolicyRule {
  const policy = parsePolicyConfig(JSON.stringify({
    version: 1,
    mode: "enforce",
    defaultAction: "allow",
    project: "*",
    rules: [source]
  }))
  const rule = policy.rules[0]
  if (rule === undefined) {
    throw new PolicyValidationError("Proposal rule is empty")
  }
  return rule
}

function replaceOrAppendRule(rules: readonly PolicyRule[], next: PolicyRule): PolicyRule[] {
  const exists = rules.some((rule) => rule.id === next.id)
  if (!exists) {
    return [...rules, next]
  }
  return rules.map((rule) => (rule.id === next.id ? next : rule))
}
