import { z } from "zod"
import { AgentKindSchema, PolicyActionSchema, PolicyModeSchema, ProviderKindSchema } from "@own-harness/contracts"

export const ToolMatchSchema = z.object({
  tools: z.array(z.string()).optional(),
  commandRegex: z.string().optional(),
  commandPrefix: z.array(z.string()).optional()
}).strict().refine(
  (match) => match.tools !== undefined || match.commandRegex !== undefined || match.commandPrefix !== undefined,
  { message: "Tool rules require at least one match selector" }
)

export const RequestMatchSchema = z.object({
  providers: z.array(ProviderKindSchema).optional(),
  agents: z.array(AgentKindSchema).optional(),
  direction: z.enum(["outbound", "inbound"]).optional()
}).strict()

export const SessionMatchSchema = z.object({
  project: z.string().optional()
}).strict()

export const RuleConfigSchema = z.object({
  maxLines: z.number().int().positive().optional(),
  maxChars: z.number().int().positive().optional(),
  ttlMinutes: z.number().int().positive().optional(),
  exactOnly: z.boolean().optional(),
  normalized: z.boolean().optional(),
  similarityThreshold: z.number().min(0.5).max(1).optional(),
  maxCandidates: z.number().int().positive().max(1000).optional(),
  patterns: z.array(z.string()).optional(),
  maxUsd: z.number().positive().optional(),
  warnAt: z.number().min(0).max(1).optional(),
  blockAt: z.number().min(0).max(1).optional(),
  routeTo: ProviderKindSchema.optional()
}).strict()

export const PolicyRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    match: ToolMatchSchema,
    action: PolicyActionSchema,
    reason: z.string(),
    config: RuleConfigSchema.optional()
  }).strict(),
  z.object({
    type: z.literal("request"),
    id: z.string(),
    match: RequestMatchSchema,
    action: PolicyActionSchema,
    reason: z.string(),
    config: RuleConfigSchema.optional()
  }).strict(),
  z.object({
    type: z.literal("session"),
    id: z.string(),
    match: SessionMatchSchema,
    action: PolicyActionSchema,
    reason: z.string(),
    config: RuleConfigSchema.optional()
  }).strict()
])

export type ToolMatch = z.infer<typeof ToolMatchSchema>
export type RequestMatch = z.infer<typeof RequestMatchSchema>
export type SessionMatch = z.infer<typeof SessionMatchSchema>
export type RuleConfig = z.infer<typeof RuleConfigSchema>
export type PolicyRule = z.infer<typeof PolicyRuleSchema>

export type PolicyDecisionConfig = Partial<RuleConfig>

export const PolicyConfigSchema = z.object({
  version: z.literal(1),
  mode: PolicyModeSchema,
  defaultAction: PolicyActionSchema,
  project: z.string().optional(),
  rules: z.array(PolicyRuleSchema)
}).strict()

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>

export interface PolicyEvalContextTool {
  readonly tool: string
  readonly command: string
  readonly agent: string
}

export interface PolicyEvalContextRequest {
  readonly provider: string
  readonly agent: string
  readonly model: string
  readonly direction?: "outbound" | "inbound"
}

export interface PolicyEvalContextSession {
  readonly project: string
}

export type PolicyEvalContext =
  | {
      readonly kind: "tool"
      readonly context: PolicyEvalContextTool
    }
  | {
      readonly kind: "request"
      readonly context: PolicyEvalContextRequest
    }
  | {
      readonly kind: "session"
      readonly context: PolicyEvalContextSession
    }
