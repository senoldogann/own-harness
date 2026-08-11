import { describe, expect, it } from "vitest"
import {
  OptimizationProposalSchema,
  PolicyDecisionSchema,
  RequestRecordSchema,
  SessionRecordSchema,
  ToolCallRecordSchema
} from "../src/index.js"

describe("contract schemas", () => {
  it("parses a valid request record", () => {
    const request = RequestRecordSchema.parse({
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
      decisionId: null,
      durationMs: 10,
      status: "ok",
      createdAt: "2026-01-01T00:00:00Z"
    })
    expect(request.cacheHit).toBe(false)
  })

  it("rejects invalid tool call statuses", () => {
    expect(() => ToolCallRecordSchema.parse({
      id: "tool-1",
      sessionId: "session-1",
      agent: "codex",
      projectHash: "abc",
      tool: "Bash",
      command: "git status",
      commandHash: "hash",
      exitCode: 0,
      durationMs: 10,
      status: "unknown"
    })).toThrow()
  })

  it("round-trips core record shapes", () => {
    const session = SessionRecordSchema.parse({
      id: "session-1",
      projectId: 1,
      agent: "claude",
      status: "active",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null
    })
    const decision = PolicyDecisionSchema.parse({
      ruleId: "deny-rule",
      action: "deny",
      reason: "blocked",
      mode: "enforce"
    })
    const proposal = OptimizationProposalSchema.parse({
      id: "proposal-1",
      kind: "cache",
      evidence: "evidence",
      impact: "impact",
      ruleJson: "{}",
      ruleType: "request",
      status: "pending",
      createdAt: "2026-01-01T00:00:00Z"
    })
    expect(session.agent).toBe("claude")
    expect(decision.action).toBe("deny")
    expect(proposal.kind).toBe("cache")
  })
})
