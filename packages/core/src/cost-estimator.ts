import type { ProviderKind } from "@own-harness/contracts"
import type { EstimatedCost, PricingCatalog } from "./pricing-catalog.js"

export interface ProviderRequestBody {
  readonly model?: unknown
  readonly messages?: unknown
  readonly input?: unknown
  readonly output?: unknown
  readonly [key: string]: unknown
  readonly usage?: ProviderUsage
}

interface TokenDetails {
  readonly cached_tokens?: unknown
}

interface ProviderUsage {
  readonly input_tokens?: unknown
  readonly prompt_tokens?: unknown
  readonly output_tokens?: unknown
  readonly completion_tokens?: unknown
  readonly cache_read_input_tokens?: unknown
  readonly cache_creation_input_tokens?: unknown
  readonly prompt_cache_hit_tokens?: unknown
  readonly prompt_cache_miss_tokens?: unknown
  readonly input_tokens_details?: TokenDetails
  readonly prompt_tokens_details?: TokenDetails
}

export interface ProviderResponseBody {
  readonly usage?: ProviderUsage
}

export interface ProviderSseEventBody extends ProviderResponseBody {
  readonly message?: {
    readonly usage?: ProviderUsage
  }
  readonly response?: {
    readonly usage?: ProviderUsage
  }
}

export interface TokenUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokensIn: number
}

export function estimateTokensFromBody(body: unknown): TokenUsage {
  if (typeof body !== "object" || body === null) {
    return emptyTokenUsage()
  }
  const record = body as ProviderRequestBody
  if (typeof record.usage === "object" && record.usage !== null) {
    const usage = extractResponseUsage(record)
    if (usage.tokensIn > 0 || usage.tokensOut > 0) {
      return usage
    }
  }
  const input = estimateTextTokens(record.messages ?? record.input ?? "")
  const output = estimateTextTokens(record.output ?? "")
  return {
    tokensIn: input,
    tokensOut: output,
    cacheReadTokensIn: 0
  }
}

export function estimateTextTokens(value: unknown): number {
  if (typeof value === "string") {
    return Math.ceil(value.length / 4)
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + estimateTextTokens(item), 0)
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).reduce((total, item) => total + estimateTextTokens(item), 0)
  }
  return 0
}

export function estimateRequestCost(
  pricing: PricingCatalog,
  provider: ProviderKind,
  model: string,
  body: unknown
): EstimatedCost {
  const usage = estimateTokensFromBody(body)
  return pricing.estimate({
    provider,
    model,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    cacheReadTokensIn: usage.cacheReadTokensIn
  })
}

export function extractResponseUsage(body: unknown): TokenUsage {
  if (typeof body !== "object" || body === null) {
    return emptyTokenUsage()
  }
  const record = body as ProviderResponseBody
  if (typeof record.usage !== "object" || record.usage === null) {
    return emptyTokenUsage()
  }
  const usage = record.usage
  const directInput = numericOrZero(usage.input_tokens ?? usage.prompt_tokens)
  const cacheRead = numericOrZero(
    usage.cache_read_input_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens
  )
  const cacheCreation = numericOrZero(usage.cache_creation_input_tokens)
  const cacheMiss = numericOrZero(usage.prompt_cache_miss_tokens)
  const hasAnthropicCacheBreakdown = usage.cache_read_input_tokens !== undefined ||
    usage.cache_creation_input_tokens !== undefined
  const hasDeepSeekCacheBreakdown = usage.prompt_cache_hit_tokens !== undefined ||
    usage.prompt_cache_miss_tokens !== undefined
  const input = hasAnthropicCacheBreakdown
    ? directInput + cacheRead + cacheCreation
    : directInput > 0
      ? directInput
      : hasDeepSeekCacheBreakdown ? cacheRead + cacheMiss : 0
  const output = numericOrZero(record.usage.output_tokens ?? record.usage.completion_tokens)
  return { tokensIn: input, tokensOut: output, cacheReadTokensIn: Math.min(cacheRead, input) }
}

export function extractUsageFromSse(value: string): TokenUsage {
  let tokensIn = 0
  let tokensOut = 0
  let cacheReadTokensIn = 0
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue
    }
    const payload = line.slice(5).trim()
    if (payload === "[DONE]") {
      continue
    }
    const parsed = parseJsonObject(payload)
    if (parsed === undefined) {
      continue
    }
    const eventUsage = extractUsageFromSseEvent(parsed)
    tokensIn = Math.max(tokensIn, eventUsage.tokensIn)
    tokensOut = Math.max(tokensOut, eventUsage.tokensOut)
    cacheReadTokensIn = Math.max(cacheReadTokensIn, eventUsage.cacheReadTokensIn)
  }
  return { tokensIn, tokensOut, cacheReadTokensIn }
}

function extractUsageFromSseEvent(value: unknown): TokenUsage {
  if (typeof value !== "object" || value === null) {
    return emptyTokenUsage()
  }
  const event = value as ProviderSseEventBody
  const topLevelUsage = extractResponseUsage(event)
  if (topLevelUsage.tokensIn > 0 || topLevelUsage.tokensOut > 0) {
    return topLevelUsage
  }
  const responseUsage = extractResponseUsage(event.response)
  if (responseUsage.tokensIn > 0 || responseUsage.tokensOut > 0) {
    return responseUsage
  }
  return extractResponseUsage(event.message)
}

function emptyTokenUsage(): TokenUsage {
  return { tokensIn: 0, tokensOut: 0, cacheReadTokensIn: 0 }
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function numericOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : 0
}
