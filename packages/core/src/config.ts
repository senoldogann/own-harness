import { z } from "zod"
import { ConfigValidationError } from "./errors.js"
import { safeRegex } from "safe-regex2"

const RoutingRuleSchema = z.object({
  id: z.string().min(1),
  modelRegex: z.string().min(1),
  provider: z.enum(["anthropic", "openai", "openai-compatible"]),
  reason: z.string().min(1)
})

const PricingModelSchema = z.object({
  provider: z.enum(["anthropic", "openai", "openai-compatible"]),
  model: z.string(),
  inputPerMillion: z.number().nonnegative(),
  cacheReadInputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative()
})

const EnvironmentVariableNameSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name")

export const HarnessConfigSchema = z.object({
  version: z.literal(1),
  proxy: z.object({
    host: z.literal("127.0.0.1"),
    port: z.number().int().positive(),
    translateChatToResponses: z.boolean().optional()
  }),
  store: z.object({
    home: z.literal("~/.own-harness"),
    retentionDays: z.number().int().positive()
  }),
  telemetry: z.object({
    enabled: z.boolean(),
    optInFile: z.literal("~/.own-harness/telemetry.json")
  }),
  server: z.object({
    host: z.literal("127.0.0.1"),
    authTokenEnv: EnvironmentVariableNameSchema.optional()
  }).strict().optional(),
  distribution: z.object({
    serverUrl: z.string().url().optional(),
    signatureSecretEnv: EnvironmentVariableNameSchema.optional()
  }).strict().optional(),
  rtk: z.object({
    enabled: z.boolean()
  }).optional(),
  routing: z.object({
    mode: z.enum(["disabled", "audit", "enforce"]),
    rules: z.array(RoutingRuleSchema)
  }).optional(),
  pricing: z.object({
    defaultCurrency: z.string(),
    models: z.array(PricingModelSchema)
  })
})

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>
export type RoutingConfig = z.infer<typeof HarnessConfigSchema>["routing"]
export type RoutingRule = z.infer<typeof RoutingRuleSchema>

export function parseHarnessConfig(source: string): HarnessConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new ConfigValidationError("Harness config must be valid JSON")
  }
  const result = HarnessConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new ConfigValidationError(result.error.message)
  }
  for (const rule of result.data.routing?.rules ?? []) {
    let regex: RegExp
    try {
      regex = new RegExp(rule.modelRegex)
    } catch {
      throw new ConfigValidationError(`Invalid routing modelRegex in rule ${rule.id}: ${rule.modelRegex}`)
    }
    if (!safeRegex(regex)) {
      throw new ConfigValidationError(`Unsafe routing modelRegex in rule ${rule.id}: ${rule.modelRegex}`)
    }
  }
  return result.data
}
