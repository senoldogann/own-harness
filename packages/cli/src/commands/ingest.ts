import {
  evaluatePolicy,
  HarnessStore,
  OwnHarnessError,
  redactSecretsWithPatterns,
  rewriteCommandWithRtk,
  sanitizeCommandForStorage
} from "@own-harness/core"
import { randomId, sha256 } from "@own-harness/core"
import { AgentKindSchema } from "@own-harness/contracts"
import type { PolicyDecision } from "@own-harness/contracts"
import { bootstrap } from "../bootstrap.js"

export async function ingestToolCall(cwd: string, tool: string, command: string): Promise<void> {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const sessionId = process.env.HARNESS_SESSION_ID ?? "session-1"
    const agentResult = AgentKindSchema.safeParse(process.env.HARNESS_AGENT ?? "claude")
    if (!agentResult.success) {
      throw new OwnHarnessError("INVALID_HARNESS_AGENT", `HARNESS_AGENT is not a supported agent: ${process.env.HARNESS_AGENT}`)
    }
    const agent = agentResult.data
    const projectHash = process.env.HARNESS_PROJECT_HASH ?? sha256(cwd)
    if (sessionId.length === 0 || projectHash.length === 0) {
      throw new OwnHarnessError("INVALID_HARNESS_ENV", "HARNESS_SESSION_ID and HARNESS_PROJECT_HASH must be non-empty")
    }
    const decision = evaluatePolicy(boot.policy, {
      kind: "tool",
      context: {
        tool,
        command,
        agent
      }
    })
    const callId = randomId()
    const storedCommand = storedCommandForTool(command, decision)
    if (decision.action === "deny" && decision.mode === "enforce") {
      store.insertToolCall({
        id: callId,
        sessionId,
        agent,
        projectHash,
        tool,
        command: storedCommand,
        commandHash: sha256(storedCommand),
        exitCode: null,
        durationMs: 0,
        status: "blocked"
      })
      store.insertPolicyDecision({
        id: randomId(),
        requestId: callId,
        ruleId: decision.ruleId,
        action: decision.action,
        mode: decision.mode,
        reason: decision.reason
      })
      throw new OwnHarnessError("POLICY_DENIED", `POLICY_DENIED: ${decision.ruleId}`)
    }
    const rtkEnabled = boot.config.rtk?.enabled === true
    let rewrite: { readonly rewritten: string; readonly usedRtk: boolean } = {
      rewritten: command,
      usedRtk: false
    }
    if (rtkEnabled) {
      try {
        rewrite = await rewriteCommandWithRtk(command)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(JSON.stringify({ event: "rtk_rewrite_failed", commandHash: sha256(command), message }))
      }
    }
    const exitCode = parseExitCode(process.env.HARNESS_TOOL_EXIT_CODE)
    const finalCommand = rewrite.rewritten
    const persistedCommand = storedCommandForTool(finalCommand, decision)
    store.insertToolCall({
      id: callId,
      sessionId,
      agent,
      projectHash,
      tool,
      command: persistedCommand,
      commandHash: sha256(persistedCommand),
      exitCode,
      durationMs: 0,
      status: exitCode !== 0 ? "error" : "ok"
    })
    if (decision.mode === "audit" || decision.action === "log") {
      store.insertPolicyDecision({
        id: randomId(),
        requestId: callId,
        ruleId: decision.ruleId,
        action: decision.action,
        mode: decision.mode,
        reason: decision.reason
      })
    }
  } finally {
    store.close()
  }
}

function storedCommandForTool(command: string, decision: PolicyDecision): string {
  if (decision.action === "redact" && decision.mode === "enforce" && decision.config?.patterns !== undefined) {
    return redactSecretsWithPatterns(command, decision.config.patterns)
  }
  return sanitizeCommandForStorage(command)
}

function parseExitCode(raw: string | undefined): number {
  if (raw === undefined) {
    return 0
  }
  if (!/^\d+$/.test(raw)) {
    throw new OwnHarnessError("INVALID_HARNESS_TOOL_EXIT_CODE", `HARNESS_TOOL_EXIT_CODE must be a non-negative integer: ${raw}`)
  }
  return Number(raw)
}
