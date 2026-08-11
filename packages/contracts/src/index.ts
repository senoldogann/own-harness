import { z } from "zod"

export const AgentKindSchema = z.enum([
  "claude",
  "codex",
  "opencode",
  "vscode",
  "cursor",
  "chatgpt-desktop"
])

export type AgentKind = z.infer<typeof AgentKindSchema>

export const ProviderKindSchema = z.enum([
  "anthropic",
  "openai",
  "openai-compatible"
])

export type ProviderKind = z.infer<typeof ProviderKindSchema>

export const PolicyActionSchema = z.enum([
  "allow",
  "deny",
  "require",
  "rewrite",
  "compress",
  "cache",
  "redact",
  "budget",
  "route",
  "log"
])

export type PolicyAction = z.infer<typeof PolicyActionSchema>

export const PolicyModeSchema = z.enum(["audit", "enforce", "disabled"])

export type PolicyMode = z.infer<typeof PolicyModeSchema>

export const PolicyDecisionSchema = z.object({
  ruleId: z.string(),
  action: PolicyActionSchema,
  reason: z.string(),
  mode: PolicyModeSchema,
  config: z.object({
    ttlMinutes: z.number().int().positive().optional(),
    exactOnly: z.boolean().optional(),
    normalized: z.boolean().optional(),
    similarityThreshold: z.number().min(0.5).max(1).optional(),
    maxCandidates: z.number().int().positive().max(1000).optional(),
    maxLines: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    patterns: z.array(z.string()).optional(),
    maxUsd: z.number().positive().optional(),
    warnAt: z.number().min(0).max(1).optional(),
    blockAt: z.number().min(0).max(1).optional(),
    routeTo: ProviderKindSchema.optional()
  }).optional()
})

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>

export const RequestStatusSchema = z.enum([
  "ok",
  "blocked",
  "error",
  "unsupported"
])

export type RequestStatus = z.infer<typeof RequestStatusSchema>

export const RequestRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agent: AgentKindSchema,
  provider: ProviderKindSchema,
  projectHash: z.string(),
  model: z.string(),
  inputHash: z.string(),
  outputHash: z.string(),
  tokensIn: z.number().int().nonnegative(),
  cacheReadTokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  cacheHit: z.boolean(),
  decisionId: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  status: RequestStatusSchema,
  createdAt: z.string()
})

export type RequestRecord = z.infer<typeof RequestRecordSchema>

export const ToolCallStatusSchema = z.enum(["ok", "blocked", "error", "unsupported"])

export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

export const ToolCallRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  agent: AgentKindSchema,
  projectHash: z.string(),
  tool: z.string(),
  command: z.string(),
  commandHash: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  status: ToolCallStatusSchema
})

export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>

export const SessionStatusSchema = z.enum(["active", "ended", "error"])

export type SessionStatus = z.infer<typeof SessionStatusSchema>

export const SessionRecordSchema = z.object({
  id: z.string(),
  projectId: z.number().int().positive(),
  agent: AgentKindSchema,
  status: SessionStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable()
})

export type SessionRecord = z.infer<typeof SessionRecordSchema>

export const ProjectRecordSchema = z.object({
  id: z.number().int().positive(),
  pathHash: z.string(),
  displayName: z.string(),
  createdAt: z.string()
})

export type ProjectRecord = z.infer<typeof ProjectRecordSchema>

export const OptimizationProposalKindSchema = z.enum([
  "compress",
  "cache",
  "deny",
  "budget",
  "route",
  "prompt"
])

export type OptimizationProposalKind = z.infer<typeof OptimizationProposalKindSchema>

export const OptimizationProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "applied"
])

export type OptimizationProposalStatus = z.infer<typeof OptimizationProposalStatusSchema>

export const OptimizationProposalSchema = z.object({
  id: z.string(),
  kind: OptimizationProposalKindSchema,
  evidence: z.string(),
  impact: z.string(),
  ruleJson: z.string(),
  ruleType: z.enum(["tool", "request", "session"]),
  status: OptimizationProposalStatusSchema,
  createdAt: z.string()
})

export type OptimizationProposal = z.infer<typeof OptimizationProposalSchema>

export const CacheEntrySchema = z.object({
  keyHash: z.string(),
  provider: ProviderKindSchema,
  model: z.string(),
  projectHash: z.string(),
  accountFingerprint: z.string(),
  upstreamUrl: z.string(),
  contentType: z.string(),
  responseJson: z.string(),
  estimatedCostUsd: z.number().nonnegative(),
  createdAt: z.string(),
  expiresAt: z.string(),
  hits: z.number().int().nonnegative()
})

export type CacheEntry = z.infer<typeof CacheEntrySchema>

export const CostRecordSchema = z.object({
  requestId: z.string(),
  provider: ProviderKindSchema,
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  cacheReadTokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  currency: z.string(),
  pricingStatus: z.enum(["priced", "unpriced", "legacy-unknown"]).optional()
})

export type CostRecord = z.infer<typeof CostRecordSchema>

export const TelemetryEventSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  payloadJson: z.string(),
  createdAt: z.string()
})

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>

export const PolicyDecisionRecordSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  ruleId: z.string(),
  action: PolicyActionSchema,
  mode: PolicyModeSchema,
  reason: z.string()
})

export type PolicyDecisionRecord = z.infer<typeof PolicyDecisionRecordSchema>

export const StatsSummarySchema = z.object({
  totalRequests: z.number().int().nonnegative(),
  totalTokensIn: z.number().int().nonnegative(),
  totalTokensOut: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  cacheHitRate: z.number().min(0).max(1),
  estimatedSavingsUsd: z.number().nonnegative(),
  errorRate: z.number().min(0).max(1),
  averageDurationMs: z.number().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  auditCount: z.number().int().nonnegative(),
  byAgent: z.record(z.string(), z.number().int().nonnegative())
})

export type StatsSummary = z.infer<typeof StatsSummarySchema>

export const ToolStatsSchema = z.object({
  tool: z.string(),
  count: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  averageDurationMs: z.number().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  commandHashes: z.array(z.string())
})

export type ToolStats = z.infer<typeof ToolStatsSchema>

export const CostStatsSchema = z.object({
  provider: ProviderKindSchema,
  model: z.string(),
  totalCostUsd: z.number().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative()
})

export type CostStats = z.infer<typeof CostStatsSchema>
