import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { RateLimitRouteClass } from "./rate-limit.js"

export function credentialRateLimitIdentity(
  routeClass: RateLimitRouteClass,
  authorization: string | undefined
): string {
  if (authorization === undefined) {
    throw new Error(`Authenticated ${routeClass} request is missing its authorization header`)
  }
  const digest = createHash("sha256").update(authorization).digest("hex")
  return `${routeClass}:credential:${digest}`
}

export function isAuthorized(auth: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined || auth === undefined) {
    return false
  }
  const provided = Buffer.from(auth)
  const target = Buffer.from(`Bearer ${expected}`)
  const left = Buffer.from(createHmac("sha256", "own-harness-auth").update(provided).digest())
  const right = Buffer.from(createHmac("sha256", "own-harness-auth").update(target).digest())
  return left.length === right.length && timingSafeEqual(left, right)
}
