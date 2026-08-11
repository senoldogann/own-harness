import type { ProviderKind } from "@own-harness/contracts"
import type { RoutingConfig, RoutingRule } from "./config.js"

const compiledRoutingRegex = new WeakMap<object, RegExp>()

export interface RoutingDecision {
  readonly ruleId: string
  readonly provider: ProviderKind
  readonly reason: string
  readonly mode: "audit" | "enforce"
}

export function evaluateRouting(
  config: RoutingConfig | undefined,
  model: string
): RoutingDecision | undefined {
  if (config === undefined || config.mode === "disabled" || model.length === 0) {
    return undefined
  }
  for (const rule of config.rules) {
    if (compileRoutingRegex(rule).test(model)) {
      return {
        ruleId: rule.id,
        provider: rule.provider,
        reason: rule.reason,
        mode: config.mode
      }
    }
  }
  return undefined
}

function compileRoutingRegex(rule: RoutingRule): RegExp {
  const cached = compiledRoutingRegex.get(rule)
  if (cached !== undefined) {
    return cached
  }
  const regex = new RegExp(rule.modelRegex)
  compiledRoutingRegex.set(rule, regex)
  return regex
}
