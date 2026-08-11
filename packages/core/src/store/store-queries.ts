import type {
  CostRecord,
  OptimizationProposal,
  OptimizationProposalKind,
  PolicyDecisionRecord,
  ProviderKind,
  RequestRecord,
  SessionRecord,
  TelemetryEvent,
  ToolCallRecord
} from "@own-harness/contracts"
import { StoreError } from "../errors.js"
import { randomId, sha256 } from "../hash.js"
import { sanitizeCommandForStorage } from "../redaction.js"
import {
  assertContentFreeTelemetryRecord,
  type TelemetryRecord
} from "../telemetry.js"
import {
  parseShingleHashes,
  proposalTransitions,
  validateCompletedRequest,
  type CacheEntryWrite,
  type CompletedRequestWrite
} from "../store-values.js"
import {
  cacheAad,
  decryptCacheValue,
  decryptToolCommand,
  encryptCacheValue,
  encryptToolCommand,
  toolCommandAad
} from "./store-crypto.js"
import type { StoreDb } from "./store-db.js"

export interface ToolCallResultUpdate {
  readonly callId: string
  readonly sessionId: string
  readonly agent: ToolCallRecord["agent"]
  readonly projectHash: string
  readonly tool: string
  readonly exitCode: number
  readonly durationMs: number
  readonly status: "ok" | "error"
}

const MAX_SEMANTIC_CANDIDATES = 500

export function closeDatabase(db: StoreDb): void {
  db.close()
}

export function insertProject(db: StoreDb, pathHash: string, displayName: string): number {
  const result = db
    .prepare(
      `INSERT INTO projects (path_hash, display_name, created_at)
       VALUES (?, ?, ?)`
    )
    .run(pathHash, displayName, new Date().toISOString())
  return Number(result.lastInsertRowid)
}

export function findOrCreateProject(db: StoreDb, pathHash: string, displayName: string): number {
  db
    .prepare(
      `INSERT OR IGNORE INTO projects (path_hash, display_name, created_at)
       VALUES (?, ?, ?)`
    )
    .run(pathHash, displayName, new Date().toISOString())
  const row = db
    .prepare("SELECT id FROM projects WHERE path_hash = ?")
    .get(pathHash) as { id: number }
  return row.id
}

