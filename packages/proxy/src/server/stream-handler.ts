import type { FastifyReply } from "fastify"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { createGunzip } from "node:zlib"
import { request as undiciRequest } from "undici"
import type { PolicyDecision, ProviderKind, RequestRecord } from "@own-harness/contracts"
import { isoNow, randomId, redactSecretsWithPatterns } from "@own-harness/core"
import { translateSseBlock } from "../chat-translation.js"
import { headerValue } from "../normalize.js"
import { inspectSseChunk } from "../sse-metrics.js"
import type { ProxyOptions } from "./proxy-server.js"
import { recordCompletedRequestWithTelemetry } from "./telemetry-record.js"

export async function streamResponse(
  reply: FastifyReply,
  response: Awaited<ReturnType<typeof undiciRequest>>,
  contentType: string,
  requestId: string,
  startedAt: number,
  provider: ProviderKind,
  model: string,
  inputHash: string,
  options: ProxyOptions,
  decision: PolicyDecision,
  translated: boolean
): Promise<void> {
  const outputHasher = createHash("sha256")
  let tokensIn = 0
  let tokensOut = 0
  let cacheReadTokensIn = 0
  let successfulCompletion = false
  let upstreamError: Error | undefined
  let clientClosed = false
  let pending = ""
  const maxPendingLineChars = 1024 * 1024
  const decoder = new StringDecoder("utf8")
  const abortBody = () => {
    const body = response.body as unknown as {
      readonly cancel?: () => Promise<unknown>
      readonly destroy?: () => void
    }
    if (typeof body.cancel === "function") {
      void body.cancel().catch(() => undefined)
    } else if (typeof body.destroy === "function") {
      body.destroy()
    }
  }
  const onClientClose = () => {
    clientClosed = true
    abortBody()
  }
  reply.raw.once("close", onClientClose)
  reply.raw.setHeader("content-type", contentType)
  reply.raw.writeHead(response.statusCode)
  try {
    for await (const chunk of decodedStreamingBody(response, 16 * 1024 * 1024)) {
      if (reply.raw.destroyed || reply.raw.writableEnded || clientClosed) {
        break
      }
      pending += decoder.write(Buffer.from(chunk))
      if (pending.length > maxPendingLineChars && !pending.includes("\n")) {
        throw new Error(`SSE line exceeded ${maxPendingLineChars} characters`)
      }
      const lastNewline = pending.lastIndexOf("\n")
      if (lastNewline === -1) {
        continue
      }
      const complete = pending.slice(0, lastNewline + 1)
      pending = pending.slice(lastNewline + 1)
      const text = redactStreamingText(
        translated ? translateSseBlock(complete, model) : complete,
        decision
      )
      outputHasher.update(text, "utf8")
      const metrics = inspectSseChunk(complete)
      tokensIn = Math.max(tokensIn, metrics.tokensIn)
      tokensOut = Math.max(tokensOut, metrics.tokensOut)
      cacheReadTokensIn = Math.max(cacheReadTokensIn, metrics.cacheReadTokensIn)
      successfulCompletion ||= metrics.successfulCompletion
      if (!reply.raw.write(text)) {
        await awaitDrainOrClosed(reply)
      }
    }
    const tail = decoder.end()
    if (tail.length > 0 && !reply.raw.destroyed && !reply.raw.writableEnded) {
      pending += tail
    }
    if (pending.length > 0 && !reply.raw.destroyed && !reply.raw.writableEnded) {
      const text = redactStreamingText(
        translated ? translateSseBlock(pending, model) : pending,
        decision
      )
      outputHasher.update(text, "utf8")
      const metrics = inspectSseChunk(pending)
      tokensIn = Math.max(tokensIn, metrics.tokensIn)
      tokensOut = Math.max(tokensOut, metrics.tokensOut)
      cacheReadTokensIn = Math.max(cacheReadTokensIn, metrics.cacheReadTokensIn)
      successfulCompletion ||= metrics.successfulCompletion
      if (!reply.raw.write(text)) {
        await awaitDrainOrClosed(reply)
      }
    }
  } catch (error) {
    upstreamError = error instanceof Error ? error : new Error(String(error))
  } finally {
    reply.raw.removeListener("close", onClientClose)
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      try {
        reply.raw.end()
      } catch {
        // The client can disconnect while the response is finishing.
      }
    }
  }
  const outputHash = outputHasher.digest("hex")
  const cost = tokensIn > 0 || tokensOut > 0
    ? options.pricing.estimate({ provider, model, tokensIn, tokensOut, cacheReadTokensIn })
    : options.pricing.estimate({ provider, model, tokensIn: 0, tokensOut: 0, cacheReadTokensIn: 0 })
  const durationMs = Date.now() - startedAt
  const streamInterrupted = (upstreamError !== undefined || clientClosed) && !successfulCompletion
  const status = streamInterrupted
    ? "error"
    : response.statusCode === 200 ? "ok" : "error"
  const requestRecord: RequestRecord = {
    id: requestId,
    sessionId: options.sessionId,
    agent: options.agent,
    provider,
    projectHash: options.projectHash,
    model,
    inputHash,
    outputHash,
    tokensIn: cost.tokensIn,
    cacheReadTokensIn: cost.cacheReadTokensIn,
    tokensOut: cost.tokensOut,
    costUsd: cost.costUsd,
    estimatedCostUsd: cost.costUsd,
    cacheHit: false,
    decisionId: decision.ruleId,
    durationMs,
    status,
    createdAt: isoNow()
  }
  recordCompletedRequestWithTelemetry(options, {
    request: requestRecord,
    cost: {
      requestId,
      provider,
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
    }]
  })
}

export function awaitDrainOrClosed(reply: FastifyReply): Promise<void> {
  return new Promise((resolve) => {
    const raw = reply.raw
    if (raw.writableEnded || raw.destroyed) {
      resolve()
      return
    }
    const cleanup = () => {
      raw.removeListener("drain", onDrain)
      raw.removeListener("close", onClosed)
      raw.removeListener("error", onClosed)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClosed = () => {
      cleanup()
      resolve()
    }
    raw.once("drain", onDrain)
    raw.once("close", onClosed)
    raw.once("error", onClosed)
  })
}

function redactStreamingText(value: string, decision: PolicyDecision): string {
  const patterns = decision.mode === "enforce" && decision.action === "redact"
    ? (decision.config?.patterns ?? [])
    : []
  return redactSecretsWithPatterns(value, patterns)
}

async function* decodedStreamingBody(
  response: Awaited<ReturnType<typeof undiciRequest>>,
  maxBytes: number
): AsyncIterable<Uint8Array> {
  const encoding = headerValue(response.headers["content-encoding"])
  if (encoding === undefined || encoding === "identity") {
    yield* response.body
    return
  }
  if (encoding !== "gzip") {
    throw new Error(`Unsupported streaming upstream content-encoding: ${encoding}`)
  }
  const compressedBody = Readable.from(response.body)
  const decompressedBody = compressedBody.pipe(createGunzip())
  let totalBytes = 0
  try {
    for await (const chunk of decompressedBody) {
      const buffer = Buffer.from(chunk)
      totalBytes += buffer.length
      if (totalBytes > maxBytes) {
        throw new Error(`Streaming upstream response exceeded ${maxBytes} decompressed bytes`)
      }
      yield buffer
    }
  } finally {
    decompressedBody.destroy()
    compressedBody.destroy()
  }
}
