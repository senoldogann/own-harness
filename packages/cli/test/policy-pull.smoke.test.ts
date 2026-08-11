import { describe, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPricingCatalog, HarnessStore, parsePolicyConfig } from "@own-harness/core"
import { createProxy } from "@own-harness/proxy"
import { initProject } from "../src/bootstrap.js"
import { pullPolicy } from "../src/commands/policy.js"
import { readTextFile, writeTextFile } from "../src/fs-utils.js"

describe("policy pull", () => {
  it("pulls a verified signed policy bundle from the proxy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-policy-pull-"))
    process.env.HARNESS_HOME = dir
    initProject(dir)
    const originalPolicy = readTextFile(join(dir, ".harness", "policies", "default.yaml"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
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
          id: "remote-rule",
          type: "request",
          match: { providers: ["openai"] },
          action: "deny",
          reason: "remote"
        }
      ]
    }))
    const authToken = "enterprise-token-1234567890"
    const authTokenEnvironmentVariable = "OWN_HARNESS_TEST_SERVER_AUTH_TOKEN"
    const signatureSecretEnvironmentVariable = "OWN_HARNESS_TEST_DISTRIBUTION_SIGNATURE_SECRET"
    process.env[authTokenEnvironmentVariable] = authToken
    process.env[signatureSecretEnvironmentVariable] = "policy-secret-1234567890abcdef1234567890abcdef"
    const proxy = createProxy({
      host: "127.0.0.1",
      port: 0,
      upstreamAnthropic: "http://127.0.0.1:9",
      upstreamOpenAi: "http://127.0.0.1:9",
      store,
      pricing,
      policy,
      sessionId: "session-1",
      projectHash: "abc",
      agent: "codex",
      authToken,
      managementToken: authToken,
      policySignatureSecret: "policy-secret-1234567890abcdef1234567890abcdef"
    })
    try {
      const proxyUrl = await proxy.start()
      process.env.HARNESS_POLICY_SERVER_URL = proxyUrl.replace(/\/$/, "")
      writeTextFile(
        join(dir, "harness.config.yaml"),
        configWithDistribution(
          dir,
          proxyUrl,
          authTokenEnvironmentVariable,
          signatureSecretEnvironmentVariable
        )
      )
      await pullPolicy(dir, undefined, undefined)
      expect(readTextFile(join(dir, ".harness", "policies", "default.yaml"))).toContain("remote-rule")
      const backupDir = join(dir, ".harness", "policies", "backups")
      const backupNames = readdirSync(backupDir)
      expect(backupNames).toHaveLength(1)
      expect(readTextFile(join(backupDir, backupNames[0] ?? "missing"))).toBe(originalPolicy)

      const outsideBackupDir = mkdtempSync(join(tmpdir(), "own-harness-policy-outside-backup-"))
      rmSync(backupDir, { recursive: true, force: true })
      symlinkSync(outsideBackupDir, backupDir)
      writeTextFile(join(dir, ".harness", "policies", "default.yaml"), originalPolicy)
      await expect(pullPolicy(dir, undefined, undefined)).rejects.toThrow("Unsafe directory component")
      expect(readdirSync(outsideBackupDir)).toHaveLength(0)
      expect(readTextFile(join(dir, ".harness", "policies", "default.yaml"))).toBe(originalPolicy)
      rmSync(backupDir)
      rmSync(outsideBackupDir, { recursive: true, force: true })

      const outsidePolicyDir = mkdtempSync(join(tmpdir(), "own-harness-policy-outside-final-"))
      const outsidePolicyPath = join(outsidePolicyDir, "default.yaml")
      writeTextFile(outsidePolicyPath, originalPolicy)
      rmSync(join(dir, ".harness", "policies", "default.yaml"))
      symlinkSync(outsidePolicyPath, join(dir, ".harness", "policies", "default.yaml"))
      await expect(pullPolicy(dir, undefined, undefined)).rejects.toThrow("symbolic link")
      expect(readTextFile(outsidePolicyPath)).toBe(originalPolicy)
      rmSync(outsidePolicyDir, { recursive: true, force: true })
    } finally {
      delete process.env.HARNESS_HOME
      delete process.env.HARNESS_POLICY_SERVER_URL
      delete process.env[authTokenEnvironmentVariable]
      delete process.env[signatureSecretEnvironmentVariable]
      await proxy.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function configWithDistribution(
  dir: string,
  serverUrl: string,
  authTokenEnvironmentVariable: string,
  signatureSecretEnvironmentVariable: string
): string {
  return `version: 1
proxy:
  host: "127.0.0.1"
  port: 4321
store:
  home: "~/.own-harness"
  retentionDays: 90
telemetry:
  enabled: false
  optInFile: "~/.own-harness/telemetry.json"
server:
  host: "127.0.0.1"
  authTokenEnv: "${authTokenEnvironmentVariable}"
distribution:
  serverUrl: "${serverUrl}"
  signatureSecretEnv: "${signatureSecretEnvironmentVariable}"
pricing:
  defaultCurrency: "USD"
  models: []
`
}
