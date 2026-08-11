import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessStore } from "@own-harness/core"
import { ingestToolCall } from "../src/commands/ingest.js"
import { initProject } from "../src/bootstrap.js"
import { writeTextFile } from "../src/fs-utils.js"

describe("cli ingest", () => {
  it("records a tool call with rtk rewrite and session env", async () => {
    if (commandOnPath("rtk") === false) {
      return
    }
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cli-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithRtkEnabled(dir))
    const previous = {
      session: process.env.HARNESS_SESSION_ID,
      agent: process.env.HARNESS_AGENT,
      project: process.env.HARNESS_PROJECT_HASH
    }
    process.env.HARNESS_SESSION_ID = "session-abc"
    process.env.HARNESS_AGENT = "opencode"
    process.env.HARNESS_PROJECT_HASH = "project-abc"
    await ingestToolCall(dir, "Bash", "git status")
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe("session-abc")
    expect(calls[0]?.agent).toBe("opencode")
    expect(calls[0]?.command).toBe("rtk git status")
    store.close()
    restoreEnv("HARNESS_SESSION_ID", previous.session)
    restoreEnv("HARNESS_AGENT", previous.agent)
    restoreEnv("HARNESS_PROJECT_HASH", previous.project)
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps commands unchanged when rtk is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cli-rtk-off-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    await ingestToolCall(dir, "Bash", "git status")
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls[0]?.command).toBe("git status")
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("enforces deny policy and records a blocked tool call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cli-deny-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    writeTextFile(join(dir, ".harness", "policies", "default.yaml"), `version: 1
mode: enforce
defaultAction: allow
project: "*"
rules:
  - id: deny-destructive
    type: tool
    match:
      tools: ["Bash"]
      commandRegex: "rm -rf /"
    action: deny
    reason: "Destructive command blocked"
`)
    await expect(ingestToolCall(dir, "Bash", "rm -rf /")).rejects.toMatchObject({ code: "POLICY_DENIED" })
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.status).toBe("blocked")
    expect(store.countAuditDecisions()).toBe(0)
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("redacts secrets before storing tool commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cli-redact-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
    await ingestToolCall(dir, "Bash", `echo ${secret}`)
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls[0]?.command).not.toContain(secret)
    expect(calls[0]?.command).toContain("[REDACTED]")
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("applies custom redact patterns before storing tool commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cli-redact-pattern-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    writeTextFile(join(dir, ".harness", "policies", "default.yaml"), `version: 1
mode: enforce
defaultAction: allow
project: "*"
rules:
  - id: redact-token
    type: tool
    match:
      tools: ["Bash"]
    action: redact
    reason: "Redact token values"
    config:
      patterns:
        - "TOKEN=[A-Z]+"
`)
    await ingestToolCall(dir, "Bash", "echo TOKEN=SECRET")
    const store = new HarnessStore({ dbPath: join(dir, "state.db") })
    const calls = store.listToolCallsSince("1970-01-01T00:00:00Z")
    expect(calls[0]?.command).not.toContain("SECRET")
    expect(calls[0]?.command).toContain("[REDACTED]")
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects invalid harness environment values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-cli-env-"))
    initProject(dir)
    writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore(dir))
    const previousAgent = process.env.HARNESS_AGENT
    process.env.HARNESS_AGENT = "not-an-agent"
    try {
      await expect(ingestToolCall(dir, "Bash", "git status")).rejects.toMatchObject({
        code: "INVALID_HARNESS_AGENT"
      })
    } finally {
      restoreEnv("HARNESS_AGENT", previousAgent)
    }
    const previousExit = process.env.HARNESS_TOOL_EXIT_CODE
    process.env.HARNESS_TOOL_EXIT_CODE = "1.5"
    try {
      await expect(ingestToolCall(dir, "Bash", "git status")).rejects.toMatchObject({
        code: "INVALID_HARNESS_TOOL_EXIT_CODE"
      })
    } finally {
      restoreEnv("HARNESS_TOOL_EXIT_CODE", previousExit)
    }
    rmSync(dir, { recursive: true, force: true })
  })
})

function commandOnPath(command: string): boolean {
  const pathValue = process.env.PATH ?? ""
  for (const directory of pathValue.split(":")) {
    if (directory.length > 0 && existsSync(join(directory, command))) {
      return true
    }
  }
  return false
}

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

function configWithRtkEnabled(dir: string): string {
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
rtk:
  enabled: true
pricing:
  defaultCurrency: "USD"
  models: []
`
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = previous
}
