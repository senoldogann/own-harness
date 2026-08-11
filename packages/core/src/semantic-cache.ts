import { sha256 } from "./hash.js"

const TEXT_KEYS = new Set([
  "system",
  "messages",
  "input",
  "instructions",
  "prompt",
  "query",
  "content",
  "text"
])

const MAX_NORMALIZED_CHARS = 32_000

export interface PromptFingerprint {
  readonly normalizedText: string
  readonly inputHash: string
  readonly shingles: readonly number[]
}

export function promptFingerprint(body: unknown): PromptFingerprint {
  const normalizedText = normalizePromptText(body)
  const inputHash = normalizedText.length === 0 ? "" : sha256(normalizedText)
  return {
    normalizedText,
    inputHash,
    shingles: createPromptShingles(normalizedText)
  }
}

export function normalizePromptText(body: unknown): string {
  const parts: string[] = []
  collectPromptText(body, undefined, parts)
  return parts.join("\n").replace(/\s+/g, " ").trim().slice(0, MAX_NORMALIZED_CHARS)
}

export function createPromptShingles(text: string, maxTokens = 400): readonly number[] {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .slice(0, maxTokens)
  if (tokens.length === 0) {
    return []
  }
  const shingles = new Set<number>()
  if (tokens.length === 1) {
    shingles.add(fnv1a(tokens[0] ?? ""))
    return [...shingles].sort((left, right) => left - right)
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    shingles.add(fnv1a(`${tokens[index] ?? ""}\u0000${tokens[index + 1] ?? ""}`))
  }
  return [...shingles].sort((left, right) => left - right)
}

export function diceSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0
  }
  const leftSet = new Set(left)
  const seen = new Set<number>()
  let intersection = 0
  for (const value of right) {
    if (leftSet.has(value) && !seen.has(value)) {
      intersection += 1
      seen.add(value)
    }
  }
  return (2 * intersection) / (left.length + right.length)
}

function collectPromptText(value: unknown, key: string | undefined, parts: string[]): void {
  if (typeof value === "string") {
    if (key === undefined || TEXT_KEYS.has(key)) {
      parts.push(value)
    }
    return
  }
  if (Array.isArray(value)) {
    if (key !== undefined && !TEXT_KEYS.has(key)) {
      return
    }
    for (const item of value) {
      collectPromptText(item, key, parts)
    }
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectPromptText(childValue, childKey, parts)
    }
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
