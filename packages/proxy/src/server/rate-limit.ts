import type { FastifyReply } from "fastify"

export type RateLimitRouteClass = "management" | "provider" | "public"

export interface RateLimitWindow {
  readonly startedAt: number
  readonly count: number
}

export interface RateLimitWindowsByRoute {
  readonly management: Map<string, RateLimitWindow>
  readonly provider: Map<string, RateLimitWindow>
  readonly public: Map<string, RateLimitWindow>
}

export interface RateLimitResult {
  readonly allowed: boolean
  readonly window?: RateLimitWindow
  readonly capacityExceeded: boolean
}

export function requestPathname(url: string): string {
  const queryStart = url.indexOf("?")
  return queryStart === -1 ? url : url.slice(0, queryStart)
}

export function rateLimitRouteClass(pathname: string): RateLimitRouteClass {
  if (isManagementPath(pathname)) {
    return "management"
  }
  if (isProviderPath(pathname)) {
    return "provider"
  }
  return "public"
}

export function consumeRateLimitWindow(
  windows: Map<string, RateLimitWindow>,
  identity: string,
  now: number,
  windowMs: number,
  maxRequests: number,
  maxIdentities: number
): RateLimitResult {
  const current = windows.get(identity)
  if (current === undefined && windows.size >= maxIdentities) {
    return { allowed: false, capacityExceeded: true }
  }
  const next = current === undefined || now - current.startedAt >= windowMs
    ? { startedAt: now, count: 1 }
    : { startedAt: current.startedAt, count: current.count + 1 }
  windows.set(identity, next)
  return {
    allowed: next.count <= maxRequests,
    window: next,
    capacityExceeded: false
  }
}

export function sendRateLimitResponse(
  reply: FastifyReply,
  result: RateLimitResult,
  windowMs: number,
  now: number,
  message: string
): void {
  const remainingMs = result.window === undefined
    ? windowMs
    : windowMs - (now - result.window.startedAt)
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000))
  const error = result.capacityExceeded
    ? "Proxy rate limit identity capacity exceeded"
    : message
  reply.header("retry-after", String(retryAfterSeconds)).status(429).send({ error })
}

export function purgeExpiredRateWindows(
  windows: Map<string, RateLimitWindow>,
  now: number,
  windowMs: number
): void {
  for (const [identity, window] of windows) {
    if (now - window.startedAt >= windowMs) {
      windows.delete(identity)
    }
  }
}

function isManagementPath(url: string): boolean {
  return url === "/api/v1" || url.startsWith("/api/v1/")
}

function isProviderPath(pathname: string): boolean {
  return pathname === "/v1/messages" ||
    pathname === "/v1/responses" ||
    pathname === "/v1/chat/completions"
}
