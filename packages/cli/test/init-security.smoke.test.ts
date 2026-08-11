import { describe, expect, it } from "vitest"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPricingCatalog } from "@own-harness/core"
import { bootstrap, initProject } from "../src/bootstrap.js"
import { telemetryEnable } from "../src/commands/telemetry.js"

describe("project initialization security", () => {
  it("provisions current DeepSeek V4 pricing for every supported wire provider", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-init-pricing-"))
    process.env.HARNESS_HOME = root
    try {
      initProject(root)
      const config = readFileSync(join(root, "harness.config.yaml"), "utf8")
      expect(config).not.toMatch(/^\s+authToken:/m)
      expect(config).not.toMatch(/^\s+signatureSecret:/m)
      expect(config).toContain('# authTokenEnv: "HARNESS_SERVER_AUTH_TOKEN"')
      expect(config).toContain('#   signatureSecretEnv: "HARNESS_DISTRIBUTION_SIGNATURE_SECRET"')
      expect(config.match(/model: "\*deepseek-v4-pro\*"/g)).toHaveLength(3)
      expect(config.match(/model: "\*deepseek-v4-flash\*"/g)).toHaveLength(3)
      expect(config).toContain("inputPerMillion: 0.435")
      expect(config).toContain("cacheReadInputPerMillion: 0.0435")
      expect(config).toContain("outputPerMillion: 0.87")
      expect(config).toContain("inputPerMillion: 0.14")
      expect(config).toContain("cacheReadInputPerMillion: 0.014")
      expect(config).toContain("outputPerMillion: 0.28")
      const boot = bootstrap(root)
      expect(boot.authToken).toMatch(/^[a-f0-9]{64}$/)
      expect(statSync(join(root, "auth-token")).mode & 0o777).toBe(0o600)
      const pricing = createPricingCatalog(boot.config)
      const estimate = pricing.estimate({
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        cacheReadTokensIn: 1_000_000
      })
      expect(estimate.pricingStatus).toBe("priced")
      expect(estimate.costUsd).toBe(0.294)
    } finally {
      delete process.env.HARNESS_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("resolves configured secrets from named environment variables without exposing values in errors", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-init-secret-env-"))
    const serverEnvironmentVariable = "OWN_HARNESS_TEST_BOOTSTRAP_SERVER_TOKEN"
    const distributionEnvironmentVariable = "OWN_HARNESS_TEST_BOOTSTRAP_SIGNATURE_SECRET"
    const serverSecret = "server-secret-value-123456"
    const distributionSecret = "distribution-secret-value-0123456789abcdef0123456789"
    process.env.HARNESS_HOME = root
    try {
      initProject(root)
      const configPath = join(root, "harness.config.yaml")
      const config = readFileSync(configPath, "utf8")
        .replace(
          '  # authTokenEnv: "HARNESS_SERVER_AUTH_TOKEN"',
          `  authTokenEnv: "${serverEnvironmentVariable}"`
        )
        .replace(
          '# distribution:\n#   serverUrl: "https://harness.example.com"\n#   signatureSecretEnv: "HARNESS_DISTRIBUTION_SIGNATURE_SECRET"',
          `distribution:\n  signatureSecretEnv: "${distributionEnvironmentVariable}"`
        )
      writeFileSync(configPath, config, "utf8")

      expect(() => bootstrap(root)).toThrow(`unset environment variable ${serverEnvironmentVariable}`)
      process.env[serverEnvironmentVariable] = serverSecret
      process.env[distributionEnvironmentVariable] = distributionSecret
      const boot = bootstrap(root)
      expect(boot.serverAuthToken).toBe(serverSecret)
      expect(boot.distributionSignatureSecret).toBe(distributionSecret)

      process.env[serverEnvironmentVariable] = "too-short"
      let message = ""
      try {
        bootstrap(root)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("must contain at least 16 characters")
      expect(message).not.toContain("too-short")
    } finally {
      delete process.env[serverEnvironmentVariable]
      delete process.env[distributionEnvironmentVariable]
      delete process.env.HARNESS_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a symbolic-link destination before writing project files", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-init-symlink-file-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-init-outside-file-"))
    const outsideTarget = join(outside, "target.sh")
    const hookDirectory = join(root, ".harness", "hooks")
    writeFileSync(outsideTarget, "unchanged", "utf8")
    mkdirSync(hookDirectory, { recursive: true })
    symlinkSync(outsideTarget, join(hookDirectory, "claude-hooks.sh"))

    try {
      expect(() => initProject(root)).toThrow("symbolic link")
      expect(readFileSync(outsideTarget, "utf8")).toBe("unchanged")
      expect(existsSync(join(root, "harness.config.yaml"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects a symbolic-link parent before writing project files", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-init-symlink-parent-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-init-outside-parent-"))
    symlinkSync(outside, join(root, ".harness"))

    try {
      expect(() => initProject(root)).toThrow("symbolic link")
      expect(existsSync(join(outside, "policies", "default.yaml"))).toBe(false)
      expect(existsSync(join(root, "harness.config.yaml"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects workspace-selected storage and accepts only an absolute HARNESS_HOME override", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-store-boundary-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-store-outside-"))
    try {
      initProject(root)
      const configPath = join(root, "harness.config.yaml")
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8").replace('home: "~/.own-harness"', `home: "${outside}"`),
        "utf8"
      )
      expect(() => bootstrap(root)).toThrow("Invalid literal value, expected")
      expect(existsSync(join(outside, "state.db"))).toBe(false)

      const telemetryTarget = join(outside, "telemetry-target.json")
      writeFileSync(telemetryTarget, "unchanged", "utf8")
      const defaultConfig = readFileSync(configPath, "utf8")
        .replace(`home: "${outside}"`, 'home: "~/.own-harness"')
      writeFileSync(
        configPath,
        defaultConfig
          .replace("  enabled: false", "  enabled: true")
          .replace('optInFile: "~/.own-harness/telemetry.json"', `optInFile: "${telemetryTarget}"`),
        "utf8"
      )
      expect(() => telemetryEnable(root)).toThrow("Invalid literal value, expected")
      expect(readFileSync(telemetryTarget, "utf8")).toBe("unchanged")

      writeFileSync(configPath, defaultConfig, "utf8")
      process.env.HARNESS_HOME = "relative-store"
      expect(() => bootstrap(root)).toThrow("HARNESS_HOME must be an absolute directory path")
      process.env.HARNESS_HOME = outside
      const boot = bootstrap(root)
      expect(boot.storePath).toBe(join(realpathSync(outside), "state.db"))
      expect(boot.telemetryPath).toBe(join(realpathSync(outside), "telemetry.json"))
    } finally {
      delete process.env.HARNESS_HOME
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects auth-token symlinks and repairs regular token permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-auth-token-"))
    const harnessHome = join(root, "application-home")
    const outsidePath = join(root, "outside-token")
    const token = "a".repeat(64)
    try {
      initProject(root)
      mkdirSync(harnessHome, { mode: 0o700 })
      writeFileSync(outsidePath, `${token}\n`, { encoding: "utf8", mode: 0o600 })
      symlinkSync(outsidePath, join(harnessHome, "auth-token"))
      process.env.HARNESS_HOME = harnessHome
      expect(() => bootstrap(root)).toThrow("symbolic link")
      expect(readFileSync(outsidePath, "utf8")).toBe(`${token}\n`)

      rmSync(join(harnessHome, "auth-token"))
      writeFileSync(join(harnessHome, "auth-token"), `${token}\n`, { encoding: "utf8", mode: 0o644 })
      chmodSync(join(harnessHome, "auth-token"), 0o644)
      expect(bootstrap(root).authToken).toBe(token)
      expect(statSync(join(harnessHome, "auth-token")).mode & 0o777).toBe(0o600)
    } finally {
      delete process.env.HARNESS_HOME
      rmSync(root, { recursive: true, force: true })
    }
  })
})
