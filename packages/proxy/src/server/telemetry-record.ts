import type { HarnessStore } from "@own-harness/core"
import type { RequestRecord } from "@own-harness/contracts"
import type { ProxyOptions } from "./proxy-server.js"

export function insertRequestWithTelemetry(options: ProxyOptions, request: RequestRecord): void {
  options.store.insertRequest(request)
  recordRequestTelemetry(options, request)
}

export function recordCompletedRequestWithTelemetry(
  options: ProxyOptions,
  completion: Parameters<HarnessStore["recordCompletedRequest"]>[0]
): void {
  options.store.recordCompletedRequest(completion)
  recordRequestTelemetry(options, completion.request, completion.cost.pricingStatus ?? "legacy-unknown")
}

export function recordRequestTelemetry(
  options: ProxyOptions,
  request: RequestRecord,
  pricingStatus?: "priced" | "unpriced" | "legacy-unknown"
): void {
  options.telemetry?.record("proxy_request", {
    agent: request.agent,
    provider: request.provider,
    status: request.status,
    cacheHit: request.cacheHit,
    tokensIn: request.tokensIn,
    cacheReadTokensIn: request.cacheReadTokensIn ?? 0,
    tokensOut: request.tokensOut,
    durationMs: request.durationMs,
    pricingStatus: pricingStatus ?? "not-applicable"
  })
}
