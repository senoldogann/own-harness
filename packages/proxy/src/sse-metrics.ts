import { extractUsageFromSse } from "@own-harness/core"

export interface SseMetrics {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokensIn: number
  readonly successfulCompletion: boolean
}

export function inspectSseChunk(text: string): SseMetrics {
  const usage = extractUsageFromSse(text)
  return {
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    cacheReadTokensIn: usage.cacheReadTokensIn,
    successfulCompletion: hasSuccessfulSseCompletion(text)
  }
}

function hasSuccessfulSseCompletion(value: string): boolean {
  for (const line of value.split("\n")) {
    if (!line.startsWith("data:")) {
      continue
    }
    const payload = line.slice("data:".length).trim()
    if (payload === "[DONE]") {
      return true
    }
    const event = parseJson(payload)
    if (typeof event !== "object" || event === null) {
      continue
    }
    const type = (event as { readonly type?: unknown }).type
    if (type === "response.completed" || type === "message_stop") {
      return true
    }
  }
  return false
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
