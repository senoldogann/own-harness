import type { FastifyReply, FastifyRequest } from "fastify"
import { createHmac } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { request as undiciRequest } from "undici"
import type {
  PolicyDecision,
  ProviderKind,
  RequestRecord
} from "@own-harness/contracts"
import {
  estimateRequestCost,
  evaluatePolicy,
  evaluateRouting,
  extractResponseUsage,
  isoFromMinutes,
  isoNow,
  promptFingerprint,
  randomId,
  redactSecrets,
  redactSecretsWithPatterns,
  sha256,
  type CacheEntryWrite,
  type EstimatedCost,
  type PromptFingerprint,
  type RoutingDecision
} from "@own-harness/core"
import {
  chatToResponsesBody,
  isPlaceholderApiKey,
  responsesToChatCompletions
} from "../chat-translation.js"
import { logWarn } from "../logger.js"
import { compressText, extractModelFromBody, headerValue } from "../normalize.js"
import { findSemanticHit, type CachedResponse } from "../semantic-response-cache.js"
import type { ProxyOptions } from "./proxy-server.js"
import { streamResponse } from "./stream-handler.js"
import {
  insertRequestWithTelemetry,
  recordCompletedRequestWithTelemetry
} from "./telemetry-record.js"

interface ProxyRequestContext {
  readonly body: unknown
  readonly headers: Record<string, string | undefined>
  readonly request: FastifyRequest
}

interface EffectiveRoute {
  readonly translated: boolean
  readonly routingDecision: RoutingDecision | undefined
  readonly effectiveProvider: ProviderKind
  readonly effectiveUpstreamUrl: string
  readonly effectiveBody: unknown
  readonly forwardedHeaders: Record<string, string>
}

interface CacheLookupContext {
  readonly keyHash: string
  readonly cacheEnabled: boolean
  readonly semanticCacheEnabled: boolean
  readonly fingerprint: PromptFingerprint
}

export async function handleProxyRequest(
  request: ProxyRequestContext,
  reply: FastifyReply,
  provider: ProviderKind,
  options: ProxyOptions,
  upstreams: Record<ProviderKind, string>,
  mode: "native" | "chat"
): Promise<void> {
  try {
    await proxyRequest(request, reply, provider, options, upstreams, mode)
  } catch (error) {
    if (reply.raw.headersSent) {
      // Streaming clients can disconnect after the first chunk; Fastify must not
      // try to write an error response once the upstream stream has started.
      return
    }
    throw error
  }
}

