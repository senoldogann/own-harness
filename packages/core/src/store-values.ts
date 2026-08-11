import type {
  CostRecord,
  PolicyDecisionRecord,
  ProviderKind,
  RequestRecord
} from "@own-harness/contracts"
import { StoreError } from "./errors.js"

export interface CacheEntryWrite {
  readonly keyHash: string
  readonly provider: ProviderKind
  readonly model: string
  readonly projectHash: string
  readonly accountFingerprint: string
  readonly upstreamUrl: string
  readonly contentType: string
  readonly responseJson: string
  readonly estimatedCostUsd: number
  readonly normalizedInputHash: string
  readonly shingleHashes: readonly number[]
  readonly createdAt: string
  readonly expiresAt: string
}

export interface CompletedRequestWrite {
  readonly request: RequestRecord
  readonly cost: CostRecord
  readonly policyDecisions: readonly PolicyDecisionRecord[]
  readonly cacheEntry?: CacheEntryWrite
}

export function validateCompletedRequest(completion: CompletedRequestWrite): void {
  if (completion.cost.requestId !== completion.request.id) {
    throw new StoreError(
      `Completed request cost id ${completion.cost.requestId} does not match request id ${completion.request.id}`
    )
  }
  for (const decision of completion.policyDecisions) {
    if (decision.requestId !== completion.request.id) {
      throw new StoreError(
        `Completed request policy decision ${decision.id} targets ${decision.requestId}; expected ${completion.request.id}`
      )
    }
  }
}

export function proposalTransitions(current: string): Array<"approved" | "rejected" | "applied"> {
  if (current === "pending") {
    return ["approved", "rejected"]
  }
  if (current === "approved") {
    return ["applied"]
  }
  return []
}

export function parseShingleHashes(source: string): readonly number[] {
  try {
    const parsed = JSON.parse(source)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
    )
  } catch {
    return []
  }
}
