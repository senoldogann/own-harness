import Fastify, { type FastifyInstance } from "fastify"
import type { AgentKind, ProviderKind } from "@own-harness/contracts"
import type { HarnessStore, PricingCatalog, PolicyConfig, RoutingConfig, TelemetryService } from "@own-harness/core"
import { requireEncryptedRemoteUrl } from "@own-harness/core"
import { isAuthorized, credentialRateLimitIdentity } from "./auth.js"
import { registerManagementRoutes } from "./api-routes.js"
import { registerIngestRoute } from "./ingest-handler.js"
import { logError } from "../logger.js"
import { handleProxyRequest, normalizeHeaders } from "./provider-handler.js"
import {
  consumeRateLimitWindow,
  purgeExpiredRateWindows,
  rateLimitRouteClass,
  requestPathname,
  sendRateLimitResponse,
  type RateLimitWindow,
  type RateLimitWindowsByRoute
} from "./rate-limit.js"

export interface ProxyOptions {
  readonly host: string
  readonly port: number
  readonly upstreamAnthropic: string
  readonly upstreamOpenAi: string
  readonly store: HarnessStore
  readonly pricing: PricingCatalog
  readonly policy: PolicyConfig
  readonly sessionId: string
  readonly projectHash: string
  readonly agent: AgentKind
  readonly accountFingerprint?: string
  readonly authToken?: string
  readonly managementToken: string
  readonly policySignatureSecret?: string
  readonly translateChatToResponses?: boolean
  readonly routing?: RoutingConfig
  readonly telemetry?: TelemetryService
  readonly rateLimit?: {
    readonly maxRequests: number
    readonly windowMs: number
    readonly maxIdentities?: number
  }
}

export interface HarnessProxy {
  readonly start: () => Promise<string>
  readonly stop: () => Promise<void>
  readonly app: FastifyInstance
}

