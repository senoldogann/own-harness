import { PolicyDecisionSchema, type PolicyDecision } from "@own-harness/contracts"
import { PolicyConfigSchema, type PolicyConfig, type PolicyEvalContext } from "./policy-types.js"
import { PolicyValidationError } from "./errors.js"
import { safeRegex } from "safe-regex2"
import type { PolicyDecisionConfig, PolicyRule } from "./policy-types.js"

const compiledRegexCache = new WeakMap<object, RegExp>()
const supportedActions = new Set(["allow", "deny", "cache", "log", "redact", "compress", "budget", "route"])
const supportedDefaultActions = new Set(["allow", "deny", "log"])

export function parsePolicyConfig(source: string): PolicyConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new PolicyValidationError("Policy source must be valid JSON")
  }
  const result = PolicyConfigSchema.safeParse(parsed)
  if (!result.success) {
    throw new PolicyValidationError(result.error.message)
  }
  if (!supportedDefaultActions.has(result.data.defaultAction)) {
    throw new PolicyValidationError(
      `Unsupported defaultAction ${result.data.defaultAction}; supported default actions: allow, deny, log`
    )
  }
  for (const rule of result.data.rules) {
    if (!supportedActions.has(rule.action)) {
      throw new PolicyValidationError(
        `Unsupported policy action ${rule.action} for rule ${rule.id}; supported actions: allow, deny, cache, log, redact, compress, budget, route`
      )
    }
    compileToolRule(rule)
    validateActionConfig(rule)
  }
  return result.data
}

function validateActionConfig(rule: PolicyRule): void {
  const config = rule.config
  if (rule.action === "redact" && config?.patterns === undefined) {
    throw new PolicyValidationError(`Redact rule ${rule.id} requires config.patterns`)
  }
  if ((rule.action === "compress" || rule.action === "route") && config === undefined) {
    throw new PolicyValidationError(`Action ${rule.action} for rule ${rule.id} requires config`)
  }
  if (rule.action === "route" && config?.routeTo === undefined) {
    throw new PolicyValidationError(`Route rule ${rule.id} requires config.routeTo`)
  }
  if (rule.action === "budget" && config?.maxUsd === undefined) {
    throw new PolicyValidationError(`Budget rule ${rule.id} requires config.maxUsd`)
  }
  validateRedactPatterns(rule.id, config?.patterns)
}

function validateRedactPatterns(ruleId: string, patterns: readonly string[] | undefined): void {
  if (patterns === undefined) {
    return
  }
  for (const pattern of patterns) {
    let regex: RegExp
    try {
      regex = new RegExp(pattern, "g")
    } catch {
      throw new PolicyValidationError(`Invalid redact pattern in rule ${ruleId}: ${pattern}`)
    }
    if (!safeRegex(regex)) {
      throw new PolicyValidationError(`Unsafe redact pattern in rule ${ruleId}: ${pattern}`)
    }
  }
}

export function evaluatePolicy(
  policy: PolicyConfig,
  context: PolicyEvalContext
): PolicyDecision {
  if (policy.mode === "disabled") {
    return PolicyDecisionSchema.parse({
      ruleId: "disabled",
      action: "allow",
      reason: "Policy engine disabled",
      mode: "disabled"
    })
  }

  for (const rule of policy.rules) {
    const compiledRegex = compileToolRule(rule)
    if (matchesRule(rule, compiledRegex, context)) {
      return PolicyDecisionSchema.parse({
        ruleId: rule.id,
        action: rule.action,
        reason: rule.reason,
        mode: policy.mode,
        ...(rule.config === undefined ? {} : { config: decisionConfig(rule.config) })
      })
    }
  }

  return PolicyDecisionSchema.parse({
    ruleId: "default",
    action: policy.defaultAction,
    reason: "No rule matched",
    mode: policy.mode
  })
}