async function proxyRequest(
  request: ProxyRequestContext,
  reply: FastifyReply,
  provider: ProviderKind,
  options: ProxyOptions,
  upstreams: Record<ProviderKind, string>,
  mode: "native" | "chat"
): Promise<void> {
  const startedAt = Date.now()
  const model = extractModelFromBody(request.body)
  const accountFingerprint = createAccountFingerprint(request.headers, options.accountFingerprint)
  const sessionDecision = evaluatePolicy(options.policy, {
    kind: "session",
    context: {
      project: options.projectHash
    }
  })
  const decision = evaluatePolicy(options.policy, {
    kind: "request",
    context: {
      provider,
      agent: options.agent,
      model,
      direction: "outbound"
    }
  })

  if (decision.action === "deny" && decision.mode === "enforce") {
    const requestId = randomId()
    const inputHash = sha256(JSON.stringify(request.body))
    const cost = estimateRequestCost(options.pricing, provider, model, request.body)
    insertRequestWithTelemetry(options, {
      id: requestId,
      sessionId: options.sessionId,
      agent: options.agent,
      provider,
      projectHash: options.projectHash,
      model,
      inputHash,
      outputHash: sha256("blocked"),
      tokensIn: cost.tokensIn,
      cacheReadTokensIn: cost.cacheReadTokensIn,
      tokensOut: 0,
      costUsd: 0,
      cacheHit: false,
      decisionId: decision.ruleId,
      durationMs: Date.now() - startedAt,
      status: "blocked",
      createdAt: isoNow()
    })
    options.store.insertPolicyDecision({
      id: randomId(),
      requestId,
      ruleId: decision.ruleId,
      action: decision.action,
      mode: decision.mode,
      reason: decision.reason
    })
    reply.status(403).send({ error: "Policy denied request" })
    return
  }

  if (sessionDecision.action === "deny" && sessionDecision.mode === "enforce") {
    const requestId = randomId()
    recordBlockedRequest(options, {
      requestId,
      provider,
      model,
      body: request.body,
      decision: sessionDecision,
      outputHashMarker: "session-blocked"
    })
    reply.status(403).send({ error: "Session policy denied request", ruleId: sessionDecision.ruleId })
    return
  }

  if (sessionDecision.action === "budget" && sessionDecision.mode === "enforce") {
    const recentCost = options.store.sumCostSince(isoFromMinutes(-60 * 24), {
      sessionId: options.sessionId,
      projectHash: options.projectHash
    })
    if (recentCost >= (sessionDecision.config?.maxUsd ?? 0)) {
      const requestId = randomId()
      recordBlockedRequest(options, {
        requestId,
        provider,
        model,
        body: request.body,
        decision: sessionDecision,
        outputHashMarker: "budget-blocked"
      })
      reply.status(429).send({ error: "Session budget exceeded", ruleId: sessionDecision.ruleId })
      return
    }
  }

  if (decision.action === "budget" && decision.mode === "enforce") {
    const recentCost = options.store.sumCostSince(isoFromMinutes(-60 * 24), {
      sessionId: options.sessionId,
      projectHash: options.projectHash
    })
    if (recentCost >= (decision.config?.maxUsd ?? 0)) {
      const requestId = randomId()
      recordBlockedRequest(options, {
        requestId,
        provider,
        model,
        body: request.body,
        decision,
        outputHashMarker: "budget-blocked"
      })
      reply.status(429).send({ error: "Session budget exceeded", ruleId: decision.ruleId })
      return
    }
  }

  const resolved = resolveEffectiveProvider(request, provider, upstreams, options, mode, decision, model)
  if ("incompatibleTarget" in resolved) {
    reply.status(422).send({
      error: `Incompatible provider route: ${provider} to ${resolved.incompatibleTarget}`
    })
    return
  }
  const { translated, routingDecision, effectiveProvider, effectiveUpstreamUrl, effectiveBody, forwardedHeaders } = resolved.route
  const requestId = randomId()
  if (routingDecision !== undefined) {
    options.store.insertPolicyDecision({
      id: randomId(),
      requestId,
      ruleId: `routing:${routingDecision.ruleId}`,
      action: "route",
      mode: routingDecision.mode,
      reason: routingDecision.reason
    })
  }
  const inputHash = sha256(JSON.stringify(effectiveBody))
  const isStreaming = isStreamingRequest(request.headers, request.body)
  const cacheContext = buildCacheContext(
    options,
    decision,
    effectiveBody,
    provider,
    model,
    accountFingerprint,
    effectiveUpstreamUrl,
    isStreaming,
    inputHash
  )

  if (cacheContext.cacheEnabled) {
    const cached = options.store.getCacheEntry({
      keyHash: cacheContext.keyHash,
      provider: effectiveProvider,
      model,
      projectHash: options.projectHash,
      accountFingerprint,
      upstreamUrl: effectiveUpstreamUrl
    })
    if (cached !== undefined) {
      replyWithCacheHit(reply, options, decision, requestId, effectiveProvider, model, inputHash, cached, effectiveBody, startedAt)
      return
    }
    if (cacheContext.semanticCacheEnabled) {
      const candidates = options.store.getSemanticCandidates({
        provider: effectiveProvider,
        model,
        projectHash: options.projectHash,
        accountFingerprint,
        upstreamUrl: effectiveUpstreamUrl,
        limit: decision.config?.maxCandidates ?? 200
      })
      const semanticHit = findSemanticHit(candidates, cacheContext.fingerprint, decision.config?.similarityThreshold ?? 1)
      if (semanticHit !== undefined) {
        replyWithCacheHit(reply, options, decision, requestId, effectiveProvider, model, inputHash, semanticHit, effectiveBody, startedAt)
        return
      }
    }
  }

  let response: Awaited<ReturnType<typeof undiciRequest>>
  try {
    response = await requestUpstreamOnce(
      effectiveUpstreamUrl,
      forwardedHeaders,
      JSON.stringify(effectiveBody)
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    insertRequestWithTelemetry(options, {
      id: requestId,
      sessionId: options.sessionId,
      agent: options.agent,
      provider: effectiveProvider,
      projectHash: options.projectHash,
      model,
      inputHash,
      outputHash: sha256("upstream-error"),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      cacheHit: false,
      decisionId: decision.ruleId,
      durationMs: Date.now() - startedAt,
      status: "error",
      createdAt: isoNow()
    })
    options.store.insertPolicyDecision({
      id: randomId(),
      requestId,
      ruleId: decision.ruleId,
      action: decision.action,
      mode: decision.mode,
      reason: decision.reason
    })
    reply.status(502).send({ error: "Upstream request failed", detail: message })
    return
  }
  const contentTypeHeader = response.headers["content-type"]
  const contentType = Array.isArray(contentTypeHeader) ? (contentTypeHeader[0] ?? "application/json") : (contentTypeHeader ?? "application/json")
  if (isStreaming || contentType.includes("text/event-stream")) {
    await streamResponse(reply, response, contentType, requestId, startedAt, effectiveProvider, model, inputHash, options, decision, translated)
    return
  }

  const upstreamBytes = await readBodyWithLimit(response.body, 16 * 1024 * 1024)
  if (upstreamBytes === undefined) {
    insertRequestWithTelemetry(options, {
      id: requestId,
      sessionId: options.sessionId,
      agent: options.agent,
      provider: effectiveProvider,
      projectHash: options.projectHash,
      model,
      inputHash,
      outputHash: sha256("response-too-large"),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      cacheHit: false,
      decisionId: decision.ruleId,
      durationMs: Date.now() - startedAt,
      status: "error",
      createdAt: isoNow()
    })
    reply.status(502).send({ error: "Upstream response exceeded the configured size limit" })
    return
  }
  const contentEncoding = headerValue(response.headers["content-encoding"])
  const upstreamBody = decodeResponseBody(upstreamBytes, contentEncoding, 16 * 1024 * 1024)
  const upstreamText = redactSecrets(upstreamBody)
  const upstreamJson = parseIfJson(upstreamText)
  const clientText = translated && upstreamJson !== undefined
    ? (responsesToChatCompletions(upstreamJson) ?? upstreamText)
    : upstreamText
  const responseText = applyResponseRewrite(decision, clientText)
  const responseUsage = extractResponseUsage(upstreamJson)
  const cost = responseUsage.tokensIn > 0 || responseUsage.tokensOut > 0
    ? options.pricing.estimate({
      provider: effectiveProvider,
      model,
      tokensIn: responseUsage.tokensIn,
      tokensOut: responseUsage.tokensOut,
      cacheReadTokensIn: responseUsage.cacheReadTokensIn
    })
    : estimateRequestCost(options.pricing, effectiveProvider, model, effectiveBody)
  const durationMs = Date.now() - startedAt
  const outputHash = sha256(responseText)
  const requestRecord = buildCompletedRequestRecord({
    requestId,
    options,
    provider: effectiveProvider,
    model,
    inputHash,
    outputHash,
    cost,
    decision,
    durationMs,
    statusCode: response.statusCode
  })
  const cacheEntry = buildCacheEntryWrite({
    cacheEnabled: cacheContext.cacheEnabled,
    statusCode: response.statusCode,
    contentType,
    keyHash: cacheContext.keyHash,
    provider: effectiveProvider,
    model,
    options,
    accountFingerprint,
    upstreamUrl: effectiveUpstreamUrl,
    responseText,
    estimatedCostUsd: cost.costUsd,
    fingerprint: cacheContext.fingerprint,
    ttlMinutes: decision.config?.ttlMinutes
  })
  recordCompletedRequestWithTelemetry(options, {
    request: requestRecord,
    cost: {
      requestId,
      provider: effectiveProvider,
      model,
      tokensIn: cost.tokensIn,
      cacheReadTokensIn: cost.cacheReadTokensIn,
      tokensOut: cost.tokensOut,
      costUsd: cost.costUsd,
      currency: cost.currency,
      pricingStatus: cost.pricingStatus
    },
    policyDecisions: [{
      id: randomId(),
      requestId,
      ruleId: decision.ruleId,
      action: decision.action,
      mode: decision.mode,
      reason: decision.reason
    }],
    ...(cacheEntry === undefined ? {} : { cacheEntry })
  })

  reply.raw.setHeader("content-type", contentType)
  reply.status(response.statusCode).send(responseText)
}

function resolveEffectiveProvider(
  request: ProxyRequestContext,
  provider: ProviderKind,
  upstreams: Record<ProviderKind, string>,
  options: ProxyOptions,
  mode: "native" | "chat",
  decision: PolicyDecision,
  model: string
): { readonly route: EffectiveRoute } | { readonly incompatibleTarget: ProviderKind } {
  const translated = mode === "chat"
  const routingDecision = evaluateRouting(options.routing, model)
  const requestedRouteProvider = decision.action === "route" && decision.mode === "enforce"
    ? decision.config?.routeTo
    : routingDecision?.mode === "enforce"
      ? routingDecision.provider
      : undefined
  const effectiveProvider = requestedRouteProvider ?? (translated ? "openai" : provider)
  if (!isWireProtocolCompatible(provider, effectiveProvider, translated)) {
    return { incompatibleTarget: effectiveProvider }
  }
  const effectiveUpstreamUrl = joinUpstream(
    upstreams[effectiveProvider],
    translated ? "/v1/responses" : pathForProvider(effectiveProvider)
  )
  const rewrittenBody = applyRequestRewrite(decision, request.body)
  const effectiveBody = translated
    ? chatToResponsesBody(rewrittenBody)
    : rewrittenBody
  const forwardedHeaders = forwardHeaders(request.headers, options.authToken ?? options.managementToken)
  return {
    route: {
      translated,
      routingDecision,
      effectiveProvider,
      effectiveUpstreamUrl,
      effectiveBody,
      forwardedHeaders
    }
  }
}

function buildCacheContext(
  options: ProxyOptions,
  decision: PolicyDecision,
  effectiveBody: unknown,
  provider: ProviderKind,
  model: string,
  accountFingerprint: string,
  effectiveUpstreamUrl: string,
  isStreaming: boolean,
  inputHash: string
): CacheLookupContext {
  const cacheAction = decision.action === "cache" && decision.mode === "enforce"
  const cacheIsScoped = options.projectHash.length > 0 && accountFingerprint.length > 0 && effectiveUpstreamUrl.length > 0
  const cacheEnabled = cacheAction && !isStreaming && cacheIsScoped
  const semanticCacheEnabled = cacheEnabled &&
    (decision.config?.normalized === true || decision.config?.similarityThreshold !== undefined)
  return {
    keyHash: sha256(
      `${provider}:${model}:${options.projectHash}:${accountFingerprint}:${effectiveUpstreamUrl}:${inputHash}`
    ),
    cacheEnabled,
    semanticCacheEnabled,
    fingerprint: promptFingerprint(effectiveBody)
  }
}

function recordBlockedRequest(
  options: ProxyOptions,
  fields: {
    readonly requestId: string
    readonly provider: ProviderKind
    readonly model: string
    readonly body: unknown
    readonly decision: PolicyDecision
    readonly outputHashMarker: string
  }
): void {
  insertRequestWithTelemetry(options, {
    id: fields.requestId,
    sessionId: options.sessionId,
    agent: options.agent,
    provider: fields.provider,
    projectHash: options.projectHash,
    model: fields.model,
    inputHash: inputHashForBody(fields.body),
    outputHash: sha256(fields.outputHashMarker),
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    cacheHit: false,
    decisionId: fields.decision.ruleId,
    durationMs: 0,
    status: "blocked",
    createdAt: isoNow()
  })
  options.store.insertPolicyDecision({
    id: randomId(),
    requestId: fields.requestId,
    ruleId: fields.decision.ruleId,
    action: fields.decision.action,
    mode: fields.decision.mode,
    reason: fields.decision.reason
  })
}

function buildCompletedRequestRecord(fields: {
  readonly requestId: string
  readonly options: ProxyOptions
  readonly provider: ProviderKind
  readonly model: string
  readonly inputHash: string
  readonly outputHash: string
  readonly cost: EstimatedCost
  readonly decision: PolicyDecision
  readonly durationMs: number
  readonly statusCode: number
}): RequestRecord {
  return {
    id: fields.requestId,
    sessionId: fields.options.sessionId,
    agent: fields.options.agent,
    provider: fields.provider,
    projectHash: fields.options.projectHash,
    model: fields.model,
    inputHash: fields.inputHash,
    outputHash: fields.outputHash,
    tokensIn: fields.cost.tokensIn,
    cacheReadTokensIn: fields.cost.cacheReadTokensIn,
    tokensOut: fields.cost.tokensOut,
    costUsd: fields.cost.costUsd,
    estimatedCostUsd: fields.cost.costUsd,
    cacheHit: false,
    decisionId: fields.decision.ruleId,
    durationMs: fields.durationMs,
    status: fields.statusCode === 200 ? "ok" : "error",
    createdAt: isoNow()
  }
}

function buildCacheEntryWrite(fields: {
  readonly cacheEnabled: boolean
  readonly statusCode: number
  readonly contentType: string
  readonly keyHash: string
  readonly provider: ProviderKind
  readonly model: string
  readonly options: ProxyOptions
  readonly accountFingerprint: string
  readonly upstreamUrl: string
  readonly responseText: string
  readonly estimatedCostUsd: number
  readonly fingerprint: PromptFingerprint
  readonly ttlMinutes: number | undefined
}): CacheEntryWrite | undefined {
  if (!fields.cacheEnabled || fields.statusCode !== 200 || fields.contentType.includes("text/event-stream")) {
    return undefined
  }
  return {
    keyHash: fields.keyHash,
    provider: fields.provider,
    model: fields.model,
    projectHash: fields.options.projectHash,
    accountFingerprint: fields.accountFingerprint,
    upstreamUrl: fields.upstreamUrl,
    contentType: fields.contentType,
    responseJson: fields.responseText,
    estimatedCostUsd: fields.estimatedCostUsd,
    normalizedInputHash: fields.fingerprint.inputHash,
    shingleHashes: fields.fingerprint.shingles,
    createdAt: isoNow(),
    expiresAt: isoFromMinutes(fields.ttlMinutes ?? 60)
  }
}

function replyWithCacheHit(
  reply: FastifyReply,
  options: ProxyOptions,
  decision: PolicyDecision,
  requestId: string,
  provider: ProviderKind,
  model: string,
  inputHash: string,
  cached: CachedResponse,
  body: unknown,
  startedAt: number
): void {
  const requestedCost = estimateRequestCost(options.pricing, provider, model, body)
  insertRequestWithTelemetry(options, {
    id: requestId,
    sessionId: options.sessionId,
    agent: options.agent,
    provider,
    projectHash: options.projectHash,
    model,
    inputHash,
    outputHash: sha256(cached.responseJson),
    tokensIn: requestedCost.tokensIn,
    tokensOut: requestedCost.tokensOut,
    costUsd: 0,
    estimatedCostUsd: cached.estimatedCostUsd,
    cacheHit: true,
    decisionId: decision.ruleId,
    durationMs: Date.now() - startedAt,
    status: "ok",
    createdAt: isoNow()
  })
  options.store.insertPolicyDecision({
    id: randomId(),
    requestId,
    ruleId: decision.ruleId,
    action: decision.action,
    mode: decision.mode,
    reason: decision.reason
  })
  reply.raw.setHeader("content-type", cached.contentType)
  reply.status(200).send(cached.responseJson)
}

function parseIfJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function createAccountFingerprint(
  headers: Record<string, string | undefined>,
  localSecret: string | undefined
): string {
  const scopeParts = [
    headers.authorization ?? "",
    headers["x-api-key"] ?? "",
    headers["openai-organization"] ?? "",
    headers["openai-project"] ?? ""
  ]
  const credential = scopeParts.join("|")
  if (credential.length === 0) {
    return ""
  }
  const secret = localSecret ?? "own-harness-local-cache-scope"
  return createHmac("sha256", secret).update(credential).digest("hex")
}

export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value) ? value[0] : value
  }
  return result
}

