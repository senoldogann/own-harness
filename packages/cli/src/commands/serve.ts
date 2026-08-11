import { createProxy, type HarnessProxy } from "@own-harness/proxy"
import { createPricingCatalog, HarnessStore } from "@own-harness/core"
import { randomId, sha256 } from "@own-harness/core"
import { bootstrap, createBootstrapTelemetry } from "../bootstrap.js"

export async function runServe(cwd: string): Promise<void> {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  const serverHost = boot.config.server?.host ?? boot.config.proxy.host
  const authToken = boot.serverAuthToken
  const projectHash = sha256(cwd)
  const projectId = store.findOrCreateProject(projectHash, cwd)
  const sessionId = randomId()
  store.insertSession({
    id: sessionId,
    projectId,
    agent: "claude",
    status: "active",
    startedAt: new Date().toISOString(),
    endedAt: null
  })
  const pricing = createPricingCatalog(boot.config)
  const proxy: HarnessProxy = createProxy({
    host: serverHost,
    port: boot.config.proxy.port,
    upstreamAnthropic: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
    upstreamOpenAi: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    store,
    pricing,
    policy: boot.policy,
    sessionId,
    projectHash,
    agent: "claude",
    telemetry: createBootstrapTelemetry(store, boot),
    managementToken: boot.authToken,
    ...(authToken === undefined ? {} : { authToken }),
    ...(boot.distributionSignatureSecret === undefined
      ? {}
      : { policySignatureSecret: boot.distributionSignatureSecret }),
    ...(boot.config.proxy.translateChatToResponses === true
      ? { translateChatToResponses: true }
      : {}),
    ...(boot.config.routing === undefined ? {} : { routing: boot.config.routing })
  })
  let proxyStarted = false
  let stopped = false
  const stop = async () => {
    if (stopped) {
      return
    }
    stopped = true
    if (proxyStarted) {
      await proxy.stop()
    }
    store.endSession(sessionId)
    store.close()
  }
  try {
    const url = await proxy.start()
    proxyStarted = true
    console.log("Proxy listening on", url)
  } catch (error) {
    await stop()
    throw error
  }
  process.on("SIGINT", () => {
    void stop().then(() => process.exit(0))
  })
  process.on("SIGTERM", () => {
    void stop().then(() => process.exit(0))
  })
}