export function createProxy(options: ProxyOptions): HarnessProxy {
  if (options.host !== "127.0.0.1") {
    throw new Error(`Proxy host must be 127.0.0.1, received ${options.host}`)
  }
  if (typeof options.managementToken !== "string" || options.managementToken.trim().length === 0) {
    throw new Error("managementToken must be a nonempty string")
  }
  if (options.authToken !== undefined && (typeof options.authToken !== "string" || options.authToken.trim().length === 0)) {
    throw new Error("authToken must be a nonempty string when configured")
  }
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 })
  const rateLimit = options.rateLimit ?? { maxRequests: 600, windowMs: 60_000 }
  validatePositiveInteger(rateLimit.maxRequests, "rateLimit.maxRequests")
  validatePositiveInteger(rateLimit.windowMs, "rateLimit.windowMs")
  const maxRateLimitIdentities = options.rateLimit?.maxIdentities ?? 4096
  validatePositiveInteger(maxRateLimitIdentities, "rateLimit.maxIdentities")
  const rateWindowSweepInterval = 256
  const rateWindows: RateLimitWindowsByRoute = {
    management: new Map<string, RateLimitWindow>(),
    provider: new Map<string, RateLimitWindow>(),
    public: new Map<string, RateLimitWindow>()
  }
  const unauthenticatedFailureWindows = new Map<string, RateLimitWindow>()
  const maxUnauthenticatedFailureIdentities = Math.min(maxRateLimitIdentities, 256)
  const maxUnauthenticatedFailures = Math.min(rateLimit.maxRequests, 30)
  let rateWindowRequestCount = 0
  const requireAuth = options.authToken !== undefined
  app.addHook("onRequest", async (request, reply) => {
    const pathname = requestPathname(request.url)
    const routeClass = rateLimitRouteClass(pathname)
    const expectedToken = routeClass === "management"
      ? options.managementToken
      : routeClass === "provider" && requireAuth
        ? options.authToken
        : undefined
    const requiresCredential = expectedToken !== undefined
    const authorized = requiresCredential && isAuthorized(request.headers.authorization, expectedToken)
    const now = Date.now()
    rateWindowRequestCount += 1
    if (rateWindowRequestCount % rateWindowSweepInterval === 0) {
      purgeExpiredRateWindows(rateWindows.management, now, rateLimit.windowMs)
      purgeExpiredRateWindows(rateWindows.provider, now, rateLimit.windowMs)
      purgeExpiredRateWindows(rateWindows.public, now, rateLimit.windowMs)
      purgeExpiredRateWindows(unauthenticatedFailureWindows, now, rateLimit.windowMs)
    }

    if (requiresCredential && !authorized) {
      const failureKey = `${routeClass}:${request.ip}`
      const failureResult = consumeRateLimitWindow(
        unauthenticatedFailureWindows,
        failureKey,
        now,
        rateLimit.windowMs,
        maxUnauthenticatedFailures,
        maxUnauthenticatedFailureIdentities
      )
      if (!failureResult.allowed) {
        sendRateLimitResponse(reply, failureResult, rateLimit.windowMs, now, "Proxy authentication failure rate limit exceeded")
        return
      }
      logError({
        event: routeClass === "management" ? "management_auth_failed" : "proxy_auth_failed",
        path: pathname
      })
      reply.code(401).send({ error: "Unauthorized" })
      return
    }

    // Provider calls without authToken are deliberately local-only and share an IP bucket.
    // They remain isolated from authenticated management traffic and public health probes.
    const identity = authorized
      ? credentialRateLimitIdentity(routeClass, request.headers.authorization)
      : `${routeClass}:anonymous:${request.ip}`
    const result = consumeRateLimitWindow(
      rateWindows[routeClass],
      identity,
      now,
      rateLimit.windowMs,
      rateLimit.maxRequests,
      maxRateLimitIdentities
    )
    if (!result.allowed) {
      sendRateLimitResponse(reply, result, rateLimit.windowMs, now, "Proxy rate limit exceeded")
    }
  })
  let closed = false
  validateUpstreamUrl(options.upstreamAnthropic, "anthropic")
  validateUpstreamUrl(options.upstreamOpenAi, "openai")
  const upstreams: Record<ProviderKind, string> = {
    anthropic: options.upstreamAnthropic,
    openai: options.upstreamOpenAi,
    "openai-compatible": options.upstreamOpenAi
  }

  registerManagementRoutes(app, options)
  registerIngestRoute(app, options)
  registerProviderRoutes(app, options, upstreams)

  return {
    app,
    start: async () => {
      await app.listen({ host: options.host, port: options.port })
      const address = app.server.address()
      const boundPort = typeof address === "object" && address !== null ? address.port : options.port
      return `http://${options.host}:${boundPort}`
    },
    stop: async () => {
      if (closed) {
        return
      }
      closed = true
      await app.close()
    }
  }
}

function registerProviderRoutes(
  app: FastifyInstance,
  options: ProxyOptions,
  upstreams: Record<ProviderKind, string>
): void {
  app.post("/v1/messages", async (request, reply) => {
    await handleProxyRequest(
      {
        body: request.body,
        headers: normalizeHeaders(request.headers),
        request
      },
      reply,
      "anthropic",
      options,
      upstreams,
      "native"
    )
  })

  app.post("/v1/responses", async (request, reply) => {
    await handleProxyRequest(
      {
        body: request.body,
        headers: normalizeHeaders(request.headers),
        request
      },
      reply,
      "openai",
      options,
      upstreams,
      "native"
    )
  })

  app.post("/v1/chat/completions", async (request, reply) => {
    await handleProxyRequest(
      {
        body: request.body,
        headers: normalizeHeaders(request.headers),
        request
      },
      reply,
      "openai-compatible",
      options,
      upstreams,
      options.translateChatToResponses === true ? "chat" : "native"
    )
  })
}

function validateUpstreamUrl(value: string, provider: ProviderKind): void {
  requireEncryptedRemoteUrl(value, `${provider} upstream`)
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer: ${value}`)
  }
}
