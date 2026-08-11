import { spawnSync, type ChildProcess } from "node:child_process"
import { createCodexDesktopAdapter } from "@own-harness/desktop"
import { createProxy, type HarnessProxy } from "@own-harness/proxy"
import { createPricingCatalog, HarnessStore, randomId, sha256 } from "@own-harness/core"
import { bootstrap, createBootstrapTelemetry } from "../bootstrap.js"

export interface AttachResult {
  readonly desktop: string
  readonly status: "verified" | "launched" | "unsupported"
  readonly reason: string
}

export async function attachDesktop(
  cwd: string,
  desktop: string,
  args: readonly string[],
  verifyOnly: boolean
): Promise<AttachResult> {
  if (desktop !== "codex") {
    return {
      desktop,
      status: "unsupported",
      reason: `Unsupported desktop adapter: ${desktop}; supported: codex`
    }
  }
  const boot = bootstrap(cwd)
  const device = verifyDevice("codex")
  if (!device.found) {
    return {
      desktop,
      status: "unsupported",
      reason: `codex binary not found on PATH: ${device.path ?? ""}`
    }
  }
  if (verifyOnly) {
    console.log(JSON.stringify({
      desktop,
      status: "verified",
      platform: process.platform,
      binary: device.path,
      store: boot.storePath
    }, null, 2))
    return {
      desktop,
      status: "verified",
      reason: "codex binary and harness project are ready"
    }
  }

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
      agent: "chatgpt-desktop",
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
      agent: "chatgpt-desktop",
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
    const adapter = createCodexDesktopAdapter()
    child = adapter.launch({
      baseUrl,
      cwd,
      sessionId,
      projectHash,
      args
    })
    const exitCode = await new Promise<number>((resolve, reject) => {
      child?.once("error", (error) => reject(error))
      child?.once("exit", (code) => resolve(code ?? 1))
    })
    if (exitCode !== 0) {
      process.exitCode = exitCode
    }
    return {
      desktop,
      status: "launched",
      reason: `Attached Codex Desktop session ${sessionId}`
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

function verifyDevice(binary: string): {
  readonly found: boolean
  readonly path: string | null
} {
  const result = spawnSync("which", [binary], { encoding: "utf8" })
  const path = result.status === 0 ? (result.stdout.trim() || null) : null
  return {
    found: path !== null,
    path
  }
}
