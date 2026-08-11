import { timingSafeEqual } from "node:crypto"
import { hmacSha256, sha256 } from "./hash.js"
import type { PolicyConfig } from "./policy-types.js"

const MAX_BUNDLE_AGE_MS = 10 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 60 * 1000

type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
  readonly [key: string]: JsonValue
}

export interface PolicyBundle {
  readonly policy: PolicyConfig
  readonly version: string
  readonly signature: string
  readonly signedAt: string
}

export function createPolicyBundle(
  policy: PolicyConfig,
  secret: string,
  signedAt: string
): PolicyBundle {
  const policyJson = canonicalJson(toJsonValue(policy))
  const version = sha256(policyJson)
  const envelope = canonicalEnvelope(policy, version, signedAt)
  return {
    policy,
    version,
    signature: hmacSha256(envelope, secret),
    signedAt
  }
}

export function verifyPolicyBundle(bundle: PolicyBundle, secret: string): boolean {
  if (!isFreshTimestamp(bundle.signedAt, Date.now())) {
    return false
  }
  const policyJson = canonicalJson(toJsonValue(bundle.policy))
  if (sha256(policyJson) !== bundle.version) {
    return false
  }
  const expected = hmacSha256(canonicalEnvelope(bundle.policy, bundle.version, bundle.signedAt), secret)
  const left = Buffer.from(expected)
  const right = Buffer.from(bundle.signature)
  return left.length === right.length && timingSafeEqual(left, right)
}

function canonicalEnvelope(policy: PolicyConfig, version: string, signedAt: string): string {
  return canonicalJson(toJsonValue({ policy, version, signedAt }))
}

function isFreshTimestamp(signedAt: string, nowMs: number): boolean {
  const signedAtMs = new Date(signedAt).getTime()
  if (!Number.isFinite(signedAtMs)) {
    return false
  }
  return signedAtMs >= nowMs - MAX_BUNDLE_AGE_MS && signedAtMs <= nowMs + MAX_FUTURE_SKEW_MS
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Policy bundle contains a non-finite number: ${value}`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item))
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = toJsonValue(item)
      }
    }
    return result
  }
  throw new Error(`Policy bundle contains an unsupported value type: ${typeof value}`)
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`
  }
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}
