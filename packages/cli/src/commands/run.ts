import type { ChildProcess } from "node:child_process"
import { createAdapter, createProxy, type HarnessProxy } from "@own-harness/proxy"
import { createPricingCatalog, HarnessStore, randomId, sha256 } from "@own-harness/core"
import { bootstrap, createBootstrapTelemetry } from "../bootstrap.js"
import { ensureDir } from "../fs-utils.js"

export async function runAgent(kind: "claude" | "codex" | "opencode", cwd: string, args: readonly string[]): Promise<void> {
  const boot = bootstrap(cwd)
  const baseUrl = `http://${boot.config.proxy.host}:${boot.config.proxy.port}`
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  const projectHash = sha256(cwd)
  const sessionId = randomId()
  let proxyStarted = false
  let proxy: HarnessProxy | null = null
  let child: ChildProcess | null = null
  let stopped = false
  const previousHarnessIngestToken = process.env.HARNESS_INGEST_TOKEN
  const stop = async () => {
    if (stopped) {
      return
    }
    stopped = true
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
    }
    if (proxy !== null && proxyStarted) {
      await proxy.stop()
    }
    store.endSession(sessionId)
    store.close()
    if (previousHarnessIngestToken === undefined) {
      delete process.env.HARNESS_INGEST_TOKEN
    } else {
      process.env.HARNESS_INGEST_TOKEN = previousHarnessIngestToken
    }
  }
  const onSignal = (signal: NodeJS.Signals) => {
    void stop().then(() => process.exit(signal === "SIGINT" ? 130 : 143))
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  try {
    const projectId = store.findOrCreateProject(projectHash, cwd)
    store.insertSession({
      id: sessionId,
      projectId,
      agent: kind,
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    const pricing = createPricingCatalog(boot.config)
    proxy = createProxy({
      host: boot.config.proxy.host,
      port: boot.config.proxy.port,
      upstreamAnthropic: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      upstreamOpenAi: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      store,
      pricing,
      policy: boot.policy,
      sessionId,
      projectHash,
      agent: kind,
      telemetry: createBootstrapTelemetry(store, boot),
      managementToken: boot.authToken,
      ...(boot.distributionSignatureSecret === undefined
        ? {}
        : { policySignatureSecret: boot.distributionSignatureSecret }),
      ...(boot.config.proxy.translateChatToResponses === true
        ? { translateChatToResponses: true }
        : {}),
      ...(boot.config.routing === undefined ? {} : { routing: boot.config.routing })
    })
    process.env.HARNESS_INGEST_TOKEN = boot.ingestToken
    await proxy.start()
    proxyStarted = true
    const adapter = createAdapter(kind, baseUrl)
    if (kind === "codex") {
      ensureDir(`${cwd}/.harness/codex`)
    }
    child = adapter.launch({ args, cwd, sessionId, projectHash })
    const exitCode = await new Promise<number>((resolve, reject) => {
      child?.once("error", (error) => reject(error))
      child?.once("exit", (code) => resolve(code ?? 1))
    })
    if (exitCode !== 0) {
      process.exitCode = exitCode
    }
  } catch (error) {
    if (child !== null && child.exitCode === null) {
      child.kill()
    }
    throw error
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    await stop()
  }
}