export function insertSession(db: StoreDb, session: SessionRecord): void {
  db
    .prepare(
      `INSERT INTO sessions (id, project_id, agent, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      session.id,
      session.projectId,
      session.agent,
      session.status,
      session.startedAt,
      session.endedAt
    )
}

export function endSession(db: StoreDb, sessionId: string): void {
  db
    .prepare(
      `UPDATE sessions
       SET status = ?, ended_at = ?
       WHERE id = ?`
    )
    .run("ended", new Date().toISOString(), sessionId)
}

export function insertRequest(db: StoreDb, request: RequestRecord): void {
  db
    .prepare(
      `INSERT INTO requests (
         id, session_id, agent, provider, project_hash, model, input_hash, output_hash,
         tokens_in, cache_read_tokens_in, tokens_out, cost_usd, estimated_cost_usd, cache_hit, decision_id, duration_ms, status, created_at, raw_http_meta_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      request.id,
      request.sessionId,
      request.agent,
      request.provider,
      request.projectHash,
      request.model,
      request.inputHash,
      request.outputHash,
      request.tokensIn,
      request.cacheReadTokensIn ?? 0,
      request.tokensOut,
      request.costUsd,
      request.estimatedCostUsd ?? 0,
      request.cacheHit ? 1 : 0,
      request.decisionId,
      request.durationMs,
      request.status,
      request.createdAt,
      ""
    )
}

export function insertToolCall(
  db: StoreDb,
  cacheEncryptionKey: Buffer,
  call: ToolCallRecord
): void {
  const command = sanitizeCommandForStorage(call.command)
  const encryptedCommand = encryptToolCommand(cacheEncryptionKey, command, toolCommandAad(call))
  db
    .prepare(
      `INSERT INTO tool_calls (
         id, session_id, agent, project_hash, tool, command, command_hash, exit_code, duration_ms, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      call.id,
      call.sessionId,
      call.agent,
      call.projectHash,
      call.tool,
      encryptedCommand,
      sha256(command),
      call.exitCode,
      call.durationMs,
      call.status,
      new Date().toISOString()
    )
}

export function updateToolCallResult(db: StoreDb, update: ToolCallResultUpdate): void {
  const result = db
    .prepare(
      `UPDATE tool_calls
       SET exit_code = ?, duration_ms = ?, status = ?
       WHERE id = ?
         AND session_id = ?
         AND agent = ?
         AND project_hash = ?
         AND tool = ?
         AND exit_code IS NULL`
    )
    .run(
      update.exitCode,
      update.durationMs,
      update.status,
      update.callId,
      update.sessionId,
      update.agent,
      update.projectHash,
      update.tool
    )
  if (result.changes === 0) {
    throw new StoreError(
      `Tool call result has no matching pending PreToolUse record: ${update.callId}; ` +
      `session=${update.sessionId}; agent=${update.agent}; project=${update.projectHash}; tool=${update.tool}`
    )
  }
}

export function insertPolicyDecision(db: StoreDb, decision: PolicyDecisionRecord): void {
  db
    .prepare(
      `INSERT INTO policy_decisions (id, request_id, rule_id, action, mode, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      decision.id,
      decision.requestId,
      decision.ruleId,
      decision.action,
      decision.mode,
      decision.reason,
      new Date().toISOString()
    )
}

export function insertCostRecord(db: StoreDb, cost: CostRecord): void {
  db
    .prepare(
      `INSERT INTO cost_records (
         request_id, provider, model, tokens_in, cache_read_tokens_in, tokens_out, cost_usd, currency, pricing_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cost.requestId,
      cost.provider,
      cost.model,
      cost.tokensIn,
      cost.cacheReadTokensIn ?? 0,
      cost.tokensOut,
      cost.costUsd,
      cost.currency,
      cost.pricingStatus ?? "legacy-unknown"
    )
}

export function recordCompletedRequest(
  db: StoreDb,
  cacheEncryptionKey: Buffer,
  completion: CompletedRequestWrite
): void {
  validateCompletedRequest(completion)
  db.exec("BEGIN")
  try {
    insertRequest(db, completion.request)
    insertCostRecord(db, completion.cost)
    for (const decision of completion.policyDecisions) {
      insertPolicyDecision(db, decision)
    }
    if (completion.cacheEntry !== undefined) {
      upsertCacheEntry(db, cacheEncryptionKey, completion.cacheEntry)
    }
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function insertProposal(db: StoreDb, proposal: OptimizationProposal): void {
  db
    .prepare(
      `INSERT INTO optimization_proposals (id, kind, evidence, impact, rule_json, rule_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      proposal.id,
      proposal.kind,
      proposal.evidence,
      proposal.impact,
      proposal.ruleJson,
      proposal.ruleType,
      proposal.status,
      proposal.createdAt
    )
}

export function listProposals(db: StoreDb): OptimizationProposal[] {
  return db
    .prepare(
      `SELECT id, kind, evidence, impact, rule_json AS ruleJson, rule_type AS ruleType, status, created_at AS createdAt
       FROM optimization_proposals
       ORDER BY created_at DESC`
    )
    .all() as OptimizationProposal[]
}

export function getProposal(db: StoreDb, proposalId: string): OptimizationProposal | undefined {
  return db
    .prepare(
      `SELECT id, kind, evidence, impact, rule_json AS ruleJson, rule_type AS ruleType, status, created_at AS createdAt
       FROM optimization_proposals
       WHERE id = ?`
    )
    .get(proposalId) as OptimizationProposal | undefined
}

export function updateProposalStatus(
  db: StoreDb,
  proposalId: string,
  status: "approved" | "rejected" | "applied"
): void {
  const current = getProposal(db, proposalId)
  if (current === undefined) {
    throw new StoreError(`Proposal not found: ${proposalId}`)
  }
  const allowedTransitions = proposalTransitions(current.status)
  if (!allowedTransitions.includes(status)) {
    throw new StoreError(
      `Proposal ${proposalId} cannot transition from ${current.status} to ${status}`
    )
  }
  const result = db
    .prepare(
      `UPDATE optimization_proposals
       SET status = ?
       WHERE id = ?`
    )
    .run(status, proposalId)
  if (result.changes === 0) {
    throw new StoreError(`Proposal status update failed: ${proposalId}`)
  }
}

export function countPolicyDecisions(db: StoreDb): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM policy_decisions").get() as { count: number }
  return row.count
}

export function listPolicyDecisions(db: StoreDb): Array<{
  readonly id: string
  readonly requestId: string
  readonly ruleId: string
  readonly action: string
  readonly mode: string
  readonly reason: string
  readonly createdAt: string
}> {
  return db
    .prepare(
      `SELECT id, request_id AS requestId, rule_id AS ruleId, action, mode, reason, created_at AS createdAt
       FROM policy_decisions
       ORDER BY created_at ASC`
    )
    .all() as Array<{
      readonly id: string
      readonly requestId: string
      readonly ruleId: string
      readonly action: string
      readonly mode: string
      readonly reason: string
      readonly createdAt: string
    }>
}

export function hasOpenProposal(
  db: StoreDb,
  kind: OptimizationProposalKind,
  evidence: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS found
       FROM optimization_proposals
       WHERE kind = ? AND evidence = ? AND status IN ('pending', 'approved', 'applied')
       LIMIT 1`
    )
    .get(kind, evidence) as { found: number } | undefined
  return row !== undefined
}

export function insertTelemetryEvent(db: StoreDb, eventType: string, payloadJson: string): void {
  const record: TelemetryRecord = {
    id: randomId(),
    eventType,
    payloadJson,
    createdAt: new Date().toISOString()
  }
  assertContentFreeTelemetryRecord(record)
  db
    .prepare(
      `INSERT INTO telemetry_events (id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(record.id, record.eventType, record.payloadJson, record.createdAt)
}

export function importTelemetryEvent(db: StoreDb, event: TelemetryEvent): boolean {
  assertContentFreeTelemetryRecord(event)
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO telemetry_events (id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(event.id, event.eventType, event.payloadJson, event.createdAt)
  return result.changes > 0
}

export function listTelemetryEvents(db: StoreDb): TelemetryRecord[] {
  return db
    .prepare(
      `SELECT id, event_type AS eventType, payload_json AS payloadJson, created_at AS createdAt
       FROM telemetry_events
       ORDER BY created_at DESC`
    )
    .all() as TelemetryRecord[]
}

export function listRequestsSince(db: StoreDb, since: string): RequestRecord[] {
  const rows = db
    .prepare(
      `SELECT id, session_id AS sessionId, agent, provider, project_hash AS projectHash, model,
              input_hash AS inputHash, output_hash AS outputHash, tokens_in AS tokensIn,
              cache_read_tokens_in AS cacheReadTokensIn,
              tokens_out AS tokensOut, cost_usd AS costUsd, estimated_cost_usd AS estimatedCostUsd,
              cache_hit AS cacheHit,
              decision_id AS decisionId, duration_ms AS durationMs, status, created_at AS createdAt
       FROM requests
       WHERE created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(since) as Array<Omit<RequestRecord, "cacheHit"> & { cacheHit: number }>
  return rows.map((row) => ({
    ...row,
    cacheHit: row.cacheHit === 1
  }))
}

export function listToolCallsSince(
  db: StoreDb,
  cacheEncryptionKey: Buffer,
  since: string
): ToolCallRecord[] {
  const rows = db
    .prepare(
      `SELECT id, session_id AS sessionId, agent, project_hash AS projectHash, tool, command, command_hash AS commandHash,
              exit_code AS exitCode, duration_ms AS durationMs, status
       FROM tool_calls
       WHERE created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(since) as ToolCallRecord[]
  return rows.map((row) => ({
    ...row,
    command: decryptToolCommand(cacheEncryptionKey, row.command, toolCommandAad(row))
  }))
}

export function listSessions(db: StoreDb): SessionRecord[] {
  return db
    .prepare(
      `SELECT id, project_id AS projectId, agent, status, started_at AS startedAt, ended_at AS endedAt
       FROM sessions
       ORDER BY started_at DESC`
    )
    .all() as SessionRecord[]
}

export function listCostRecords(db: StoreDb): CostRecord[] {
  return db
    .prepare(
      `SELECT request_id AS requestId, provider, model, tokens_in AS tokensIn,
              cache_read_tokens_in AS cacheReadTokensIn,
              tokens_out AS tokensOut, cost_usd AS costUsd, currency, pricing_status AS pricingStatus
       FROM cost_records`
    )
    .all() as CostRecord[]
}

export function countRequestsSince(db: StoreDb, since: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM requests
       WHERE created_at >= ?`
    )
    .get(since) as { count: number }
  return row.count
}

export function sumTokensInSince(db: StoreDb, since: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_in), 0) AS total
       FROM requests
       WHERE created_at >= ?`
    )
    .get(since) as { total: number }
  return row.total
}

export function sumTokensOutSince(db: StoreDb, since: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(tokens_out), 0) AS total
       FROM requests
       WHERE created_at >= ?`
    )
    .get(since) as { total: number }
  return row.total
}

export function sumCostSince(
  db: StoreDb,
  since: string,
  scope?: {
    readonly sessionId?: string
    readonly projectHash?: string
  }
): number {
  const sessionId = scope?.sessionId
  const projectHash = scope?.projectHash
  if (sessionId !== undefined && projectHash !== undefined) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM requests
         WHERE created_at >= ? AND session_id = ? AND project_hash = ?`
      )
      .get(since, sessionId, projectHash) as { total: number }
    return row.total
  }
  if (sessionId !== undefined) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM requests
         WHERE created_at >= ? AND session_id = ?`
      )
      .get(since, sessionId) as { total: number }
    return row.total
  }
  if (projectHash !== undefined) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM requests
         WHERE created_at >= ? AND project_hash = ?`
      )
      .get(since, projectHash) as { total: number }
    return row.total
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
       FROM requests
       WHERE created_at >= ?`
    )
    .get(since) as { total: number }
  return row.total
}

export function sumCostRecords(db: StoreDb): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_records")
    .get() as { total: number }
  return row.total
}

export function countRequestsWithStatusSince(db: StoreDb, status: string, since: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM requests
       WHERE status = ? AND created_at >= ?`
    )
    .get(status, since) as { count: number }
  return row.count
}