function inputHashForBody(body: unknown): string {
  return sha256(JSON.stringify(body))
}

function applyRequestRewrite(decision: PolicyDecision, body: unknown): unknown {
  if (decision.mode !== "enforce") {
    return body
  }
  if (decision.action === "redact" && decision.config?.patterns !== undefined) {
    return redactBodyWithPatterns(body, decision.config.patterns)
  }
  if (decision.action === "compress" && decision.config?.maxChars !== undefined) {
    return compressBody(body, decision.config.maxChars)
  }
  return body
}

function applyResponseRewrite(decision: PolicyDecision, value: string): string {
  if (decision.mode !== "enforce") {
    return value
  }
  if (decision.action === "redact" && decision.config?.patterns !== undefined) {
    return redactSecretsWithPatterns(value, decision.config.patterns)
  }
  if (decision.action === "compress" && decision.config?.maxChars !== undefined) {
    return compressText(value, decision.config.maxChars)
  }
  return value
}

function redactBodyWithPatterns(body: unknown, patterns: readonly string[]): unknown {
  if (typeof body === "string") {
    return redactSecretsWithPatterns(body, patterns)
  }
  if (Array.isArray(body)) {
    return body.map((item) => redactBodyWithPatterns(item, patterns))
  }
  if (typeof body === "object" && body !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      result[key] = redactBodyWithPatterns(value, patterns)
    }
    return result
  }
  return body
}