function decisionConfig(config: PolicyConfig["rules"][number]["config"]): PolicyDecisionConfig | undefined {
  if (config === undefined) {
    return undefined
  }
  return {
    ...(config.ttlMinutes === undefined ? {} : { ttlMinutes: config.ttlMinutes }),
    ...(config.exactOnly === undefined ? {} : { exactOnly: config.exactOnly }),
    ...(config.normalized === undefined ? {} : { normalized: config.normalized }),
    ...(config.similarityThreshold === undefined
      ? {}
      : { similarityThreshold: config.similarityThreshold }),
    ...(config.maxCandidates === undefined ? {} : { maxCandidates: config.maxCandidates }),
    ...(config.maxLines === undefined ? {} : { maxLines: config.maxLines }),
    ...(config.maxChars === undefined ? {} : { maxChars: config.maxChars }),
    ...(config.patterns === undefined ? {} : { patterns: config.patterns }),
    ...(config.maxUsd === undefined ? {} : { maxUsd: config.maxUsd }),
    ...(config.warnAt === undefined ? {} : { warnAt: config.warnAt }),
    ...(config.blockAt === undefined ? {} : { blockAt: config.blockAt }),
    ...(config.routeTo === undefined ? {} : { routeTo: config.routeTo })
  }
}

function matchesRule(
  rule: PolicyConfig["rules"][number],
  compiledRegex: RegExp | undefined,
  context: PolicyEvalContext
): boolean {
  if (context.kind !== rule.type) {
    return false
  }

  if (rule.type === "tool" && context.kind === "tool") {
    return matchesToolRule(rule, compiledRegex, context.context)
  }

  if (rule.type === "request" && context.kind === "request") {
    return matchesRequestRule(rule, context.context)
  }

  if (rule.type === "session" && context.kind === "session") {
    return matchesSessionRule(rule, context.context)
  }

  return false
}

function matchesToolRule(
  rule: Extract<PolicyConfig["rules"][number], { type: "tool" }>,
  compiledRegex: RegExp | undefined,
  context: PolicyEvalContextTool
): boolean {
  const match = rule.match
  if (match.tools !== undefined && !match.tools.includes(context.tool)) {
    return false
  }
  if (compiledRegex !== undefined && !compiledRegex.test(context.command)) {
    return false
  }
  if (
    match.commandPrefix !== undefined &&
    !match.commandPrefix.some((prefix) => context.command.startsWith(prefix))
  ) {
    return false
  }
  return true
}

function compileToolRule(rule: PolicyRule): RegExp | undefined {
  if (rule.type !== "tool") {
    return undefined
  }
  const commandRegex = rule.match.commandRegex
  if (commandRegex === undefined) {
    return undefined
  }
  const cached = compiledRegexCache.get(rule)
  if (cached !== undefined) {
    return cached
  }
  let regex: RegExp
  try {
    regex = new RegExp(commandRegex)
  } catch {
    throw new PolicyValidationError(`Invalid commandRegex in rule: ${rule.id}`)
  }
  if (!safeRegex(regex)) {
    throw new PolicyValidationError(`Unsafe commandRegex in rule: ${rule.id}`)
  }
  compiledRegexCache.set(rule, regex)
  return regex
}

function matchesRequestRule(
  rule: Extract<PolicyConfig["rules"][number], { type: "request" }>,
  context: PolicyEvalContextRequest
): boolean {
  const match = rule.match
  if (match.direction !== undefined && match.direction !== context.direction) {
    return false
  }
  if (match.providers !== undefined && !match.providers.includes(context.provider as never)) {
    return false
  }
  if (match.agents !== undefined && !match.agents.includes(context.agent as never)) {
    return false
  }
  return true
}

function matchesSessionRule(
  rule: Extract<PolicyConfig["rules"][number], { type: "session" }>,
  context: PolicyEvalContextSession
): boolean {
  if (rule.match.project !== undefined && rule.match.project !== "*" && rule.match.project !== context.project) {
    return false
  }
  return true
}

interface PolicyEvalContextTool {
  readonly tool: string
  readonly command: string
  readonly agent: string
}

interface PolicyEvalContextRequest {
  readonly provider: string
  readonly agent: string
  readonly model: string
  readonly direction?: "outbound" | "inbound"
}

interface PolicyEvalContextSession {
  readonly project: string
}