export function countCacheHitsSince(db: StoreDb, since: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM requests
       WHERE cache_hit = 1 AND created_at >= ?`
    )
    .get(since) as { count: number }
  return row.count
}

export function averageDurationMsSince(db: StoreDb, since: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(AVG(duration_ms), 0) AS average
       FROM requests
       WHERE created_at >= ?`
    )
    .get(since) as { average: number }
  return row.average
}

export function countRequestsByAgentSince(db: StoreDb, since: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT agent, COUNT(*) AS count
       FROM requests
       WHERE created_at >= ?
       GROUP BY agent`
    )
    .all(since) as Array<{ agent: string; count: number }>
  const result: Record<string, number> = {}
  for (const row of rows) {
    result[row.agent] = row.count
  }
  return result
}

export function sumCacheSavingsSince(db: StoreDb, since: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(r.estimated_cost_usd), 0) AS total
       FROM requests AS r
       WHERE r.cache_hit = 1 AND r.created_at >= ?`
    )
    .get(since) as { total: number }
  return row.total
}

export function getCacheEntry(
  db: StoreDb,
  cacheEncryptionKey: Buffer,
  options: {
    readonly keyHash: string
    readonly provider: ProviderKind
    readonly model: string
    readonly projectHash: string
    readonly accountFingerprint: string
    readonly upstreamUrl: string
  }
): {
  readonly responseJson: string
  readonly expiresAt: string
  readonly contentType: string
  readonly estimatedCostUsd: number
} | undefined {
  const row = db
    .prepare(
      `SELECT key_hash AS keyHash, provider, model,
              response_json AS responseJson, expires_at AS expiresAt,
              content_type AS contentType, estimated_cost_usd AS estimatedCostUsd
       FROM cache_entries
       WHERE key_hash = ? AND provider = ? AND model = ?
         AND project_hash = ? AND account_fingerprint = ? AND upstream_url = ?`
    )
    .get(options.keyHash, options.provider, options.model, options.projectHash, options.accountFingerprint, options.upstreamUrl) as
    | {
        readonly responseJson: string
        readonly expiresAt: string
        readonly contentType: string
        readonly estimatedCostUsd: number
      }
    | undefined
  if (row === undefined) {
    return undefined
  }
  if (row.expiresAt < new Date().toISOString()) {
    return undefined
  }
  return {
    ...row,
    responseJson: decryptCacheValue(
      cacheEncryptionKey,
      row.responseJson,
      cacheAad(options)
    )
  }
}