function compressBody(body: unknown, maxChars: number): unknown {
  if (typeof body === "string") {
    return compressText(body, maxChars)
  }
  if (Array.isArray(body)) {
    return body.map((item) => compressBody(item, maxChars))
  }
  if (typeof body === "object" && body !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      result[key] = compressBody(value, maxChars)
    }
    return result
  }
  return body
}

function forwardHeaders(
  headers: Record<string, string | undefined>,
  proxyAuthToken: string | undefined
): Record<string, string> {
  const allowed = new Set([
    "accept",
    "authorization",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "openai-beta",
    "openai-organization",
    "user-agent",
    "content-type"
  ])
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && allowed.has(name.toLowerCase())) {
      if (isPlaceholderApiKey(value)) {
        continue
      }
      if (name.toLowerCase() === "authorization" && proxyAuthToken !== undefined && value === `Bearer ${proxyAuthToken}`) {
        continue
      }
      result[name] = value
    }
  }
  if (result["content-type"] === undefined) {
    result["content-type"] = "application/json"
  }
  return result
}

async function requestUpstreamOnce(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: string
): Promise<Awaited<ReturnType<typeof undiciRequest>>> {
  let response: Awaited<ReturnType<typeof undiciRequest>>
  try {
    response = await undiciRequest(upstreamUrl, {
      method: "POST",
      headers,
      body,
      headersTimeout: 30_000,
      bodyTimeout: 120_000
    })
  } catch (error) {
    const causeMessage = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Upstream POST transport failed and was not retried to avoid duplicate billing for ${upstreamUrl}: ${causeMessage}`,
      { cause: error }
    )
  }
  if (response.statusCode === 429) {
    logWarn({
      event: "upstream_retry_disabled",
      upstreamUrl,
      statusCode: response.statusCode,
      attempt: 1,
      action: "The upstream response was preserved; retry manually only after confirming the first request was not billed"
    })
  }
  return response
}

async function readBodyWithLimit(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      return undefined
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function decodeResponseBody(buffer: Buffer, encoding: string | undefined, maxBytes: number): string {
  if (encoding === undefined || encoding === "identity") {
    return buffer.toString("utf8")
  }
  if (encoding !== "gzip") {
    throw new Error(`Unsupported upstream content-encoding: ${encoding}`)
  }
  return gunzipSync(buffer, { maxOutputLength: maxBytes }).toString("utf8")
}

function isStreamingRequest(
  headers: Record<string, string | undefined>,
  body: unknown
): boolean {
  if (headers.accept?.includes("text/event-stream") === true) {
    return true
  }
  if (typeof body === "object" && body !== null) {
    return (body as { stream?: unknown }).stream === true
  }
  return false
}

function pathForProvider(provider: ProviderKind): string {
  if (provider === "anthropic") {
    return "/v1/messages"
  }
  if (provider === "openai") {
    return "/v1/responses"
  }
  return "/v1/chat/completions"
}

function isWireProtocolCompatible(
  source: ProviderKind,
  target: ProviderKind,
  translated: boolean
): boolean {
  if (translated) {
    return source === "openai-compatible" && target === "openai"
  }
  return source === target
}

function joinUpstream(base: string, path: string): string {
  if (base.endsWith("/v1")) {
    return `${base}${path.replace("/v1", "")}`
  }
  return `${base.replace(/\/$/, "")}${path}`
}
