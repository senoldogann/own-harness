import { describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessStore } from "@own-harness/core"
import { initProject } from "../src/bootstrap.js"
import { applyProposalToPolicy } from "../src/commands/proposal.js"
import { readTextFile, writeTextFile } from "../src/fs-utils.js"

const PROPOSAL_ID = "abcdef0123456789abcdef01"
const RULE = {
  type: "request",
  id: "cache-reconciled",
  match: { providers: ["openai"] },
  action: "cache",
  reason: "Repeated request",
  config: { ttlMinutes: 60, exactOnly: true }
} as const

describe("proposal application", () => {
  it("reconciles an approved proposal when the policy rename already succeeded", () => {
    const dir = createProject("own-harness-proposal-reconcile-")
    const store = new HarnessStore({ dbPath: join(dir, "state.db"), retentionDays: 90 })
    store.insertProposal({
      id: PROPOSAL_ID,
      kind: "cache",
      evidence: "repeated-request:abc",
      impact: "safe",
      ruleJson: JSON.stringify(RULE),
      ruleType: "request",
      status: "pending",
      createdAt: new Date().toISOString()
    })
    store.updateProposalStatus(PROPOSAL_ID, "approved")
    store.close()
    writeTextFile(join(dir, ".harness", "policies", "default.yaml"), policyWithRule(RULE))

    try {
      expect(applyProposalToPolicy(dir, PROPOSAL_ID)).toBe(`Reconciled applied proposal ${PROPOSAL_ID}`)
      expect(existsSync(join(dir, ".harness", "policies", "backups"))).toBe(false)
      expect(applyProposalToPolicy(dir, PROPOSAL_ID)).toBe(`Proposal ${PROPOSAL_ID} is already applied`)
      const verifiedStore = new HarnessStore({ dbPath: join(dir, "state.db"), retentionDays: 90 })
      expect(verifiedStore.getProposal(PROPOSAL_ID)?.status).toBe("applied")
      verifiedStore.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects reconciliation when the persisted rule id has different content", () => {
    const dir = createProject("own-harness-proposal-conflict-")
    const store = new HarnessStore({ dbPath: join(dir, "state.db"), retentionDays: 90 })
    store.insertProposal({
      id: PROPOSAL_ID,
      kind: "cache",
      evidence: "repeated-request:abc",
      impact: "safe",
      ruleJson: JSON.stringify(RULE),
      ruleType: "request",
      status: "pending",
      createdAt: new Date().toISOString()
    })
    store.updateProposalStatus(PROPOSAL_ID, "approved")
    store.close()
    writeTextFile(
      join(dir, ".harness", "policies", "default.yaml"),
      policyWithRule({ ...RULE, reason: "Conflicting rule" })
    )

    try {
      expect(() => applyProposalToPolicy(dir, PROPOSAL_ID)).toThrow("Policy rule conflict")
      const verifiedStore = new HarnessStore({ dbPath: join(dir, "state.db"), retentionDays: 90 })
      expect(verifiedStore.getProposal(PROPOSAL_ID)?.status).toBe("approved")
      verifiedStore.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps proposal application inside the real workspace root", () => {
    const dir = createProject("own-harness-proposal-safe-write-")
    const outside = mkdtempSync(join(tmpdir(), "own-harness-proposal-outside-"))
    const policyPath = join(dir, ".harness", "policies", "default.yaml")
    const backupPath = join(dir, ".harness", "policies", "backups")
    const originalPolicy = readTextFile(policyPath)
    const store = new HarnessStore({ dbPath: join(dir, "state.db"), retentionDays: 90 })
    store.insertProposal({
      id: PROPOSAL_ID,
      kind: "cache",
      evidence: "repeated-request:safe-write",
      impact: "safe",
      ruleJson: JSON.stringify(RULE),
      ruleType: "request",
      status: "pending",
      createdAt: new Date().toISOString()
    })
    store.updateProposalStatus(PROPOSAL_ID, "approved")
    store.close()
    symlinkSync(outside, backupPath)

    try {
      expect(() => applyProposalToPolicy(dir, PROPOSAL_ID)).toThrow("Unsafe directory component")
      expect(readdirSync(outside)).toHaveLength(0)
      expect(readTextFile(policyPath)).toBe(originalPolicy)
      const unchangedStore = new HarnessStore({ dbPath: join(dir, "state.db"), retentionDays: 90 })
      expect(unchangedStore.getProposal(PROPOSAL_ID)?.status).toBe("approved")
      unchangedStore.close()

      rmSync(backupPath)
      expect(applyProposalToPolicy(dir, PROPOSAL_ID)).toBe(`Applied proposal ${PROPOSAL_ID}`)
      expect(readTextFile(policyPath)).toContain(RULE.id)
      expect(readdirSync(backupPath)).toHaveLength(1)
      expect(applyProposalToPolicy(dir, PROPOSAL_ID)).toBe(`Proposal ${PROPOSAL_ID} is already applied`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

function createProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.env.HARNESS_HOME = dir
  initProject(dir)
  writeTextFile(join(dir, "harness.config.yaml"), configWithLocalStore())
  return dir
}

function policyWithRule(rule: {
  readonly type: "request"
  readonly id: string
  readonly action: "cache"
  readonly reason: string
}): string {
  return `version: 1
mode: enforce
defaultAction: allow
project: "*"
rules:
  - type: ${rule.type}
    id: ${rule.id}
    match:
      providers: ["openai"]
    action: ${rule.action}
    reason: ${rule.reason}
    config:
      ttlMinutes: 60
      exactOnly: true
`
}

function configWithLocalStore(): string {
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
