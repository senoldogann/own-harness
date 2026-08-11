import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import Fastify from "fastify"
import {
  createPricingCatalog,
  createPolicyBundle,
  createTelemetryService,
  HarnessStore,
  parsePolicyConfig,
  sha256,
  type PolicyBundle,
  verifyPolicyBundle
} from "@own-harness/core"
import {
  createProxy as createHarnessProxy,
  type HarnessProxy,
  type ProxyOptions
} from "../src/index.js"

const TEST_MANAGEMENT_TOKEN = "test-management-token-0123456789abcdef"

function createProxy(
  options: Omit<ProxyOptions, "managementToken"> & { readonly managementToken?: string }
): HarnessProxy {
  return createHarnessProxy({
    ...options,
    managementToken: options.managementToken ?? TEST_MANAGEMENT_TOKEN
  })
}

function managementHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` }
}

describe("proxy fake provider", () => {
  let fakeProvider: ReturnType<typeof Fastify>
  let fakeUrl: string
  let tempDir: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "own-harness-proxy-"))
    fakeProvider = Fastify()
    fakeProvider.post("/v1/responses", async () => ({
      id: "resp",
      model: "gpt-5",
      usage: {
        input_tokens: 100,
        output_tokens: 50
      }
    }))
    await fakeProvider.listen({ port: 0 })
    const address = fakeProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("fake provider did not bind to a port")
    }
    fakeUrl = `http://127.0.0.1:${address.port}/v1`
  })

  afterEach(async () => {
    await fakeProvider.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("passes requests through and records stats", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: [
          {
            provider: "openai",
            model: "gpt-*",
            inputPerMillion: 2.5,
            outputPerMillion: 10
          }
        ]
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        input: "hello"
      })
    })
    expect(response.status).toBe(200)
    const statsResponse = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/api/v1/stats/summary`, {
      headers: managementHeaders(TEST_MANAGEMENT_TOKEN)
    })
    const stats = await statsResponse.json() as { totalRequests: number }
    expect(stats.totalRequests).toBe(1)
    await proxy.stop()
  })

  it("requires a separate secret for signed policy bundles", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "block",
          type: "request",
          match: { providers: ["openai"] },
          action: "deny",
          reason: "blocked"
        }
      ]
    }))
    const authToken = "enterprise-token-1234567890"
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      authToken,
      managementToken: authToken
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/api/v1/policy/bundle`, {
      headers: { authorization: `Bearer ${authToken}` }
    })
    expect(response.status).toBe(503)
    await proxy.stop()

    const signatureSecret = "policy-signature-secret-1234567890"
    const signedProxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      authToken,
      managementToken: authToken,
      policySignatureSecret: signatureSecret
    })
    await signedProxy.start()
    const signedResponse = await fetch(`http://127.0.0.1:${proxyAddress(signedProxy)}/api/v1/policy/bundle`, {
      headers: { authorization: `Bearer ${authToken}` }
    })
    expect(signedResponse.status).toBe(200)
    const payload = await signedResponse.json() as PolicyBundle
    expect(payload.policy.mode).toBe("enforce")
    expect(verifyPolicyBundle(payload, authToken)).toBe(false)
    expect(verifyPolicyBundle(payload, signatureSecret)).toBe(true)
    const expected = createPolicyBundle(policy, signatureSecret, payload.signedAt)
    expect(payload.version).toBe(expected.version)
    await signedProxy.stop()
  })

  it("blocks deny rules in enforce mode", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: []
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "block",
          type: "request",
          match: {
            providers: ["openai"]
          },
          action: "deny",
          reason: "blocked"
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(403)
    expect(store.countBlockedRequests()).toBe(1)
    await proxy.stop()
  })

  it("serves exact-match cache hits from the local store", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: []
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache",
          type: "request",
          match: {
            providers: ["openai"]
          },
          action: "cache",
          reason: "cache",
          config: { ttlMinutes: 60, exactOnly: true }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const body = JSON.stringify({ model: "gpt-5", input: "same" })
    const authHeaders = { "content-type": "application/json", authorization: "Bearer test" }
    const first = await fetch(url, { method: "POST", headers: authHeaders, body })
    const second = await fetch(url, { method: "POST", headers: authHeaders, body })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").filter((request) => request.cacheHit)).toHaveLength(1)
    await proxy.stop()
  })

  it("records upstream network failures as request errors", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: []
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: "http://127.0.0.1:1",
      upstreamOpenAi: "http://127.0.0.1:1",
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(502)
    const requests = store.listRequestsSince("1970-01-01T00:00:00Z")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.status).toBe("error")
    await proxy.stop()
  })

  it("streams SSE responses through the proxy", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: []
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({ model: "gpt-5", stream: true })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("resp")
    await proxy.stop()
  })

  it("streams real-time SSE chunks through the proxy", async () => {
    const streamingProvider = Fastify()
    streamingProvider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("data: first\n\n")
      reply.raw.write("data: second\n\n")
      reply.raw.end()
    })
    await streamingProvider.listen({ port: 0 })
    const address = streamingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("streaming provider did not bind to a port")
    }
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: []
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({ model: "gpt-5", stream: true })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("data: second")
    await proxy.stop()
    await streamingProvider.close()
  })

  it("records token usage from SSE usage events", async () => {
    const streamingProvider = Fastify()
    streamingProvider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n")
      reply.raw.write("data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50}}\n\n")
      reply.raw.end()
    })
    await streamingProvider.listen({ port: 0 })
    const address = streamingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("streaming provider did not bind to a port")
    }

    const tempDir = mkdtempSync(join(tmpdir(), "own-harness-proxy-sse-usage-"))
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({ model: "gpt-5", stream: true })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("response.completed")
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.tokensIn).toBe(100)
    expect(request?.tokensOut).toBe(50)
    await proxy.stop()
    await streamingProvider.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("accounts for usage and hashes the full SSE stream beyond the former buffer limit", async () => {
    const streamingProvider = Fastify()
    const delta = "x".repeat(512 * 1024)
    const dataLines = Array.from(
      { length: 17 },
      () => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`
    )
    const completionLine = `data: ${JSON.stringify({
      type: "response.completed",
      usage: { input_tokens: 321, output_tokens: 123 }
    })}\n\n`
    const fullStream = `${dataLines.join("")}${completionLine}`
    streamingProvider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      for (const line of dataLines) {
        reply.raw.write(line)
      }
      reply.raw.end(completionLine)
    })
    await streamingProvider.listen({ port: 0 })
    const address = streamingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("large streaming provider did not bind to a port")
    }

    const streamDir = mkdtempSync(join(tmpdir(), "own-harness-proxy-large-sse-"))
    const store = new HarnessStore({ dbPath: join(streamDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-large-sse",
      projectHash: "project-large-sse",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({ model: "gpt-5", stream: true })
    })
    const received = await response.text()
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]

    expect(received.length).toBeGreaterThan(8 * 1024 * 1024)
    expect(request?.tokensIn).toBe(321)
    expect(request?.tokensOut).toBe(123)
    expect(request?.outputHash).toBe(sha256(fullStream))
    await proxy.stop()
    await streamingProvider.close()
    store.close()
    rmSync(streamDir, { recursive: true, force: true })
  })

  it("distinguishes completed SSE responses from premature client disconnects", async () => {
    const streamingProvider = Fastify()
    streamingProvider.post("/v1/responses", async (request, reply) => {
      const body = request.body as { readonly model: string }
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      const event = body.model === "gpt-completed"
        ? "data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":8,\"output_tokens\":3}}\n\n"
        : "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"
      reply.raw.write(event)
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
      reply.raw.end()
    })
    await streamingProvider.listen({ port: 0 })
    const address = streamingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("streaming provider did not bind to a port")
    }
    const streamDir = mkdtempSync(join(tmpdir(), "own-harness-proxy-sse-client-close-"))
    const store = new HarnessStore({ dbPath: join(streamDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-client-close",
      projectHash: "project-client-close",
      agent: "codex"
    })
    await proxy.start()
    const cancelAfterFirstChunk = async (model: string): Promise<string> => {
      const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ model, stream: true })
      })
      const reader = response.body?.getReader()
      if (reader === undefined) {
        throw new Error(`streaming response body is unavailable for model ${model}`)
      }
      const firstChunk = await reader.read()
      await reader.cancel()
      return new TextDecoder().decode(firstChunk.value)
    }
    expect(await cancelAfterFirstChunk("gpt-completed")).toContain("response.completed")
    expect(await cancelAfterFirstChunk("gpt-incomplete")).toContain("response.output_text.delta")
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const requests = store.listRequestsSince("1970-01-01T00:00:00Z")
    expect(requests.find((request) => request.model === "gpt-completed")?.status).toBe("ok")
    expect(requests.find((request) => request.model === "gpt-incomplete")?.status).toBe("error")
    await proxy.stop()
    await streamingProvider.close()
    rmSync(streamDir, { recursive: true, force: true })
  })

  it("records OpenAI Responses usage from response.completed.response.usage", async () => {
    const streamingProvider = Fastify()
    streamingProvider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"E2E-OK\"}\n\n")
      reply.raw.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":16,\"output_tokens\":5}}}\n\n")
      reply.raw.end()
    })
    await streamingProvider.listen({ port: 0 })
    const address = streamingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("streaming provider did not bind to a port")
    }

    const tempDir = mkdtempSync(join(tmpdir(), "own-harness-proxy-sse-responses-usage-"))
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({ model: "deepseek-v4-flash", stream: true })
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("response.completed")
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.tokensIn).toBe(16)
    expect(request?.tokensOut).toBe(5)
    await proxy.stop()
    await streamingProvider.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("records Anthropic SSE usage from nested message usage", async () => {
    const streamingProvider = Fastify()
    streamingProvider.post("/v1/messages", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("event: message_start\n")
      reply.raw.write("data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":100,\"output_tokens\":0}}}\n\n")
      reply.raw.write("event: content_block_delta\n")
      reply.raw.write("data: {\"type\":\"content_block_delta\",\"delta\":{\"text_delta\":\"hello\"}}\n\n")
      reply.raw.write("event: message_delta\n")
      reply.raw.write("data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":50}}\n\n")
      reply.raw.write("event: message_stop\n")
      reply.raw.write("data: {\"type\":\"message_stop\"}\n\n")
      reply.raw.end()
    })
    await streamingProvider.listen({ port: 0 })
    const address = streamingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("streaming provider did not bind to a port")
    }

    const tempDir = mkdtempSync(join(tmpdir(), "own-harness-proxy-sse-anthropic-"))
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "claude"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({ model: "claude-3-5-haiku", stream: true })
    })
    expect(response.status).toBe(200)
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.tokensIn).toBe(100)
    expect(request?.tokensOut).toBe(50)
    await proxy.stop()
    await streamingProvider.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("applies tool policy to ingest and blocks destructive commands", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "deny-destructive",
          type: "tool",
          match: { tools: ["Bash"], commandRegex: "rm -rf /" },
          action: "deny",
          reason: "destructive"
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/api/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ tool: "Bash", command: "rm -rf /" })
    })
    expect(response.status).toBe(403)
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.status).toBe("blocked")
    expect(store.countAuditDecisions()).toBe(0)
    await proxy.stop()
  })

  it("rejects invalid ingest bodies", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/api/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({
        tool: "Bash",
        command: "git status",
        durationMs: -100,
        exitCode: 1.5
      })
    })
    expect(response.status).toBe(400)
    await proxy.stop()
  })

  it("redacts secrets from stored tool commands", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/api/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ tool: "Bash", command: `echo ${secret}` })
    })
    expect(response.status).toBe(201)
    const stored = store.listToolCallsSince("1970-01-01T00:00:00Z")[0]
    expect(stored?.command).toContain("[REDACTED]")
    expect(stored?.command).not.toContain(secret)
    await proxy.stop()
  })

  it("blocks requests when a session deny rule matches", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "session-deny",
          type: "session",
          match: { project: "abc" },
          action: "deny",
          reason: "session blocked"
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(403)
    expect(store.countBlockedRequests()).toBe(1)
    await proxy.stop()
  })

  it("does not cache requests that enable streaming in the body", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "cache",
          config: { ttlMinutes: 60, exactOnly: true }
        }
      ]
    }))
    const provider = Fastify()
    provider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50}}\n\n")
      reply.raw.end("data: [DONE]\n\n")
    })
    await provider.listen({ port: 0 })
    const address = provider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("sse cache provider did not bind to a port")
    }
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const body = JSON.stringify({ model: "gpt-5", stream: true })
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      })
      expect(response.status).toBe(200)
    }
    const requests = store.listRequestsSince("1970-01-01T00:00:00Z")
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => !request.cacheHit)).toBe(true)
    await proxy.stop()
    await provider.close()
  })

  it("rejects non-loopback proxy hosts", () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    expect(() => createProxy({
      host: "0.0.0.0",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })).toThrow("Proxy host must be 127.0.0.1")
    expect(() => createHarnessProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      managementToken: ""
    })).toThrow("managementToken must be a nonempty string")
    store.close()
  })

  it("rejects remote proxy hosts even with an auth token", () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    expect(() => createProxy({
      host: "0.0.0.0",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })).toThrow("Proxy host must be 127.0.0.1")
    expect(() => createProxy({
      host: "0.0.0.0",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      authToken: "0123456789abcdef"
    })).toThrow("Proxy host must be 127.0.0.1")
    store.close()
  })

  it("uses separate required management and optional provider credentials", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      authToken: "provider-token-0123456789abcdef",
      managementToken: "management-token-0123456789abcdef"
    })
    await proxy.start()
    const baseUrl = `http://127.0.0.1:${proxyAddress(proxy)}`
    const unauthorized = await fetch(`${baseUrl}/api/v1/requests`)
    expect(unauthorized.status).toBe(401)
    const authorized = await fetch(`${baseUrl}/api/v1/requests`, {
      headers: { authorization: "Bearer management-token-0123456789abcdef" }
    })
    expect(authorized.status).toBe(200)
    const providerUnauthorized = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(providerUnauthorized.status).toBe(401)
    const providerAuthorized = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer provider-token-0123456789abcdef"
      },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(providerAuthorized.status).toBe(200)
    await proxy.stop()
  })

  it("isolates invalid loopback floods from valid management and provider capacity", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "rate-auth-isolation.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-rate-auth-isolation",
      projectHash: "project-rate-auth-isolation",
      agent: "codex",
      authToken: "provider-rate-token-0123456789abcdef",
      managementToken: "management-rate-token-0123456789abcdef",
      rateLimit: { maxRequests: 1, windowMs: 60_000, maxIdentities: 1 }
    })
    const authLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
    for (let requestIndex = 0; requestIndex < 10; requestIndex += 1) {
      await proxy.app.inject({
        method: "GET",
        url: "/api/v1/requests",
        headers: { authorization: "Bearer invalid-management-token" },
        remoteAddress: "127.0.0.1"
      })
      await proxy.app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer invalid-provider-token"
        },
        payload: { model: "gpt-5", input: "invalid flood" },
        remoteAddress: "127.0.0.1"
      })
    }
    authLog.mockRestore()

    const management = await proxy.app.inject({
      method: "GET",
      url: "/api/v1/requests",
      headers: { authorization: "Bearer management-rate-token-0123456789abcdef" },
      remoteAddress: "127.0.0.1"
    })
    const provider = await proxy.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer provider-rate-token-0123456789abcdef"
      },
      payload: { model: "gpt-5", input: "valid request" },
      remoteAddress: "127.0.0.1"
    })
    const health = await proxy.app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: "127.0.0.1"
    })
    expect(management.statusCode).toBe(200)
    expect(provider.statusCode).toBe(200)
    expect(health.statusCode).toBe(200)

    const managementLimited = await proxy.app.inject({
      method: "GET",
      url: "/api/v1/requests",
      headers: { authorization: "Bearer management-rate-token-0123456789abcdef" },
      remoteAddress: "127.0.0.1"
    })
    const providerLimited = await proxy.app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer provider-rate-token-0123456789abcdef"
      },
      payload: { model: "gpt-5", input: "second valid request" },
      remoteAddress: "127.0.0.1"
    })
    expect(managementLimited.statusCode).toBe(429)
    expect(providerLimited.statusCode).toBe(429)
    await proxy.stop()
    store.close()
  })

  it("isolates deliberately unauthenticated provider traffic from management and health", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "rate-anonymous-provider.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-rate-anonymous-provider",
      projectHash: "project-rate-anonymous-provider",
      agent: "codex",
      rateLimit: { maxRequests: 1, windowMs: 60_000, maxIdentities: 1 }
    })
    const providerRequest = {
      method: "POST" as const,
      url: "/v1/responses",
      headers: { "content-type": "application/json" },
      payload: { model: "gpt-5", input: "anonymous provider" },
      remoteAddress: "127.0.0.1"
    }
    expect((await proxy.app.inject(providerRequest)).statusCode).toBe(200)
    expect((await proxy.app.inject(providerRequest)).statusCode).toBe(429)
    expect((await proxy.app.inject({ method: "GET", url: "/health", remoteAddress: "127.0.0.1" })).statusCode).toBe(200)
    expect((await proxy.app.inject({
      method: "GET",
      url: "/api/v1/requests",
      headers: managementHeaders(TEST_MANAGEMENT_TOKEN),
      remoteAddress: "127.0.0.1"
    })).statusCode).toBe(200)
    await proxy.stop()
    store.close()
  })

  it("does not replay cache across different auth scopes", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "cache",
          config: { ttlMinutes: 60, exactOnly: true }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const body = JSON.stringify({ model: "gpt-5", input: "same" })
    const first = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer one" },
      body
    })
    const second = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer two" },
      body
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").filter((request) => request.cacheHit)).toHaveLength(0)
    await proxy.stop()
  })

  it("does not replay cache across different organizations with the same credential", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "cache",
          config: { ttlMinutes: 60, exactOnly: true }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const body = JSON.stringify({ model: "gpt-5", input: "same" })
    const headers = (organization: string) => ({
      "content-type": "application/json",
      authorization: "Bearer shared",
      "openai-organization": organization
    })
    const first = await fetch(url, { method: "POST", headers: headers("org-a"), body })
    const second = await fetch(url, { method: "POST", headers: headers("org-b"), body })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").filter((request) => request.cacheHit)).toHaveLength(0)
    await proxy.stop()
  })

  it("isolates session budget cost by session and project", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "budget-session",
          type: "session",
          match: { project: "*" },
          action: "budget",
          reason: "budget",
          config: { maxUsd: 0.001 }
        }
      ]
    }))
    const projectId = store.findOrCreateProject("other", "other")
    store.insertSession({
      id: "session-other",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    store.insertRequest({
      id: "request-other",
      sessionId: "session-other",
      agent: "codex",
      provider: "openai",
      projectHash: "other",
      model: "gpt-5",
      inputHash: "in",
      outputHash: "out",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 1,
      cacheHit: false,
      decisionId: "default",
      durationMs: 10,
      status: "ok",
      createdAt: new Date().toISOString()
    })
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(200)
    expect(store.countBlockedRequests()).toBe(0)
    await proxy.stop()
  })

  it("redacts secrets that span SSE chunk boundaries", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
    const provider = Fastify()
    provider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write(`data: {"type":"response.completed","content":"${secret.slice(0, 25)}`)
      reply.raw.write(`${secret.slice(25)}"}\n\n`)
      reply.raw.end("data: [DONE]\n\n")
    })
    await provider.listen({ port: 0 })
    const address = provider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("chunk provider did not bind to a port")
    }
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", stream: true })
    })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain(secret)
    expect(text).toContain("[REDACTED]")
    await proxy.stop()
    await provider.close()
  })

  it("blocks requests when session budget is exceeded", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "budget-project",
          type: "session",
          match: { project: "*" },
          action: "budget",
          reason: "budget",
          config: { maxUsd: 0.001 }
        }
      ]
    }))
    const storeProjectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId: storeProjectId,
      agent: "codex",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    store.insertRequest({
      id: "request-budget",
      sessionId: "session-1",
      agent: "codex",
      provider: "openai",
      projectHash: "abc",
      model: "gpt-5",
      inputHash: "in",
      outputHash: "out",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      cacheHit: false,
      decisionId: "default",
      durationMs: 10,
      status: "ok",
      createdAt: new Date().toISOString()
    })
    store.insertCostRecord({
      requestId: "request-budget",
      provider: "openai",
      model: "gpt-5",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      currency: "USD"
    })
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(429)
    expect(store.countBlockedRequests()).toBe(1)
    await proxy.stop()
  })

  it("redacts matching secrets in outbound request bodies", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "redact-secrets",
          type: "request",
          match: { providers: ["openai"] },
          action: "redact",
          reason: "redact",
          config: { patterns: ["Bearer [A-Za-z0-9]+"] }
        }
      ]
    }))
    let receivedBody: unknown
    const provider = Fastify()
    provider.post("/v1/responses", async (request) => {
      receivedBody = request.body
      return { id: "resp", model: "gpt-5" }
    })
    await provider.listen({ port: 0 })
    const address = provider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("redact provider did not bind to a port")
    }
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", credentials: "Bearer secret123" })
    })
    expect(response.status).toBe(200)
    expect(receivedBody).toMatchObject({ credentials: "[REDACTED]" })
    await proxy.stop()
    await provider.close()
  })

  it("compresses long outbound request text before forwarding", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "compress-long",
          type: "request",
          match: { providers: ["openai"] },
          action: "compress",
          reason: "compress",
          config: { maxChars: 20 }
        }
      ]
    }))
    let receivedBody: unknown
    const provider = Fastify()
    provider.post("/v1/responses", async (request) => {
      receivedBody = request.body
      return { id: "resp", model: "gpt-5" }
    })
    await provider.listen({ port: 0 })
    const address = provider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("compress provider did not bind to a port")
    }
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "a".repeat(200) })
    })
    expect(response.status).toBe(200)
    const received = receivedBody as { input?: string }
    expect(received.input?.length).toBeLessThan(100)
    expect(received.input).toContain("truncated by own-harness")
    await proxy.stop()
    await provider.close()
  })

  it("rejects policy routes with incompatible provider protocols", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "route-cheap",
          type: "request",
          match: { providers: ["openai"] },
          action: "route",
          reason: "route",
          config: { routeTo: "openai-compatible" }
        }
      ]
    }))
    let routedPath = ""
    const provider = Fastify()
    provider.post("/v1/chat/completions", async () => {
      routedPath = "/v1/chat/completions"
      return { id: "chat", model: "gpt-5" }
    })
    provider.post("/v1/responses", async () => {
      routedPath = "/v1/responses"
      return { id: "resp", model: "gpt-5" }
    })
    await provider.listen({ port: 0 })
    const address = provider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("route provider did not bind to a port")
    }
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Incompatible provider route: openai to openai-compatible"
    })
    expect(routedPath).toBe("")
    await proxy.stop()
    await provider.close()
  })

  it("records provider response usage instead of request-only estimates", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: [{ provider: "openai", model: "gpt-*", inputPerMillion: 2.5, outputPerMillion: 10 }]
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "hello" })
    })
    expect(response.status).toBe(200)
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.tokensIn).toBe(100)
    expect(request?.tokensOut).toBe(50)
    await proxy.stop()
  })

  it("records and discounts provider cache-read input tokens", async () => {
    const cacheProvider = Fastify()
    cacheProvider.post("/v1/responses", async () => ({
      id: "cached-response",
      usage: {
        input_tokens: 1_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 800 }
      }
    }))
    await cacheProvider.listen({ port: 0 })
    const address = cacheProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("cache provider did not bind to a port")
    }
    const store = new HarnessStore({ dbPath: join(tempDir, "cache-state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: [{
          provider: "openai",
          model: "gpt-*",
          inputPerMillion: 1_000,
          cacheReadInputPerMillion: 100,
          outputPerMillion: 2_000
        }]
      }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const upstream = `http://127.0.0.1:${address.port}/v1`
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: upstream,
      upstreamOpenAi: upstream,
      store,
      pricing,
      policy,
      sessionId: "cache-session",
      projectHash: "cache-project",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "hello" })
    })
    expect(response.status).toBe(200)
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.cacheReadTokensIn).toBe(800)
    expect(request?.costUsd).toBe(0.38)
    const cost = store.listCostRecords()[0]
    expect(cost?.cacheReadTokensIn).toBe(800)
    expect(cost?.costUsd).toBe(0.38)
    await proxy.stop()
    await cacheProvider.close()
  })

  it("returns command hashes instead of raw tool commands from stats tools", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    store.insertToolCall({
      id: "tool-1",
      sessionId: "session-1",
      agent: "codex",
      projectHash: "abc",
      tool: "Bash",
      command: "git status",
      commandHash: "hash-1",
      exitCode: 0,
      durationMs: 10,
      status: "ok"
    })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/api/v1/stats/tools`, {
      headers: managementHeaders(TEST_MANAGEMENT_TOKEN)
    })
    const payload = await response.json() as { tools: Array<{ command?: string; commandHash: string }> }
    expect(response.status).toBe(200)
    expect(payload.tools[0]?.command).toBeUndefined()
    expect(payload.tools[0]?.commandHash).toBe(sha256("git status"))
    await proxy.stop()
  })

  it("serves semantic cache hits for near-duplicate prompts", async () => {
    let upstreamCalls = 0
    const semanticProvider = Fastify()
    semanticProvider.post("/v1/responses", async () => {
      upstreamCalls += 1
      return {
        id: "resp-semantic",
        model: "gpt-5",
        usage: { input_tokens: 100, output_tokens: 50 }
      }
    })
    await semanticProvider.listen({ port: 0 })
    const address = semanticProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("semantic provider did not bind to a port")
    }

    const semanticDir = mkdtempSync(join(tmpdir(), "own-harness-semantic-"))
    const store = new HarnessStore({ dbPath: join(semanticDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache-semantic",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "semantic",
          config: {
            ttlMinutes: 60,
            normalized: true,
            similarityThreshold: 0.8,
            maxCandidates: 100
          }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const headers = { "content-type": "application/json", authorization: "Bearer test" }
    const first = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "Please summarize the document now" })
    })
    const nearDuplicate = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "Please summarize the document now please" })
    })
    const normalizedExact = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "  Please summarize the document now  " })
    })
    expect(first.status).toBe(200)
    expect(nearDuplicate.status).toBe(200)
    expect(normalizedExact.status).toBe(200)
    expect(upstreamCalls).toBe(1)
    const requests = store.listRequestsSince("1970-01-01T00:00:00Z")
    expect(requests.filter((request) => request.cacheHit)).toHaveLength(2)
    expect(await nearDuplicate.text()).toBe(await first.text())
    await proxy.stop()
    await semanticProvider.close()
    rmSync(semanticDir, { recursive: true, force: true })
  })

  it("misses semantic cache when similarity is below the threshold", async () => {
    let upstreamCalls = 0
    const semanticProvider = Fastify()
    semanticProvider.post("/v1/responses", async () => {
      upstreamCalls += 1
      return { id: "resp-semantic-miss", model: "gpt-5" }
    })
    await semanticProvider.listen({ port: 0 })
    const address = semanticProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("semantic miss provider did not bind to a port")
    }

    const semanticDir = mkdtempSync(join(tmpdir(), "own-harness-semantic-miss-"))
    const store = new HarnessStore({ dbPath: join(semanticDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache-semantic",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "semantic",
          config: {
            ttlMinutes: 60,
            normalized: true,
            similarityThreshold: 0.8,
            maxCandidates: 100
          }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const headers = { "content-type": "application/json", authorization: "Bearer test" }
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "Please summarize the document now" })
    })
    const different = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "What is the weather today" })
    })
    expect(different.status).toBe(200)
    expect(upstreamCalls).toBe(2)
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").filter((request) => request.cacheHit)).toHaveLength(0)
    await proxy.stop()
    await semanticProvider.close()
    rmSync(semanticDir, { recursive: true, force: true })
  })

  it("keeps semantic cache isolated by credential scope", async () => {
    let upstreamCalls = 0
    const semanticProvider = Fastify()
    semanticProvider.post("/v1/responses", async () => {
      upstreamCalls += 1
      return { id: "resp-semantic-scope", model: "gpt-5" }
    })
    await semanticProvider.listen({ port: 0 })
    const address = semanticProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("semantic scope provider did not bind to a port")
    }

    const semanticDir = mkdtempSync(join(tmpdir(), "own-harness-semantic-scope-"))
    const store = new HarnessStore({ dbPath: join(semanticDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache-semantic",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "semantic",
          config: {
            ttlMinutes: 60,
            normalized: true,
            similarityThreshold: 0.8,
            maxCandidates: 100
          }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const tenantA = { "content-type": "application/json", authorization: "Bearer tenant-a" }
    const tenantB = { "content-type": "application/json", authorization: "Bearer tenant-b" }
    await fetch(url, {
      method: "POST",
      headers: tenantA,
      body: JSON.stringify({ model: "gpt-5", input: "Please summarize the document now" })
    })
    const otherTenant = await fetch(url, {
      method: "POST",
      headers: tenantB,
      body: JSON.stringify({ model: "gpt-5", input: "Please summarize the document now please" })
    })
    expect(otherTenant.status).toBe(200)
    expect(upstreamCalls).toBe(2)
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").filter((request) => request.cacheHit)).toHaveLength(0)
    await proxy.stop()
    await semanticProvider.close()
    rmSync(semanticDir, { recursive: true, force: true })
  })

  it("never caches semantic streaming responses", async () => {
    let upstreamCalls = 0
    const semanticProvider = Fastify()
    semanticProvider.post("/v1/responses", async (_request, reply) => {
      upstreamCalls += 1
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}\n\n")
      reply.raw.end()
    })
    await semanticProvider.listen({ port: 0 })
    const address = semanticProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("semantic stream provider did not bind to a port")
    }

    const semanticDir = mkdtempSync(join(tmpdir(), "own-harness-semantic-stream-"))
    const store = new HarnessStore({ dbPath: join(semanticDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "cache-semantic",
          type: "request",
          match: { providers: ["openai"] },
          action: "cache",
          reason: "semantic",
          config: {
            ttlMinutes: 60,
            normalized: true,
            similarityThreshold: 0.8,
            maxCandidates: 100
          }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex"
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: "Bearer test"
    }
    const body = (input: string) => JSON.stringify({ model: "gpt-5", input, stream: true })
    await fetch(url, { method: "POST", headers, body: body("Please summarize the document now") })
    const second = await fetch(url, {
      method: "POST",
      headers,
      body: body("Please summarize the document now please")
    })
    expect(second.status).toBe(200)
    expect(upstreamCalls).toBe(2)
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").filter((request) => request.cacheHit)).toHaveLength(0)
    await proxy.stop()
    await semanticProvider.close()
    rmSync(semanticDir, { recursive: true, force: true })
  })

  it("does not forward the proxy auth token to the upstream provider", async () => {
    let receivedAuthorization: string | undefined
    const authProvider = Fastify()
    authProvider.post("/v1/responses", async (request) => {
      receivedAuthorization = request.headers.authorization
      return { id: "resp-auth", model: "gpt-5" }
    })
    await authProvider.listen({ port: 0 })
    const address = authProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("auth provider did not bind to a port")
    }

    const authDir = mkdtempSync(join(tmpdir(), "own-harness-auth-leak-"))
    const store = new HarnessStore({ dbPath: join(authDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxyAuthToken = "0123456789abcdef0123456789abcdef"
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      authToken: proxyAuthToken
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxyAuthToken}`
      },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(response.status).toBe(200)
    expect(receivedAuthorization).toBeUndefined()
    await proxy.stop()
    await authProvider.close()
    rmSync(authDir, { recursive: true, force: true })
  })

  it("protects management endpoints with a local management token", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const managementToken = "management-token-0123456789abcdef"
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      managementToken
    })
    await proxy.start()
    const base = `http://127.0.0.1:${proxyAddress(proxy)}`
    const locked = await fetch(`${base}/api/v1/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ tool: "Bash", command: "git status" })
    })
    expect(locked.status).toBe(401)
    const authorized = await fetch(`${base}/api/v1/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${managementToken}`
      },
      body: JSON.stringify({ tool: "Bash", command: "git status" })
    })
    expect(authorized.status).toBe(201)
    const hello = await fetch(`${base}/api/hello`)
    expect(hello.status).toBe(200)
    expect(await hello.json()).toEqual({ message: "hello" })
    const authLog = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const managementQuery = await fetch(`${base}/api/v1/requests?source=secret-value`)
    expect(managementQuery.status).toBe(401)
    expect(authLog).toHaveBeenCalledWith(JSON.stringify({
      event: "management_auth_failed",
      path: "/api/v1/requests"
    }))
    expect(authLog.mock.calls.flat().join(" ")).not.toContain("secret-value")
    authLog.mockRestore()
    const provider = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ model: "gpt-5" })
    })
    expect(provider.status).toBe(200)
    await proxy.stop()
  })

  it("bounds rate-limit identities and purges expired windows on an amortized sweep", async () => {
    const store = new HarnessStore({ dbPath: join(tempDir, "rate-window.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: fakeUrl,
      upstreamOpenAi: fakeUrl,
      store,
      pricing,
      policy,
      sessionId: "session-rate-window",
      projectHash: "project-rate-window",
      agent: "codex",
      rateLimit: { maxRequests: 1000, windowMs: 5, maxIdentities: 2 }
    })
    const first = await proxy.app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.1" })
    const second = await proxy.app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.2" })
    const overCapacity = await proxy.app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.3" })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(overCapacity.statusCode).toBe(429)

    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    for (let requestIndex = 0; requestIndex < 252; requestIndex += 1) {
      await proxy.app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.1" })
    }
    const afterSweep = await proxy.app.inject({ method: "GET", url: "/health", remoteAddress: "10.0.0.3" })
    expect(afterSweep.statusCode).toBe(200)
    await proxy.stop()
    store.close()
  })

  it("translates chat completions to the Responses API without streaming", async () => {
    let translatedRequestBody: unknown
    const responsesProvider = Fastify()
    responsesProvider.post("/v1/responses", async (request) => {
      translatedRequestBody = request.body
      return ({
      id: "resp-chat",
      model: "deepseek-v4-flash",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from responses" }]
        }
      ],
      usage: { input_tokens: 100, output_tokens: 20 }
      })
    })
    await responsesProvider.listen({ port: 0 })
    const address = responsesProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("responses provider did not bind to a port")
    }

    const chatDir = mkdtempSync(join(tmpdir(), "own-harness-chat-translate-"))
    const store = new HarnessStore({ dbPath: join(chatDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0, translateChatToResponses: true },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "redact-translated-chat",
          type: "request",
          match: { providers: ["openai-compatible"] },
          action: "redact",
          reason: "redact before translation",
          config: { patterns: ["translated-secret"] }
        }
      ]
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "opencode",
      translateChatToResponses: true
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer harness-local"
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi translated-secret" }],
        stream: false
      })
    })
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      object: string
      choices: Array<{ message: { content: string } }>
      usage?: { prompt_tokens: number; completion_tokens: number }
    }
    expect(payload.object).toBe("chat.completion")
    expect(payload.choices[0]?.message.content).toBe("hello from responses")
    expect(payload.usage?.prompt_tokens).toBe(100)
    expect(payload.usage?.completion_tokens).toBe(20)
    expect(translatedRequestBody).toMatchObject({
      input: [{ role: "user", content: "hi [REDACTED]" }]
    })
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.tokensIn).toBe(100)
    expect(request?.tokensOut).toBe(20)
    await proxy.stop()
    await responsesProvider.close()
    rmSync(chatDir, { recursive: true, force: true })
  })

  it("translates streaming chat completions from Responses SSE events", async () => {
    const responsesProvider = Fastify()
    responsesProvider.post("/v1/responses", async (_request, reply) => {
      reply.raw.writeHead(200, { "content-type": "text/event-stream" })
      reply.raw.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello \"}\n\n")
      reply.raw.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"stream\"}\n\n")
      reply.raw.write("data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20,\"input_tokens_details\":{\"cached_tokens\":80}}}\n\n")
      reply.raw.end()
    })
    await responsesProvider.listen({ port: 0 })
    const address = responsesProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("responses stream provider did not bind to a port")
    }

    const chatDir = mkdtempSync(join(tmpdir(), "own-harness-chat-translate-stream-"))
    const store = new HarnessStore({ dbPath: join(chatDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0, translateChatToResponses: true },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "opencode",
      translateChatToResponses: true
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      })
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("chat.completion.chunk")
    expect(text).toContain("content\":\"hello ")
    expect(text).toContain("content\":\"stream")
    expect(text).toContain("data: [DONE]")
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.tokensIn).toBe(100)
    expect(request?.cacheReadTokensIn).toBe(80)
    expect(request?.tokensOut).toBe(20)
    await proxy.stop()
    await responsesProvider.close()
    rmSync(chatDir, { recursive: true, force: true })
  })

  it("rejects automatic routing across incompatible provider protocols", async () => {
    let lastPath = ""
    const routingProvider = Fastify()
    routingProvider.post("/v1/responses", async () => {
      lastPath = "/v1/responses"
      return { id: "resp-original", model: "gpt-5" }
    })
    routingProvider.post("/v1/chat/completions", async () => {
      lastPath = "/v1/chat/completions"
      return { id: "chat-routed", model: "gpt-5" }
    })
    await routingProvider.listen({ port: 0 })
    const address = routingProvider.server.address()
    if (typeof address === "string" || address === null) {
      throw new Error("routing provider did not bind to a port")
    }

    const routingDir = mkdtempSync(join(tmpdir(), "own-harness-routing-"))
    const store = new HarnessStore({ dbPath: join(routingDir, "state.db") })
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: `http://127.0.0.1:${address.port}/v1`,
      upstreamOpenAi: `http://127.0.0.1:${address.port}/v1`,
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      routing: {
        mode: "enforce",
        rules: [
          {
            id: "auto-cheap",
            modelRegex: "gpt-5",
            provider: "openai-compatible",
            reason: "route gpt-5 to compatible provider"
          }
        ]
      }
    })
    await proxy.start()
    const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "hi" })
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: "Incompatible provider route: openai to openai-compatible"
    })
    expect(lastPath).toBe("")
    await proxy.stop()
    await routingProvider.close()
    rmSync(routingDir, { recursive: true, force: true })
  })

  it("hardens proxy transport, ignores client tool hints, records telemetry, and rate limits", async () => {
    let upstreamCalls = 0
    let gzipAttempts = 0
    let serverErrorAttempts = 0
    let throttleAttempts = 0
    const hardenedProvider = Fastify()
    hardenedProvider.post("/v1/responses", async (request, reply) => {
      upstreamCalls += 1
      const body = request.body as { readonly input?: unknown; readonly stream?: unknown }
      if (body.input === "gzip") {
        gzipAttempts += 1
        const compressed = gzipSync(JSON.stringify({ id: "resp-gzip", model: "gpt-5" }))
        reply.raw.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip"
        })
        reply.raw.end(compressed)
        return
      }
      if (body.input === "server-error") {
        serverErrorAttempts += 1
        reply.status(503).send({ error: "ambiguous" })
        return
      }
      if (body.input === "throttle") {
        throttleAttempts += 1
        reply.header("retry-after", "0").status(429).send({ error: "throttled" })
        return
      }
      if (body.input === "gzip-stream-bomb") {
        const decompressed = "data: {\"delta\":\"x\"}\n\n".repeat(800_000)
        const compressed = gzipSync(decompressed)
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "content-encoding": "gzip"
        })
        reply.raw.end(compressed)
        return
      }
      if (body.stream === true) {
        const compressed = gzipSync(
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"parçalı\"}\n\n" +
          "data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}\n\n"
        )
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "content-encoding": "gzip"
        })
        reply.raw.write(compressed.subarray(0, 7))
        reply.raw.write(compressed.subarray(7, 19))
        reply.raw.end(compressed.subarray(19))
        return
      }
      reply.send({ id: `resp-${upstreamCalls}`, model: "gpt-5" })
    })
    await hardenedProvider.listen({ host: "127.0.0.1", port: 0 })
    const providerAddress = hardenedProvider.server.address()
    if (providerAddress === null || typeof providerAddress === "string") {
      throw new Error("hardened provider did not bind to a port")
    }
    const hardenedDir = mkdtempSync(join(tmpdir(), "own-harness-hardened-proxy-"))
    const store = new HarnessStore({ dbPath: join(hardenedDir, "state.db") })
    const telemetry = createTelemetryService(
      true,
      join(hardenedDir, "telemetry.json"),
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    telemetry.enable()
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 0 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: true, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const upstream = `http://127.0.0.1:${providerAddress.port}/v1`
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: upstream,
      upstreamOpenAi: upstream,
      store,
      pricing,
      policy,
      sessionId: "session-hardened",
      projectHash: "project-hardened",
      agent: "codex",
      telemetry,
      rateLimit: { maxRequests: 30, windowMs: 60_000 }
    })
    await proxy.start()
    const url = `http://127.0.0.1:${proxyAddress(proxy)}/v1/responses`
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer tenant",
      "x-harness-tools": "Read"
    }
    const untrustedBody = JSON.stringify({ model: "gpt-5", input: "header-only" })
    await fetch(url, { method: "POST", headers, body: untrustedBody })
    await fetch(url, { method: "POST", headers, body: untrustedBody })
    expect(upstreamCalls).toBe(2)

    const trustedBody = JSON.stringify({
      model: "gpt-5",
      input: "body-tools",
      tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object" } }]
    })
    await fetch(url, { method: "POST", headers, body: trustedBody })
    await fetch(url, { method: "POST", headers, body: trustedBody })
    expect(upstreamCalls).toBe(4)

    const gzipResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "gzip" })
    })
    expect(gzipResponse.status).toBe(200)
    expect(await gzipResponse.json()).toMatchObject({ id: "resp-gzip" })
    expect(gzipAttempts).toBe(1)

    const serverErrorResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "server-error" })
    })
    expect(serverErrorResponse.status).toBe(503)
    expect(serverErrorAttempts).toBe(1)

    const retryWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const throttleResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5", input: "throttle" })
    })
    expect(throttleResponse.status).toBe(429)
    expect(await throttleResponse.json()).toEqual({ error: "throttled" })
    expect(throttleAttempts).toBe(1)
    expect(retryWarning.mock.calls.flat().join(" ")).toContain("upstream_retry_disabled")
    retryWarning.mockRestore()

    const streamResponse = await fetch(url, {
      method: "POST",
      headers: { ...headers, accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-5", input: "stream", stream: true })
    })
    expect(await streamResponse.text()).toContain("parçalı")
    const bombResponse = await fetch(url, {
      method: "POST",
      headers: { ...headers, accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-5", input: "gzip-stream-bomb", stream: true })
    })
    await bombResponse.text()
    expect(store.listRequestsSince("1970-01-01T00:00:00Z").at(-1)?.status).toBe("error")
    expect(telemetry.export().some((event) => event.eventType === "proxy_request")).toBe(true)
    expect(store.listCostRecords().some((record) => record.pricingStatus === "unpriced")).toBe(true)
    expect(telemetry.export().some((event) => event.payloadJson.includes("pricingStatus"))).toBe(true)

    const ingestUrl = `http://127.0.0.1:${proxyAddress(proxy)}/api/v1/ingest`
    const hookBase = {
      tool: "Bash",
      command: "git status",
      sessionId: "session-hardened",
      agent: "claude",
      projectHash: "project-hardened",
      toolUseId: "toolu-integrated"
    }
    await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ ...hookBase, hookEvent: "PreToolUse", exitCode: null, durationMs: 0 })
    })
    await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ ...hookBase, hookEvent: "PostToolUse", exitCode: 0, durationMs: 123 })
    })
    const toolCall = store.listToolCallsSince("1970-01-01T00:00:00Z")[0]
    expect(toolCall).toMatchObject({ exitCode: 0, durationMs: 123, status: "ok" })
    const duplicateResult = await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ ...hookBase, hookEvent: "PostToolUse", exitCode: 0, durationMs: 124 })
    })
    expect(duplicateResult.status).toBe(500)

    const mismatchedHook = { ...hookBase, toolUseId: "toolu-mismatch" }
    await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({ ...mismatchedHook, hookEvent: "PreToolUse", exitCode: null, durationMs: 0 })
    })
    const mismatchedResult = await fetch(ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...managementHeaders(TEST_MANAGEMENT_TOKEN) },
      body: JSON.stringify({
        ...mismatchedHook,
        projectHash: "different-project",
        hookEvent: "PostToolUse",
        exitCode: 0,
        durationMs: 125
      })
    })
    expect(mismatchedResult.status).toBe(500)

    let rateLimited = false
    for (let requestIndex = 0; requestIndex < 31; requestIndex += 1) {
      const response = await fetch(`http://127.0.0.1:${proxyAddress(proxy)}/health`)
      if (response.status === 429) {
        rateLimited = true
        expect(response.headers.get("retry-after")).not.toBeNull()
        break
      }
    }
    expect(rateLimited).toBe(true)
    await proxy.stop()
    store.close()
    await hardenedProvider.close()
    rmSync(hardenedDir, { recursive: true, force: true })
  })
})

function proxyAddress(proxy: { app: { server: { address: () => string | import("node:net").AddressInfo | null } } }): number {
  const address = proxy.app.server.address()
  if (address === null || typeof address === "string") {
    throw new Error("proxy did not bind to a port")
  }
  return address.port
}
