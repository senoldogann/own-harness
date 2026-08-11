import type {
  CostRecord,
  OptimizationProposal,
  OptimizationProposalKind,
  PolicyDecisionRecord,
  RequestRecord,
  SessionRecord,
  TelemetryEvent,
  ToolCallRecord
} from "@own-harness/contracts"
import type { EncryptionKeyStore } from "../encryption-key-store.js"
import type { CompletedRequestWrite } from "../store-values.js"
import { openDatabase, type StoreDb } from "./store-db.js"
import {
  migrateEncryptedContent,
  unlinkLegacyEncryptionKey,
  validateEncryptedContent
} from "./store-migrate-data.js"
import * as queries from "./store-queries.js"
import type { ToolCallResultUpdate } from "./store-queries.js"
import { migrateSchema } from "./store-schema.js"

export type { ToolCallResultUpdate } from "./store-queries.js"

export interface StoreOptions {
  readonly dbPath: string
  readonly retentionDays?: number
  readonly encryptionKeyStore?: EncryptionKeyStore
}

export class HarnessStore {
  private readonly db: StoreDb
  private readonly cacheEncryptionKey: Buffer

  public constructor(options: StoreOptions) {
    const opened = openDatabase(options.dbPath, options.encryptionKeyStore)
    this.db = opened.db
    this.cacheEncryptionKey = opened.cacheEncryptionKey
    migrateSchema(this.db)
    migrateEncryptedContent({
      db: this.db,
      cacheEncryptionKey: this.cacheEncryptionKey,
      legacyEncryptionKey: opened.legacyEncryptionKey
    })
    if (opened.legacyEncryptionKey !== null) {
      validateEncryptedContent(this.db, this.cacheEncryptionKey)
      unlinkLegacyEncryptionKey(opened.legacyKeyPath)
    }
    if (options.retentionDays !== undefined) {
      this.purgeExpired(options.retentionDays)
    }
  }

  public close(): void {
    queries.closeDatabase(this.db)
  }

  public insertProject(pathHash: string, displayName: string): number {
    return queries.insertProject(this.db, pathHash, displayName)
  }

  public findOrCreateProject(pathHash: string, displayName: string): number {
    return queries.findOrCreateProject(this.db, pathHash, displayName)
  }

  public insertSession(session: SessionRecord): void {
    queries.insertSession(this.db, session)
  }

  public endSession(sessionId: string): void {
    queries.endSession(this.db, sessionId)
  }

  public insertRequest(request: RequestRecord): void {
    queries.insertRequest(this.db, request)
  }

  public insertToolCall(call: ToolCallRecord): void {
    queries.insertToolCall(this.db, this.cacheEncryptionKey, call)
  }

  public updateToolCallResult(update: ToolCallResultUpdate): void {
    queries.updateToolCallResult(this.db, update)
  }

  public insertPolicyDecision(decision: PolicyDecisionRecord): void {
    queries.insertPolicyDecision(this.db, decision)
  }

  public insertCostRecord(cost: CostRecord): void {
    queries.insertCostRecord(this.db, cost)
  }

  public recordCompletedRequest(completion: CompletedRequestWrite): void {
    queries.recordCompletedRequest(this.db, this.cacheEncryptionKey, completion)
  }

  public insertProposal(proposal: OptimizationProposal): void {
    queries.insertProposal(this.db, proposal)
  }

  public listProposals(): OptimizationProposal[] {
    return queries.listProposals(this.db)
  }

  public getProposal(proposalId: string): OptimizationProposal | undefined {
    return queries.getProposal(this.db, proposalId)
  }

  public updateProposalStatus(proposalId: string, status: "approved" | "rejected" | "applied"): void {
    queries.updateProposalStatus(this.db, proposalId, status)
  }

  public countPolicyDecisions(): number {
    return queries.countPolicyDecisions(this.db)
  }

  public listPolicyDecisions(): ReturnType<typeof queries.listPolicyDecisions> {
    return queries.listPolicyDecisions(this.db)
  }

  public hasOpenProposal(kind: OptimizationProposalKind, evidence: string): boolean {
    return queries.hasOpenProposal(this.db, kind, evidence)
  }

  public insertTelemetryEvent(eventType: string, payloadJson: string): void {
    queries.insertTelemetryEvent(this.db, eventType, payloadJson)
  }

  public importTelemetryEvent(event: TelemetryEvent): boolean {
    return queries.importTelemetryEvent(this.db, event)
  }

  public listTelemetryEvents(): ReturnType<typeof queries.listTelemetryEvents> {
    return queries.listTelemetryEvents(this.db)
  }

  public listRequestsSince(since: string): RequestRecord[] {
    return queries.listRequestsSince(this.db, since)
  }

  public listToolCallsSince(since: string): ToolCallRecord[] {
    return queries.listToolCallsSince(this.db, this.cacheEncryptionKey, since)
  }

  public listSessions(): SessionRecord[] {
    return queries.listSessions(this.db)
  }

  public listCostRecords(): CostRecord[] {
    return queries.listCostRecords(this.db)
  }

  public countRequestsSince(since: string): number {
    return queries.countRequestsSince(this.db, since)
  }

  public sumTokensInSince(since: string): number {
    return queries.sumTokensInSince(this.db, since)
  }

  public sumTokensOutSince(since: string): number {
    return queries.sumTokensOutSince(this.db, since)
  }

  public sumCostSince(
    since: string,
    scope?: {
      readonly sessionId?: string
      readonly projectHash?: string
    }
  ): number {
    return queries.sumCostSince(this.db, since, scope)
  }

  public sumCostRecords(): number {
    return queries.sumCostRecords(this.db)
  }

  public countRequestsWithStatusSince(status: string, since: string): number {
    return queries.countRequestsWithStatusSince(this.db, status, since)
  }

  public countCacheHitsSince(since: string): number {
    return queries.countCacheHitsSince(this.db, since)
  }

  public averageDurationMsSince(since: string): number {
    return queries.averageDurationMsSince(this.db, since)
  }

  public countRequestsByAgentSince(since: string): Record<string, number> {
    return queries.countRequestsByAgentSince(this.db, since)
  }

  public sumCacheSavingsSince(since: string): number {
    return queries.sumCacheSavingsSince(this.db, since)
  }

  public getCacheEntry(options: {
    readonly keyHash: string
    readonly provider: CostRecord["provider"]
    readonly model: string
    readonly projectHash: string
    readonly accountFingerprint: string
    readonly upstreamUrl: string
  }): ReturnType<typeof queries.getCacheEntry> {
    return queries.getCacheEntry(this.db, this.cacheEncryptionKey, options)
  }

  public upsertCacheEntry(entry: Parameters<typeof queries.upsertCacheEntry>[2]): void {
    queries.upsertCacheEntry(this.db, this.cacheEncryptionKey, entry)
  }

  public getSemanticCandidates(options: {
    readonly provider: CostRecord["provider"]
    readonly model: string
    readonly projectHash: string
    readonly accountFingerprint: string
    readonly upstreamUrl: string
    readonly limit: number
  }): ReturnType<typeof queries.getSemanticCandidates> {
    return queries.getSemanticCandidates(this.db, this.cacheEncryptionKey, options)
  }

  public purgeExpired(retentionDays: number): void {
    queries.purgeExpired(this.db, retentionDays)
  }

  public countCacheHits(): number {
    return queries.countCacheHits(this.db)
  }

  public countRequests(): number {
    return queries.countRequests(this.db)
  }

  public countBlockedRequests(): number {
    return queries.countBlockedRequests(this.db)
  }

  public countAuditDecisions(): number {
    return queries.countAuditDecisions(this.db)
  }
}