export function upsertCacheEntry(
  db: StoreDb,
  cacheEncryptionKey: Buffer,
  entry: CacheEntryWrite
): void {
  db
    .prepare(
      `INSERT INTO cache_entries (key_hash, provider, model, project_hash, account_fingerprint, upstream_url, content_type, response_json, estimated_cost_usd, normalized_input_hash, shingle_hash_json, created_at, expires_at, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(key_hash, provider, model) DO UPDATE SET
         project_hash = excluded.project_hash,
         account_fingerprint = excluded.account_fingerprint,
         upstream_url = excluded.upstream_url,
         content_type = excluded.content_type,
         response_json = excluded.response_json,
         estimated_cost_usd = excluded.estimated_cost_usd,
         normalized_input_hash = excluded.normalized_input_hash,
         shingle_hash_json = excluded.shingle_hash_json,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         hits = hits + 1`
    )
    .run(
      entry.keyHash,
      entry.provider,
      entry.model,
      entry.projectHash,
      entry.accountFingerprint,
      entry.upstreamUrl,
      entry.contentType,
      encryptCacheValue(cacheEncryptionKey, entry.responseJson, cacheAad(entry)),
      entry.estimatedCostUsd,
      entry.normalizedInputHash,
      JSON.stringify(entry.shingleHashes),
      entry.createdAt,
      entry.expiresAt
    )
}

