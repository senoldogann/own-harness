import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { createTelemetryService, HarnessStore } from "@own-harness/core"
import { exportAuditToFile, exportTelemetryToFile } from "../src/commands/export.js"
import { importTelemetry } from "../src/commands/telemetry.js"
import { initProject } from "../src/bootstrap.js"
import { readTextFile, writeTextFile } from "../src/fs-utils.js"

describe("telemetry export and import", () => {
  it("exports policy decision audit records", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-audit-export-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
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
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      cacheHit: false,
      decisionId: "deny-rule",
      durationMs: 1,
      status: "blocked",
      createdAt: new Date().toISOString()
    })
    store.insertPolicyDecision({
      id: "decision-1",
      requestId: "request-1",
      ruleId: "deny-rule",
      action: "deny",
      mode: "enforce",
      reason: "blocked"
    })
    store.close()

    const auditPath = join(dir, "audit.json")
    exportAuditToFile(dir, auditPath)
    const exported = JSON.parse(readTextFile(auditPath)) as Array<{ ruleId: string }>
    expect(exported).toHaveLength(1)
    expect(exported[0]?.ruleId).toBe("deny-rule")
    rmSync(dir, { recursive: true, force: true })
  })

  it("exports anonymized events and imports them idempotently", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-source-"))
    initProject(sourceDir)
    writeTextFile(join(sourceDir, "harness.config.yaml"), configWithLocalStore(sourceDir))
    const sourceStore = new HarnessStore({ dbPath: join(sourceDir, "state.db") })
    const sourceTelemetry = createTelemetryService(
      true,
      join(sourceDir, "consent.json"),
      (eventType, payloadJson) => sourceStore.insertTelemetryEvent(eventType, payloadJson),
      () => sourceStore.listTelemetryEvents()
    )
    sourceTelemetry.enable()
    sourceTelemetry.record("tool_call", { agent: "codex secret", tool: "Bash secret", status: "ok secret" })
    sourceTelemetry.record("tool_result", {
      agent: "codex secret",
      tool: "Bash secret",
      status: "ok secret",
      exitCode: 0,
      durationMs: 12
    })
    sourceStore.close()

    const exportPath = join(sourceDir, "telemetry.json")
    exportTelemetryToFile(sourceDir, exportPath)
    const exported = JSON.parse(readTextFile(exportPath)) as Array<{ id: string; eventType: string }>
    expect(exported).toHaveLength(2)
    expect(exported.map((event) => event.eventType).sort()).toEqual(["tool_call", "tool_result"])
    expect(readTextFile(exportPath)).not.toContain("secret")

    const targetDir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-target-"))
    initProject(targetDir)
    writeTextFile(join(targetDir, "harness.config.yaml"), configWithLocalStore(targetDir))
    importTelemetry(targetDir, exportPath)
    importTelemetry(targetDir, exportPath)

    const targetStore = new HarnessStore({ dbPath: join(targetDir, "state.db") })
    try {
      expect(targetStore.listTelemetryEvents()).toHaveLength(2)
    } finally {
      targetStore.close()
    }
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(targetDir, { recursive: true, force: true })
  })

  it("rejects malformed telemetry exports", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-invalid-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    const badPath = join(dir, "bad.json")
    writeTextFile(badPath, JSON.stringify([{ eventType: "request", payloadJson: "{}", createdAt: "now" }]))
    expect(() => importTelemetry(dir, badPath)).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects telemetry imports with arbitrary payload content", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-unsafe-import-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    const importPath = join(dir, "unsafe.json")
    const secret = "sk-import-must-not-be-persisted"
    writeTextFile(importPath, JSON.stringify([{
      id: "a".repeat(24),
      eventType: "tool_call",
      payloadJson: JSON.stringify({ raw: secret }),
      createdAt: new Date().toISOString()
    }]))

    let message = ""
    try {
      importTelemetry(dir, importPath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain("content-free schema version 1")
    expect(message).not.toContain(secret)
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    expect(store.listTelemetryEvents()).toHaveLength(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("blocks unsafe legacy telemetry export without leaking payload content", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-telemetry-unsafe-export-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    store.close()
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const database = new DatabaseSync(join(dir, "state.db"))
    const recordId = "b".repeat(24)
    const secret = "sk-legacy-export-must-not-leak"
    database.prepare(
      `INSERT INTO telemetry_events (id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(recordId, "tool_call", JSON.stringify({ raw: secret }), new Date().toISOString())
    database.close()
    const exportPath = join(dir, "telemetry-export.json")

    let message = ""
    try {
      exportTelemetryToFile(dir, exportPath)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain(recordId)
    expect(message).toContain("Remove or migrate")
    expect(message).not.toContain(secret)
    expect(existsSync(exportPath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

function configWithLocalStore(dir: string): string {
  process.env.HARNESS_HOME = dir
  return `version: 1
proxy:
  host: "127.0.0.1"
  port: 4103
store:
  home: "~/.own-harness"
  retentionDays: 90
telemetry:
  enabled: false
  optInFile: "~/.own-harness/telemetry.json"
pricing:
  defaultCurrency: "USD"
  models: []
`
}
