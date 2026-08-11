import { randomBytes } from "node:crypto"
import { join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  createLearningLoop,
  HarnessStore,
  parsePolicyConfig,
  readUtf8FileWithinRealRoot,
  resolveRealDirectoryRoot,
  writeUtf8FileAtomicallyWithinRealRoot,
  writeUtf8FileExclusivelyWithinRealRoot
} from "@own-harness/core"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { bootstrap } from "../bootstrap.js"

export function listProposals(cwd: string): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const loop = createLearningLoop(store)
    console.log(JSON.stringify(loop.listProposals(), null, 2))
  } finally {
    store.close()
  }
}

export function showProposal(cwd: string, proposalId: string): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const loop = createLearningLoop(store)
    const proposal = loop.getProposal(proposalId)
    if (proposal === undefined) {
      throw new Error(`Proposal not found: ${proposalId}`)
    }
    console.log(JSON.stringify(proposal, null, 2))
  } finally {
    store.close()
  }
}

export function applyProposalToPolicy(cwd: string, proposalId: string): string {
  assertProposalId(proposalId)
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const loop = createLearningLoop(store)
    const workspaceRoot = resolveRealDirectoryRoot(resolve(cwd))
    const policyRelativePath = join(".harness", "policies", "default.yaml")
    const policySource = readUtf8FileWithinRealRoot(workspaceRoot, policyRelativePath)
    if (policySource === null) {
      throw new Error(`Policy file disappeared before proposal application: ${boot.policyPath}`)
    }
    const policy = parsePolicyConfig(JSON.stringify(parseYaml(policySource)))
    const proposal = loop.getProposal(proposalId)
    if (proposal === undefined) {
      throw new Error(`Proposal not found: ${proposalId}`)
    }
    const proposalRule = loop.proposalRule(proposalId)
    const matchingRules = policy.rules.filter((rule) => rule.id === proposalRule.id)
    if (matchingRules.length > 0) {
      if (matchingRules.length !== 1 || !isDeepStrictEqual(matchingRules[0], proposalRule)) {
        throw new Error(`Policy rule conflict for proposal ${proposalId}: ${proposalRule.id}`)
      }
      if (proposal.status === "approved") {
        loop.markProposalApplied(proposalId)
        return `Reconciled applied proposal ${proposalId}`
      }
      if (proposal.status === "applied") {
        return `Proposal ${proposalId} is already applied`
      }
    }
    if (proposal.status === "applied") {
      throw new Error(`Applied proposal ${proposalId} is missing policy rule ${proposalRule.id}`)
    }
    const policyJson = JSON.stringify(policy)
    const nextPolicyJson = loop.applyProposal(proposalId, policyJson)
    const nextPolicyYaml = stringifyYaml(JSON.parse(nextPolicyJson))
    writeUtf8FileExclusivelyWithinRealRoot({
      rootPath: workspaceRoot,
      relativePath: join(
        ".harness",
        "policies",
        "backups",
        `${Date.now()}-${randomBytes(8).toString("hex")}-${proposalId}.yaml`
      ),
      content: policySource,
      mode: 0o600
    })
    writeUtf8FileAtomicallyWithinRealRoot({
      rootPath: workspaceRoot,
      relativePath: policyRelativePath,
      content: nextPolicyYaml,
      mode: 0o600
    })
    loop.markProposalApplied(proposalId)
    return `Applied proposal ${proposalId}`
  } finally {
    store.close()
  }
}

export function applyProposal(cwd: string, proposalId: string): void {
  console.log(applyProposalToPolicy(cwd, proposalId))
}

export function approveProposalById(cwd: string, proposalId: string): string {
  assertProposalId(proposalId)
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const loop = createLearningLoop(store)
    loop.approveProposal(proposalId)
    return `Approved proposal ${proposalId}`
  } finally {
    store.close()
  }
}

export function approveProposal(cwd: string, proposalId: string): void {
  console.log(approveProposalById(cwd, proposalId))
}

export function rejectProposalById(cwd: string, proposalId: string): string {
  assertProposalId(proposalId)
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const loop = createLearningLoop(store)
    loop.rejectProposal(proposalId)
    return `Rejected proposal ${proposalId}`
  } finally {
    store.close()
  }
}

function assertProposalId(proposalId: string): void {
  if (!/^[a-f0-9]{24}$/.test(proposalId)) {
    throw new Error(`Invalid proposal id: ${proposalId}`)
  }
}

export function rejectProposal(cwd: string, proposalId: string): void {
  console.log(rejectProposalById(cwd, proposalId))
}