export function getSemanticCandidates(
  db: StoreDb,
  cacheEncryptionKey: Buffer,
  options: {
    readonly provider: ProviderKind
    readonly model: string
    readonly projectHash: string
    readonly accountFingerprint: string
    readonly upstreamUrl: string
    readonly limit: number
  }
): Array<{
  readonly responseJson: string
  readonly expiresAt: string
  readonly contentType: string
  readonly estimatedCostUsd: number
  readonly normalizedInputHash: string
  readonly shingleHashes: readonly number[]
}> {
  const safeLimit = Math.min(Math.max(Math.trunc(options.limit), 1), MAX_SEMANTIC_CANDIDATES)
  const rows = db
    .prepare(
      `SELECT key_hash AS keyHash, provider, model,
              response_json AS responseJson, expires_at AS expiresAt,
              content_type AS contentType, estimated_cost_usd AS estimatedCostUsd,
              normalized_input_hash AS normalizedInputHash, shingle_hash_json AS shingleHashJson
       FROM cache_entries
       WHERE provider = ? AND model = ? AND project_hash = ?
         AND account_fingerprint = ? AND upstream_url = ?
         AND normalized_input_hash != ''
         AND expires_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(
      options.provider,
      options.model,
      options.projectHash,
      options.accountFingerprint,
      options.upstreamUrl,
      new Date().toISOString(),
      safeLimit
    ) as Array<{
      readonly keyHash: string
      readonly provider: string
      readonly model: string
      readonly responseJson: string
      readonly expiresAt: string
      readonly contentType: string
      readonly estimatedCostUsd: number
      readonly normalizedInputHash: string
      readonly shingleHashJson: string
    }>
  return rows.map((row) => ({
    responseJson: decryptCacheValue(
      cacheEncryptionKey,
      row.responseJson,
      cacheAad(row)
    ),
    expiresAt: row.expiresAt,
    contentType: row.contentType,
    estimatedCostUsd: row.estimatedCostUsd,
    normalizedInputHash: row.normalizedInputHash,
    shingleHashes: parseShingleHashes(row.shingleHashJson)
  }))
}

export function purgeExpired(db: StoreDb, retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
  db.exec("BEGIN")
  try {
    db
      .prepare(
        `DELETE FROM policy_decisions
         WHERE request_id IN (SELECT id FROM requests WHERE created_at < ?)
            OR request_id IN (SELECT id FROM tool_calls WHERE created_at < ?)`
      )
      .run(cutoff, cutoff)
    db
      .prepare(
        `DELETE FROM cost_records
         WHERE request_id IN (SELECT id FROM requests WHERE created_at < ?)`
      )
      .run(cutoff)
    db.prepare("DELETE FROM requests WHERE created_at < ?").run(cutoff)
    db.prepare("DELETE FROM tool_calls WHERE created_at < ?").run(cutoff)
    db.prepare("DELETE FROM telemetry_events WHERE created_at < ?").run(cutoff)
    db.prepare("DELETE FROM cache_entries WHERE created_at < ?").run(cutoff)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export function countCacheHits(db: StoreDb): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(hits), 0) AS hits FROM cache_entries"
    )
    .get() as { hits: number }
  return row.hits
}

export function countRequests(db: StoreDb): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM requests").get() as { count: number }
  return row.count
}

export function countBlockedRequests(db: StoreDb): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM requests WHERE status = 'blocked'")
    .get() as { count: number }
  return row.count
}

export function countAuditDecisions(db: StoreDb): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM policy_decisions WHERE mode = 'audit'")
    .get() as { count: number }
  return row.count
}
