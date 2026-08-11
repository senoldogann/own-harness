import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  createLearningLoop,
  createPricingCatalog,
  createPolicyBundle,
  createPromptShingles,
  createStatsEngine,
  createTelemetryService,
  diceSimilarity,
  evaluatePolicy,
  extractResponseUsage,
  extractUsageFromSse,
  FileEncryptionKeyStore,
  HarnessStore,
  MacOsKeychainEncryptionKeyStore,
  normalizePromptText,
  parseHarnessConfig,
  parsePolicyConfig,
  redactSecrets,
  requireEncryptedRemoteUrl,
  rewriteCommandWithRtk,
  sha256,
  verifyPolicyBundle
} from "../src/index.js"

describe("core smoke", () => {
  it("accepts only environment references for configured server and distribution secrets", () => {
    const config = {
      version: 1,
      proxy: { host: "127.0.0.1", port: 4103 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      server: { host: "127.0.0.1", authTokenEnv: "HARNESS_SERVER_AUTH_TOKEN" },
      distribution: {
        serverUrl: "https://harness.example.com",
        signatureSecretEnv: "HARNESS_DISTRIBUTION_SIGNATURE_SECRET"
      },
      pricing: { defaultCurrency: "USD", models: [] }
    }

    expect(parseHarnessConfig(JSON.stringify(config))).toMatchObject(config)
    expect(() => parseHarnessConfig(JSON.stringify({
      ...config,
      server: { host: "127.0.0.1", authToken: "plaintext-token-123456" }
    }))).toThrow("Unrecognized key(s) in object: 'authToken'")
    expect(() => parseHarnessConfig(JSON.stringify({
      ...config,
      distribution: { signatureSecret: "plaintext-secret" }
    }))).toThrow("Unrecognized key(s) in object: 'signatureSecret'")
    expect(() => parseHarnessConfig(JSON.stringify({
      ...config,
      server: { host: "127.0.0.1", authTokenEnv: "INVALID-NAME" }
    }))).toThrow("must be a valid environment variable name")
    expect(() => parseHarnessConfig(JSON.stringify({
      ...config,
      server: { host: "0.0.0.0", authTokenEnv: "HARNESS_SERVER_AUTH_TOKEN" }
    }))).toThrow("Invalid literal value, expected")
    expect(() => parseHarnessConfig(JSON.stringify({
      ...config,
      store: { home: "/tmp/workspace-selected-store", retentionDays: 90 }
    }))).toThrow("Invalid literal value, expected")
    expect(() => parseHarnessConfig(JSON.stringify({
      ...config,
      telemetry: { enabled: false, optInFile: "/tmp/workspace-selected-telemetry.json" }
    }))).toThrow("Invalid literal value, expected")
  })

  it("persists a session with the correct project and agent columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-session-columns-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const projectId = store.insertProject("project-hash", "project")
    store.insertSession({
      id: "session-columns",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: "2026-08-11T00:00:00.000Z",
      endedAt: null
    })
    expect(store.listSessions()).toEqual([{
      id: "session-columns",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: "2026-08-11T00:00:00.000Z",
      endedAt: null
    }])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("rolls back a completed request when a related write fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-completion-rollback-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertPolicyDecision({
      id: "duplicate-decision",
      requestId: "existing-request",
      ruleId: "existing-rule",
      action: "log",
      mode: "audit",
      reason: "existing"
    })

    expect(() => store.recordCompletedRequest({
      request: {
        id: "request-atomic",
        sessionId: "session-atomic",
        agent: "codex",
        provider: "openai",
        projectHash: "project-atomic",
        model: "gpt-5",
        inputHash: "input-hash",
        outputHash: "output-hash",
        tokensIn: 4,
        tokensOut: 2,
        costUsd: 0.01,
        estimatedCostUsd: 0.01,
        cacheHit: false,
        decisionId: "rule-atomic",
        durationMs: 10,
        status: "ok",
        createdAt: new Date().toISOString()
      },
      cost: {
        requestId: "request-atomic",
        provider: "openai",
        model: "gpt-5",
        tokensIn: 4,
        tokensOut: 2,
        costUsd: 0.01,
        currency: "USD"
      },
      policyDecisions: [{
        id: "duplicate-decision",
        requestId: "request-atomic",
        ruleId: "rule-atomic",
        action: "allow",
        mode: "enforce",
        reason: "atomic"
      }]
    })).toThrow()

    expect(store.listRequestsSince("1970-01-01T00:00:00Z")).toHaveLength(0)
    expect(store.listCostRecords()).toHaveLength(0)
    expect(store.listPolicyDecisions()).toHaveLength(1)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("allows cleartext HTTP only for loopback service URLs", () => {
    expect(requireEncryptedRemoteUrl("http://127.0.0.1:4103", "test").hostname).toBe("127.0.0.1")
    expect(() => requireEncryptedRemoteUrl("http://example.com", "test")).toThrow("must use HTTPS")
    expect(() => requireEncryptedRemoteUrl("https://user:secret@example.com", "test"))
      .toThrow("must not contain user information")
  })

  it("redacts common credential formats", () => {
    expect(redactSecrets("token SK-abc12345")).toContain("[REDACTED]")
    expect(redactSecrets("token sk-ABC12345")).toContain("[REDACTED]")
    expect(redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ")).toContain("[REDACTED]")
    expect(redactSecrets("token xoxb-1234567890-abcdefghij")).toContain("[REDACTED]")
    expect(redactSecrets("token AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz12")).toContain("[REDACTED]")
    expect(redactSecrets("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-here")).toContain("[REDACTED]")
    expect(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----"))
      .toContain("[REDACTED]")
  })

  it("generates exact command-specific deny proposals from blocked tool calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-learning-tool-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertToolCall({
      id: "tool-write",
      sessionId: "session-1",
      agent: "claude",
      projectHash: "abc",
      tool: "Write",
      command: "write file",
      commandHash: "hash-write",
      exitCode: null,
      durationMs: 1,
      status: "blocked"
    })
    const loop = createLearningLoop(store)
    const ids = loop.optimize("1970-01-01T00:00:00Z")
    expect(ids.length).toBeGreaterThan(0)
    const proposal = loop.listProposals()[0]
    if (proposal === undefined) {
      throw new Error("deny proposal is missing")
    }
    expect(proposal.kind).toBe("deny")
    expect(JSON.parse(proposal.ruleJson)).toMatchObject({
      match: { tools: ["Write"], commandRegex: "^write file$" },
      action: "deny"
    })
    expect(loop.optimize("1970-01-01T00:00:00Z")).toHaveLength(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not generate deny proposals when stored command evidence was redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-learning-redacted-deny-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertToolCall({
      id: "tool-secret",
      sessionId: "session-1",
      agent: "claude",
      projectHash: "abc",
      tool: "Bash",
      command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'",
      commandHash: "ignored",
      exitCode: null,
      durationMs: 1,
      status: "blocked"
    })
    const loop = createLearningLoop(store)
    expect(loop.optimize("1970-01-01T00:00:00Z")).toHaveLength(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("records timestamps on policy decisions and refresh cache timestamps on hits", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-store-time-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertPolicyDecision({
      id: "decision-time",
      requestId: "request-time",
      ruleId: "rule",
      action: "deny",
      mode: "enforce",
      reason: "test"
    })
    const decision = store.listPolicyDecisions()[0]
    expect(decision?.createdAt).not.toBe("")
    store.upsertCacheEntry({
      keyHash: "key",
      provider: "openai",
      model: "gpt-5",
      projectHash: "abc",
      accountFingerprint: "acct",
      upstreamUrl: "https://example.com",
      contentType: "application/json",
      responseJson: "{}",
      estimatedCostUsd: 0,
      normalizedInputHash: "norm",
      shingleHashes: [1, 2],
      createdAt: "2000-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    })
    store.upsertCacheEntry({
      keyHash: "key",
      provider: "openai",
      model: "gpt-5",
      projectHash: "abc",
      accountFingerprint: "acct",
      upstreamUrl: "https://example.com",
      contentType: "application/json",
      responseJson: "{}",
      estimatedCostUsd: 0,
      normalizedInputHash: "norm",
      shingleHashes: [1, 2],
      createdAt: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z"
    })
    store.purgeExpired(1)
    expect(store.getCacheEntry({
      keyHash: "key",
      provider: "openai",
      model: "gpt-5",
      projectHash: "abc",
      accountFingerprint: "acct",
      upstreamUrl: "https://example.com"
    })?.responseJson).toBe("{}")
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(join(dir, "state.db"))
    const persisted = raw
      .prepare("SELECT response_json AS responseJson FROM cache_entries WHERE key_hash = 'key'")
      .get() as { readonly responseJson: string }
    expect(persisted.responseJson).not.toContain("{}")
    expect(persisted.responseJson.startsWith("ohc1:")).toBe(true)
    raw.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("normalizes prompt text and computes shingle similarity", () => {
    const first = normalizePromptText({
      model: "gpt-5",
      tools: [{ type: "function", function: { name: "read_file" } }],
      input: "  Please   summarize the document now  "
    })
    const second = normalizePromptText({
      input: "Please summarize the document now please"
    })
    expect(first).toBe("Please summarize the document now")
    expect(second).not.toBe(first)
    expect(diceSimilarity(createPromptShingles(first), createPromptShingles(first))).toBe(1)
    expect(diceSimilarity(createPromptShingles(first), createPromptShingles(second))).toBeGreaterThan(0.85)
    expect(diceSimilarity(createPromptShingles(first), createPromptShingles("What is the weather today"))).toBe(0)
  })

  it("stores requests, evaluates policy, and produces stats", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-core-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const projectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    store.insertRequest({
      id: "request-1",
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
      durationMs: 120,
      status: "ok",
      createdAt: new Date().toISOString()
    })
    store.insertCostRecord({
      requestId: "request-1",
      provider: "openai",
      model: "gpt-5",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.01,
      currency: "USD",
      pricingStatus: "priced"
    })
    expect(store.listCostRecords()[0]?.pricingStatus).toBe("priced")
    store.insertToolCall({
      id: "tool-1",
      sessionId: "session-1",
      agent: "codex",
      projectHash: "abc",
      tool: "Bash",
      command: "git status",
      commandHash: "hash",
      exitCode: 0,
      durationMs: 10,
      status: "ok"
    })
    const stats = createStatsEngine(store).summary()
    expect(stats.totalRequests).toBe(1)
    expect(stats.totalCostUsd).toBe(0.01)
    expect(stats.byAgent.codex).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("encrypts tool commands at rest and decrypts them through the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-tool-encryption-"))
    const dbPath = join(dir, "state.db")
    const secretCommand = "curl -u alice:plainpassword https://example.invalid"
    const store = new HarnessStore({ dbPath })
    store.insertToolCall({
      id: "encrypted-tool",
      sessionId: "session-1",
      agent: "codex",
      projectHash: "abc",
      tool: "Bash",
      command: secretCommand,
      commandHash: "ignored",
      exitCode: 0,
      durationMs: 1,
      status: "ok"
    })
    store.close()

    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(dbPath)
    const row = raw.prepare("SELECT command FROM tool_calls WHERE id = ?").get("encrypted-tool") as {
      readonly command: string
    }
    expect(row.command).toMatch(/^oht1:/)
    expect(row.command).not.toContain("plainpassword")
    raw.close()

    const reopened = new HarnessStore({ dbPath })
    expect(reopened.listToolCallsSince("1970-01-01T00:00:00Z")[0]?.command).toBe(secretCommand)
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("finalizes only the exact pending tool lifecycle record once", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-tool-finalize-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertToolCall({
      id: "tool-pending",
      sessionId: "session-1",
      agent: "cursor",
      projectHash: "project-1",
      tool: "Shell",
      command: "pnpm test",
      commandHash: "ignored",
      exitCode: null,
      durationMs: 0,
      status: "ok"
    })

    expect(() => store.updateToolCallResult({
      callId: "tool-pending",
      sessionId: "session-attacker",
      agent: "cursor",
      projectHash: "project-1",
      tool: "Shell",
      exitCode: 1,
      durationMs: 10,
      status: "error"
    })).toThrow("no matching pending PreToolUse record")
    expect(store.listToolCallsSince("1970-01-01T00:00:00Z")[0]?.exitCode).toBeNull()

    const finalResult = {
      callId: "tool-pending",
      sessionId: "session-1",
      agent: "cursor" as const,
      projectHash: "project-1",
      tool: "Shell",
      exitCode: 0,
      durationMs: 31,
      status: "ok" as const
    }
    store.updateToolCallResult(finalResult)
    expect(store.listToolCallsSince("1970-01-01T00:00:00Z")[0]).toMatchObject({
      exitCode: 0,
      durationMs: 31,
      status: "ok"
    })
    expect(() => store.updateToolCallResult(finalResult)).toThrow(
      "no matching pending PreToolUse record"
    )
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects symbolic links in database file and state path components", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-db-path-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-db-outside-"))
    const outsideFile = join(outside, "outside.db")
    writeFileSync(outsideFile, "unchanged", "utf8")
    symlinkSync(outsideFile, join(root, "state.db"))
    expect(() => new HarnessStore({ dbPath: join(root, "state.db") })).toThrow(
      "expected a regular file"
    )

    rmSync(join(root, "state.db"))
    symlinkSync(outside, join(root, "linked-parent"))
    expect(() => new HarnessStore({ dbPath: join(root, "linked-parent", "state.db") })).toThrow(
      "Unsafe directory component"
    )
    expect(readFileSync(outsideFile, "utf8")).toBe("unchanged")
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it.runIf(process.platform === "darwin")(
    "migrates legacy file-encrypted cache and tool rows into macOS Keychain",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "own-harness-keychain-migration-"))
      const dbPath = join(dir, "state.db")
      const legacyKeyPath = `${dbPath}.cache-key`
      const legacyEncodedKey = randomBytes(32).toString("base64")
      const keychainService = `dev.own-harness.integration-test.${randomUUID()}`
      const keychainAccount = "store-master-v1"
      writeFileSync(legacyKeyPath, `${legacyEncodedKey}\n`, { encoding: "utf8", mode: 0o600 })

      try {
        const legacyStore = new HarnessStore({
          dbPath,
          encryptionKeyStore: new FileEncryptionKeyStore(legacyKeyPath)
        })
        legacyStore.insertToolCall({
          id: "legacy-encrypted-tool",
          sessionId: "session-1",
          agent: "codex",
          projectHash: "abc",
          tool: "Bash",
          command: "printf keychain-migration-tool",
          commandHash: "ignored",
          exitCode: 0,
          durationMs: 1,
          status: "ok"
        })
        legacyStore.upsertCacheEntry({
          keyHash: "legacy-encrypted-cache",
          provider: "openai",
          model: "gpt-5",
          projectHash: "abc",
          accountFingerprint: "acct",
          upstreamUrl: "https://example.com",
          contentType: "application/json",
          responseJson: "{\"migration\":\"keychain\"}",
          estimatedCostUsd: 0,
          normalizedInputHash: "norm",
          shingleHashes: [1, 2],
          createdAt: new Date().toISOString(),
          expiresAt: "2099-01-01T00:00:00.000Z"
        })
        legacyStore.close()

        writeFileSync(legacyKeyPath, `${legacyEncodedKey}\n`, { encoding: "utf8", mode: 0o600 })
        const keychainStore = new MacOsKeychainEncryptionKeyStore(keychainService, keychainAccount)
        const migrated = new HarnessStore({ dbPath, encryptionKeyStore: keychainStore })
        expect(existsSync(legacyKeyPath)).toBe(false)
        expect(migrated.listToolCallsSince("1970-01-01T00:00:00Z")[0]?.command).toBe(
          "printf keychain-migration-tool"
        )
        expect(migrated.getCacheEntry({
          keyHash: "legacy-encrypted-cache",
          provider: "openai",
          model: "gpt-5",
          projectHash: "abc",
          accountFingerprint: "acct",
          upstreamUrl: "https://example.com"
        })?.responseJson).toBe("{\"migration\":\"keychain\"}")
        migrated.close()

        const reopened = new HarnessStore({ dbPath, encryptionKeyStore: keychainStore })
        expect(reopened.listToolCallsSince("1970-01-01T00:00:00Z")[0]?.command).toBe(
          "printf keychain-migration-tool"
        )
        reopened.close()
      } finally {
        deleteKeychainTestItem(keychainService, keychainAccount)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it("rejects symbolic links and malformed file encryption keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-file-key-security-"))
    const targetPath = join(dir, "target")
    const linkPath = join(dir, "state.db.cache-key")
    const malformedPath = join(dir, "malformed.cache-key")
    writeFileSync(targetPath, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 })
    symlinkSync(targetPath, linkPath)
    writeFileSync(malformedPath, `${randomBytes(32).toString("base64")}!\n`, { mode: 0o600 })
    try {
      expect(() => new FileEncryptionKeyStore(linkPath).loadOrCreate()).toThrow(
        /must not be a symbolic link/
      )
      expect(() => new FileEncryptionKeyStore(malformedPath).loadOrCreate()).toThrow(
        /is not canonical Base64/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("applies retention cleanup to old records", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-retention-"))
    const dbPath = join(dir, "state.db")
    const store = new HarnessStore({ dbPath })
    store.insertToolCall({
      id: "old-tool",
      sessionId: "session-old",
      agent: "codex",
      projectHash: "old",
      tool: "Bash",
      command: "old command",
      commandHash: "old",
      exitCode: 0,
      durationMs: 1,
      status: "ok"
    })
    store.close()
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(dbPath)
    raw.prepare("UPDATE tool_calls SET created_at = ? WHERE id = 'old-tool'").run("2000-01-01T00:00:00Z")
    raw.close()
    const reopened = new HarnessStore({ dbPath })
    reopened.purgeExpired(1)
    expect(reopened.listToolCallsSince("1970-01-01T00:00:00Z")).toHaveLength(0)
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps tool policy decisions after retention purge", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-retention-decisions-"))
    const dbPath = join(dir, "state.db")
    const store = new HarnessStore({ dbPath })
    store.insertToolCall({
      id: "tool-with-decision",
      sessionId: "session-old",
      agent: "codex",
      projectHash: "old",
      tool: "Bash",
      command: "git status",
      commandHash: "hash",
      exitCode: 0,
      durationMs: 1,
      status: "blocked"
    })
    store.insertPolicyDecision({
      id: "decision-tool",
      requestId: "tool-with-decision",
      ruleId: "deny-rule",
      action: "deny",
      mode: "enforce",
      reason: "blocked"
    })
    store.close()
    const reopened = new HarnessStore({ dbPath })
    reopened.purgeExpired(1)
    expect(reopened.countPolicyDecisions()).toBe(1)
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("maps cache_hit from SQLite integer to boolean", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cache-bool-"))
    const dbPath = join(dir, "state.db")
    const store = new HarnessStore({ dbPath })
    const projectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    store.insertRequest({
      id: "request-1",
      sessionId: "session-1",
      agent: "codex",
      provider: "openai",
      projectHash: "abc",
      model: "gpt-5",
      inputHash: "in",
      outputHash: "out",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      cacheHit: true,
      decisionId: "cache",
      durationMs: 1,
      status: "ok",
      createdAt: new Date().toISOString()
    })
    const request = store.listRequestsSince("1970-01-01T00:00:00Z")[0]
    expect(request?.cacheHit).toBe(true)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("migrates legacy tables with missing columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-migration-"))
    const dbPath = join(dir, "state.db")
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        tool TEXT NOT NULL,
        command TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE optimization_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        evidence TEXT NOT NULL,
        impact TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    raw.close()

    const migrated = new HarnessStore({ dbPath })
    migrated.insertToolCall({
      id: "tool-migrated",
      sessionId: "session-migrated",
      agent: "codex",
      projectHash: "project-migrated",
      tool: "Bash",
      command: "git status",
      commandHash: "hash",
      exitCode: 0,
      durationMs: 1,
      status: "ok"
    })
    migrated.insertProposal({
      id: "proposal-migrated",
      kind: "cache",
      evidence: "evidence",
      impact: "impact",
      ruleJson: "{}",
      ruleType: "request",
      status: "pending",
      createdAt: new Date().toISOString()
    })
    expect(migrated.listToolCallsSince("1970-01-01T00:00:00Z")[0]?.projectHash).toBe("project-migrated")
    expect(migrated.listProposals()[0]?.ruleJson).toBe("{}")
    migrated.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("scrubs legacy tool command secrets during store open", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-legacy-scrub-"))
    const dbPath = join(dir, "state.db")
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        tool TEXT NOT NULL,
        command TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        exit_code INTEGER,
        duration_ms REAL NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
    raw.prepare(
      `INSERT INTO tool_calls (id, session_id, agent, tool, command, command_hash, exit_code, duration_ms, status, created_at)
       VALUES ('legacy', 'session-1', 'codex', 'Bash', ?, 'old-hash', 0, 1, 'ok', ?)`
    ).run(`echo ${secret}`, new Date().toISOString())
    raw.close()

    const migrated = new HarnessStore({ dbPath })
    const call = migrated.listToolCallsSince("1970-01-01T00:00:00Z")[0]
    expect(call?.command).not.toContain(secret)
    expect(call?.command).toContain("[REDACTED]")
    expect(call?.commandHash).toBe(sha256(call?.command ?? ""))
    migrated.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("validates policy and evaluates deny in enforce mode", () => {
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "deny-destructive",
          type: "tool",
          match: {
            tools: ["Bash"],
            commandRegex: "rm -rf /"
          },
          action: "deny",
          reason: "blocked"
        }
      ]
    }))
    const decision = evaluatePolicy(policy, {
      kind: "tool",
      context: {
        tool: "Bash",
        command: "rm -rf /",
        agent: "codex"
      }
    })
    expect(decision.action).toBe("deny")
    expect(decision.mode).toBe("enforce")
  })

  it("validates redact, compress, budget, and route policy actions", () => {
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
          config: { patterns: ["sk-.*"] }
        },
        {
          id: "compress-long",
          type: "request",
          match: { providers: ["openai"] },
          action: "compress",
          reason: "compress",
          config: { maxChars: 100 }
        },
        {
          id: "budget-project",
          type: "session",
          match: { project: "*" },
          action: "budget",
          reason: "budget",
          config: { maxUsd: 5 }
        },
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
    expect(policy.rules).toHaveLength(4)
  })

  it("rejects policy actions missing required config", () => {
    expect(() => parsePolicyConfig(JSON.stringify({
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
          reason: "redact"
        }
      ]
    }))).toThrow("requires config.patterns")
    expect(() => parsePolicyConfig(JSON.stringify({
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
          reason: "budget"
        }
      ]
    }))).toThrow("requires config.maxUsd")
  })

  it("rejects unsupported defaultAction values", () => {
    expect(() => parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "compress",
      project: "*",
      rules: []
    }))).toThrow("Unsupported defaultAction")
  })

  it("rejects client-controlled request toolsHint matching", () => {
    expect(() => parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [{
        id: "unsafe-client-tools",
        type: "request",
        match: { providers: ["openai"], toolsHint: ["Read"] },
        action: "cache",
        reason: "unsafe client hint",
        config: { ttlMinutes: 60 }
      }]
    }))).toThrow("Unrecognized key")
  })

  it("enforces proposal status transitions", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-proposal-state-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertProposal({
      id: "proposal-1",
      kind: "cache",
      evidence: "evidence",
      impact: "impact",
      ruleJson: "{}",
      ruleType: "request",
      status: "pending",
      createdAt: new Date().toISOString()
    })
    store.updateProposalStatus("proposal-1", "rejected")
    expect(() => store.updateProposalStatus("proposal-1", "applied")).toThrow("cannot transition")
    expect(() => store.updateProposalStatus("missing", "approved")).toThrow("not found")
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("extracts cumulative SSE usage without double counting", () => {
    const usage = extractUsageFromSse([
      "data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50}}",
      "data: {\"type\":\"response.completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50}}",
      "data: [DONE]"
    ].join("\n\n"))
    expect(usage).toEqual({ tokensIn: 100, tokensOut: 50, cacheReadTokensIn: 0 })
  })

  it("extracts OpenAI Responses usage nested under response.completed", () => {
    const usage = extractUsageFromSse([
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"E2E-OK\"}",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":16,\"output_tokens\":5}}}",
      "data: [DONE]"
    ].join("\n\n"))
    expect(usage).toEqual({ tokensIn: 16, tokensOut: 5, cacheReadTokensIn: 0 })
  })

  it("normalizes provider cache-read usage without double counting prompt totals", () => {
    expect(extractResponseUsage({
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200
      }
    })).toEqual({ tokensIn: 1_000, tokensOut: 50, cacheReadTokensIn: 800 })

    expect(extractResponseUsage({
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 100
      }
    })).toEqual({ tokensIn: 1_000, tokensOut: 50, cacheReadTokensIn: 700 })

    expect(extractResponseUsage({
      usage: {
        input_tokens: 1_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 600 }
      }
    })).toEqual({ tokensIn: 1_000, tokensOut: 50, cacheReadTokensIn: 600 })

    expect(extractUsageFromSse([
      "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":200,\"cache_read_input_tokens\":800}}}",
      "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":50}}"
    ].join("\n\n"))).toEqual({ tokensIn: 1_000, tokensOut: 50, cacheReadTokensIn: 800 })
  })

  it("rejects unsafe redact patterns during policy validation", () => {
    expect(() => parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: [
        {
          id: "redact-unsafe",
          type: "request",
          match: { providers: ["openai"] },
          action: "redact",
          reason: "redact",
          config: { patterns: ["(a+)+$"] }
        }
      ]
    }))).toThrow("Unsafe redact pattern")
  })

  it("creates and verifies signed policy bundles", () => {
    const policy = parsePolicyConfig(JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const signedAt = new Date().toISOString()
    const bundle = createPolicyBundle(policy, "enterprise-secret", signedAt)
    expect(bundle.version).toHaveLength(64)
    expect(bundle.signature).toHaveLength(64)
    expect(verifyPolicyBundle(bundle, "enterprise-secret")).toBe(true)
    expect(verifyPolicyBundle(bundle, "wrong-secret")).toBe(false)
    const futureBundle = createPolicyBundle(policy, "enterprise-secret", new Date(Date.now() + 2 * 60 * 1000).toISOString())
    const staleBundle = createPolicyBundle(policy, "enterprise-secret", new Date(Date.now() - 11 * 60 * 1000).toISOString())
    expect(verifyPolicyBundle(futureBundle, "enterprise-secret")).toBe(false)
    expect(verifyPolicyBundle(staleBundle, "enterprise-secret")).toBe(false)
    expect(verifyPolicyBundle({ ...bundle, signedAt: new Date(Date.now() - 60 * 1000).toISOString() }, "enterprise-secret"))
      .toBe(false)
    expect(verifyPolicyBundle({ ...bundle, signedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }, "enterprise-secret"))
      .toBe(false)
    expect(verifyPolicyBundle({ ...bundle, version: "0".repeat(64) }, "enterprise-secret")).toBe(false)
  })

  it("generates learning proposals from repeated requests", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-loop-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const projectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    for (let index = 0; index < 3; index += 1) {
      store.insertRequest({
        id: `request-${index}`,
        sessionId: "session-1",
        agent: "codex",
        provider: "openai",
        projectHash: "abc",
        model: "gpt-5",
        inputHash: "same",
        outputHash: index.toString(),
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.01,
        cacheHit: false,
        decisionId: "default",
        durationMs: 100,
        status: "ok",
        createdAt: new Date().toISOString()
      })
    }
    const loop = createLearningLoop(store)
    const proposalIds = loop.optimize("1970-01-01T00:00:00Z")
    expect(proposalIds.length).toBeGreaterThan(0)
    const kinds = loop.listProposals().map((proposal) => proposal.kind)
    expect(kinds).toContain("cache")
    const secondRun = loop.optimize("1970-01-01T00:00:00Z")
    expect(secondRun.length).toBe(0)
    const proposal = loop.listProposals().find((item) => item.kind === "cache")
    if (proposal === undefined) {
      throw new Error("proposal is missing")
    }
    loop.approveProposal(proposal.id)
    const nextPolicy = loop.applyProposal(proposal.id, JSON.stringify({
      version: 1,
      mode: "enforce",
      defaultAction: "allow",
      project: "*",
      rules: []
    }))
    const parsed = JSON.parse(nextPolicy) as { rules: Array<{ id: string; action: string }> }
    expect(parsed.rules).toContainEqual(expect.objectContaining({ id: cacheRuleId(proposal.ruleJson) }))
    rmSync(dir, { recursive: true, force: true })
  })

  it("generates only supported budget, cache, and prompt learning proposals once", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-learning-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const projectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId,
      agent: "codex",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    for (let index = 0; index < 12; index += 1) {
      store.insertRequest({
        id: `request-${index}`,
        sessionId: "session-1",
        agent: "codex",
        provider: "openai",
        projectHash: "abc",
        model: "gpt-5",
        inputHash: `prompt-${index % 3}`,
        outputHash: index.toString(),
        tokensIn: 1000,
        tokensOut: 1000,
        costUsd: 0.5,
        cacheHit: false,
        decisionId: "default",
        durationMs: 100,
        status: "ok",
        createdAt: new Date().toISOString()
      })
      store.insertToolCall({
        id: `tool-${index}`,
        sessionId: "session-1",
        agent: "codex",
        projectHash: "abc",
        tool: "Bash",
        command: `expensive-${index % 2}`,
        commandHash: `hash-${index % 2}`,
        exitCode: 0,
        durationMs: 10,
        status: "ok"
      })
    }
    const loop = createLearningLoop(store)
    const firstRun = loop.optimize("1970-01-01T00:00:00Z")
    expect(firstRun.length).toBeGreaterThan(0)
    const kinds = loop.listProposals().map((proposal) => proposal.kind)
    expect(kinds).toEqual(expect.arrayContaining(["budget", "cache", "prompt"]))
    expect(kinds).not.toContain("compress")
    expect(kinds).not.toContain("route")
    const secondRun = loop.optimize("1970-01-01T00:00:00Z")
    expect(secondRun).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not generate wire-incompatible reliability route proposals", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-learning-reliability-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const projectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId,
      agent: "claude",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    for (let index = 0; index < 12; index += 1) {
      store.insertRequest({
        id: `request-${index}`,
        sessionId: "session-1",
        agent: "claude",
        provider: "anthropic",
        projectHash: "abc",
        model: "claude-sonnet",
        inputHash: `prompt-${index}`,
        outputHash: index.toString(),
        tokensIn: 100,
        tokensOut: 100,
        costUsd: 0.01,
        cacheHit: false,
        decisionId: "default",
        durationMs: index % 2 === 0 ? 20000 : 100,
        status: index % 2 === 0 ? "error" : "ok",
        createdAt: new Date().toISOString()
      })
    }
    const loop = createLearningLoop(store)
    const proposalIds = loop.optimize("1970-01-01T00:00:00Z")
    expect(proposalIds).toHaveLength(0)
    expect(loop.listProposals()).toHaveLength(0)
    const secondRun = loop.optimize("1970-01-01T00:00:00Z")
    expect(secondRun).toHaveLength(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not generate no-op routes to the current provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-learning-noop-route-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const projectId = store.findOrCreateProject("abc", "demo")
    store.insertSession({
      id: "session-1",
      projectId,
      agent: "opencode",
      status: "active",
      startedAt: new Date().toISOString(),
      endedAt: null
    })
    for (let index = 0; index < 10; index += 1) {
      store.insertRequest({
        id: `request-${index}`,
        sessionId: "session-1",
        agent: "opencode",
        provider: "openai-compatible",
        projectHash: "abc",
        model: "local-model",
        inputHash: `unique-${index}`,
        outputHash: index.toString(),
        tokensIn: 100,
        tokensOut: 100,
        costUsd: 0.2,
        cacheHit: false,
        decisionId: "default",
        durationMs: 100,
        status: "ok",
        createdAt: new Date().toISOString()
      })
    }
    const loop = createLearningLoop(store)
    expect(loop.optimize("1970-01-01T00:00:00Z")).toHaveLength(0)
    expect(loop.listProposals()).toHaveLength(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps telemetry local and opt-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const service = createTelemetryService(
      true,
      join(dir, "telemetry.json"),
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    service.record("tool_call", { agent: "codex", tool: "Bash", status: "ok" })
    expect(service.export()).toHaveLength(0)
    service.enable()
    service.record("tool_call", { agent: "codex secret", tool: "Bash secret", status: "ok secret" })
    expect(service.export()).toHaveLength(1)
    const payload = service.export()[0]?.payloadJson
    if (payload === undefined) {
      throw new Error("telemetry payload is missing")
    }
    expect(payload).not.toContain("secret")
    const parsedPayload = JSON.parse(payload) as {
      readonly schemaVersion: number
      readonly data: Readonly<Record<string, string>>
    }
    expect(parsedPayload.schemaVersion).toBe(1)
    expect(Object.keys(parsedPayload.data).sort()).toEqual(["agent", "status", "tool"])
    expect(parsedPayload.data.agent).toMatch(/^[a-f0-9]{64}$/)
    expect(() => service.record("tool_call", {
      agent: "codex",
      tool: "Bash",
      status: "ok",
      raw: "must be rejected"
    })).toThrow("missing or unsupported fields")
    const configDisabledService = createTelemetryService(
      false,
      join(dir, "telemetry.json"),
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    expect(configDisabledService.status().enabled).toBe(false)
    expect(() => configDisabledService.enable()).toThrow("telemetry.enabled is false")
    configDisabledService.record("tool_call", { agent: "codex", tool: "Bash", status: "ok" })
    expect(configDisabledService.export()).toHaveLength(1)
    expect(statSync(join(dir, "telemetry.json")).mode & 0o777).toBe(0o600)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects symbolic links in telemetry consent paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-consent-"))
    const outsideDir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-outside-"))
    const outsideFile = join(outsideDir, "consent.json")
    writeFileSync(outsideFile, JSON.stringify({ enabled: false, consentedAt: null, secret: "a".repeat(64) }))
    const finalLink = join(dir, "consent.json")
    symlinkSync(outsideFile, finalLink)
    const finalLinkService = createTelemetryService(true, finalLink, () => undefined, () => [])
    expect(() => finalLinkService.status()).toThrow("expected a regular file")

    const parentLink = join(dir, "linked-parent")
    symlinkSync(outsideDir, parentLink)
    const parentLinkService = createTelemetryService(
      true,
      join(parentLink, "nested.json"),
      () => undefined,
      () => []
    )
    expect(() => parentLinkService.enable()).toThrow("Unsafe directory component")
    expect(readFileSync(outsideFile, "utf8")).toContain("\"enabled\":false")
    expect(existsSync(join(outsideDir, "nested.json"))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it("estimates cost from pricing catalog", () => {
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 4103 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: [
          {
            provider: "anthropic",
            model: "claude-*",
            inputPerMillion: 3,
            outputPerMillion: 15
          }
        ]
      }
    })
    const cost = pricing.estimate({
      provider: "anthropic",
      model: "claude-opus",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      cacheReadTokensIn: 0
    })
    expect(cost.costUsd).toBe(18)
    expect(cost.pricingStatus).toBe("priced")
  })

  it("prices cache-read input separately and persists its token count", () => {
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 4103 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: {
        defaultCurrency: "USD",
        models: [{
          provider: "anthropic",
          model: "deepseek-v4-pro*",
          inputPerMillion: 0.435,
          cacheReadInputPerMillion: 0.0435,
          outputPerMillion: 0.87
        }]
      }
    })
    const cost = pricing.estimate({
      provider: "anthropic",
      model: "deepseek-v4-pro[1m]",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      cacheReadTokensIn: 800_000
    })
    expect(cost.costUsd).toBe(0.9918)
    expect(cost.cacheReadTokensIn).toBe(800_000)
    expect(() => pricing.estimate({
      provider: "anthropic",
      model: "deepseek-v4-pro[1m]",
      tokensIn: 10,
      tokensOut: 0,
      cacheReadTokensIn: 11
    })).toThrow("exceeds tokensIn")

    const dir = mkdtempSync(join(tmpdir(), "own-harness-cache-cost-"))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.insertCostRecord({
      requestId: "cache-cost",
      provider: "anthropic",
      model: "deepseek-v4-pro[1m]",
      tokensIn: cost.tokensIn,
      cacheReadTokensIn: cost.cacheReadTokensIn,
      tokensOut: cost.tokensOut,
      costUsd: cost.costUsd,
      currency: cost.currency,
      pricingStatus: cost.pricingStatus
    })
    expect(store.listCostRecords()[0]?.cacheReadTokensIn).toBe(800_000)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("marks unknown models as unpriced instead of treating zero as a known price", () => {
    const pricing = createPricingCatalog({
      version: 1,
      proxy: { host: "127.0.0.1", port: 4103 },
      store: { home: "~/.own-harness", retentionDays: 90 },
      telemetry: { enabled: false, optInFile: "~/.own-harness/telemetry.json" },
      pricing: { defaultCurrency: "USD", models: [] }
    })
    expect(pricing.estimate({
      provider: "openai",
      model: "unknown-model",
      tokensIn: 10,
      tokensOut: 5,
      cacheReadTokensIn: 0
    })).toEqual({
      tokensIn: 10,
      tokensOut: 5,
      cacheReadTokensIn: 0,
      costUsd: 0,
      currency: "USD",
      pricingStatus: "unpriced"
    })
  })

  it("rewrites shell commands with rtk when available", async () => {
    const result = await rewriteCommandWithRtk("git status")
    expect(result.usedRtk).toBe(true)
    expect(result.rewritten.length).toBeGreaterThan(0)
  })

  it("raises a structured error when rtk rewrite fails", async () => {
    const previousPath = process.env.PATH
    process.env.PATH = tmpdir()
    try {
      await expect(rewriteCommandWithRtk("git status")).rejects.toMatchObject({
        code: "RTK_REWRITE_FAILED"
      })
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = previousPath
      }
    }
  })
})

function deleteKeychainTestItem(service: string, account: string): void {
  const result = spawnSync(
    "/usr/bin/security",
    ["delete-generic-password", "-a", account, "-s", service],
    { encoding: "utf8" }
  )
  if (result.status !== 0 && result.status !== 44) {
    throw new Error(`Keychain integration-test cleanup failed with status ${String(result.status)}`)
  }
}

function cacheRuleId(rule: string): string {
  const parsed = JSON.parse(rule) as { id: string }
  return parsed.id
}
