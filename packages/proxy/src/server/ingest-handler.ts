import type { FastifyInstance } from "fastify"
import type { PolicyDecision } from "@own-harness/contracts"
import { AgentKindSchema } from "@own-harness/contracts"
import {
  evaluatePolicy,
  randomId,
  redactSecretsWithPatterns,
  sanitizeCommandForStorage,
  sha256
} from "@own-harness/core"
import { z } from "zod"
import type { ProxyOptions } from "./proxy-server.js"

const IngestBodySchema = z.object({
  tool: z.string().min(1).max(200),
  command: z.string().min(1).max(20000),
  sessionId: z.string().min(1).max(200).optional(),
  agent: AgentKindSchema.optional(),
  projectHash: z.string().min(1).max(200).optional(),
  exitCode: z.number().int().nonnegative().nullable().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  hookEvent: z.enum(["PreToolUse", "PostToolUse", "PostToolUseFailure"]).optional(),
  toolUseId: z.string().min(1).max(300).optional()
})

interface IngestRequestBody {
  readonly tool?: unknown
  readonly command?: unknown
  readonly sessionId?: unknown
  readonly agent?: unknown
  readonly projectHash?: unknown
  readonly exitCode?: unknown
  readonly durationMs?: unknown
}

export function registerIngestRoute(app: FastifyInstance, options: ProxyOptions): void {
  app.post("/api/v1/ingest", async (request, reply) => {
    const parsed = IngestBodySchema.safeParse(parseIngestBody(request.body))
    if (!parsed.success) {
      reply.status(400).send({
        error: "Invalid ingest body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      })
      return
    }
    const body = parsed.data
    const resolved = {
      sessionId: body.sessionId ?? options.sessionId,
      agent: body.agent ?? options.agent,
      projectHash: body.projectHash ?? options.projectHash,
      tool: body.tool,
      command: body.command,
      exitCode: body.exitCode ?? null,
      durationMs: body.durationMs ?? 0
    }
    if (body.hookEvent !== undefined && body.hookEvent !== "PreToolUse") {
      if (body.toolUseId === undefined) {
        reply.status(400).send({ error: `${body.hookEvent} ingest requires toolUseId` })
        return
      }
      const exitCode = body.hookEvent === "PostToolUse" ? 0 : (body.exitCode ?? 1)
      options.store.updateToolCallResult(
        {
          callId: hookCallId(resolved.sessionId, body.toolUseId),
          sessionId: resolved.sessionId,
          agent: resolved.agent,
          projectHash: resolved.projectHash,
          tool: resolved.tool,
          exitCode,
          durationMs: resolved.durationMs,
          status: exitCode === 0 ? "ok" : "error"
        }
      )
      options.telemetry?.record("tool_result", {
        agent: resolved.agent,
        tool: resolved.tool,
        status: exitCode === 0 ? "ok" : "error",
        exitCode,
        durationMs: resolved.durationMs
      })
      reply.status(201).send({ status: "ok" })
      return
    }
    const decision = evaluatePolicy(options.policy, {
      kind: "tool",
      context: {
        tool: resolved.tool,
        command: resolved.command,
        agent: resolved.agent
      }
    })
    const callId = body.toolUseId === undefined
      ? randomId()
      : hookCallId(resolved.sessionId, body.toolUseId)
    const storedCommand = storedCommandForTool(resolved.command, decision)
    if (decision.action === "deny" && decision.mode === "enforce") {
      options.store.insertToolCall({
        id: callId,
        sessionId: resolved.sessionId,
        agent: resolved.agent,
        projectHash: resolved.projectHash,
        tool: resolved.tool,
        command: storedCommand,
        commandHash: sha256(storedCommand),
        exitCode: resolved.exitCode,
        durationMs: resolved.durationMs,
        status: "blocked"
      })
      options.store.insertPolicyDecision({
        id: randomId(),
        requestId: callId,
        ruleId: decision.ruleId,
        action: decision.action,
        mode: decision.mode,
        reason: decision.reason
      })
      options.telemetry?.record("tool_call", {
        agent: resolved.agent,
        tool: resolved.tool,
        status: "blocked"
      })
      reply.status(403).send({ error: "Policy denied tool", ruleId: decision.ruleId })
      return
    }
    options.store.insertToolCall({
      id: callId,
      sessionId: resolved.sessionId,
      agent: resolved.agent,
      projectHash: resolved.projectHash,
      tool: resolved.tool,
      command: storedCommand,
      commandHash: sha256(storedCommand),
      exitCode: resolved.exitCode,
      durationMs: resolved.durationMs,
      status: resolved.exitCode !== null && resolved.exitCode !== 0 ? "error" : "ok"
    })
    if (decision.mode === "audit" || decision.action === "log") {
      options.store.insertPolicyDecision({
        id: randomId(),
        requestId: callId,
        ruleId: decision.ruleId,
        action: decision.action,
        mode: decision.mode,
        reason: decision.reason
      })
    }
    options.telemetry?.record("tool_call", {
      agent: resolved.agent,
      tool: resolved.tool,
      status: resolved.exitCode !== null && resolved.exitCode !== 0 ? "error" : "ok"
    })
    reply.status(201).send({ status: "ok" })
  })
}

function parseIngestBody(body: unknown): IngestRequestBody {
  if (typeof body !== "object" || body === null) {
    return {}
  }
  return body as IngestRequestBody
}

function hookCallId(sessionId: string, toolUseId: string): string {
  return `hook-${sha256(`${sessionId}\u0000${toolUseId}`).slice(0, 32)}`
}

function storedCommandForTool(command: string, decision: PolicyDecision): string {
  if (decision.action === "redact" && decision.mode === "enforce" && decision.config?.patterns !== undefined) {
    return redactSecretsWithPatterns(command, decision.config.patterns)
  }
  return sanitizeCommandForStorage(command)
}
