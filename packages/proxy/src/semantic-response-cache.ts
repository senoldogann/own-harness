import { diceSimilarity } from "@own-harness/core"

export interface CachedResponse {
  readonly responseJson: string
  readonly contentType: string
  readonly estimatedCostUsd: number
}

export interface SemanticCacheCandidate extends CachedResponse {
  readonly normalizedInputHash: string
  readonly shingleHashes: readonly number[]
}

export interface PromptFingerprint {
  readonly inputHash: string
  readonly shingles: readonly number[]
}

export function findSemanticHit(
  candidates: readonly SemanticCacheCandidate[],
  fingerprint: PromptFingerprint,
  threshold: number
): CachedResponse | undefined {
  let best: CachedResponse | undefined
  let bestSimilarity = 0
  for (const candidate of candidates) {
    const similarity = candidate.normalizedInputHash === fingerprint.inputHash && fingerprint.inputHash !== ""
      ? 1
      : diceSimilarity(fingerprint.shingles, candidate.shingleHashes)
    if (similarity >= threshold && similarity > bestSimilarity) {
      best = {
        responseJson: candidate.responseJson,
        contentType: candidate.contentType,
        estimatedCostUsd: candidate.estimatedCostUsd
      }
      bestSimilarity = similarity
      if (similarity === 1) {
        break
      }
    }
  }
  return best
}
