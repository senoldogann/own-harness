import { unlinkSync } from "node:fs"
import { StoreError } from "../errors.js"
import { sha256 } from "../hash.js"
import { sanitizeCommandForStorage } from "../redaction.js"
import {
  cacheAad,
  decryptCacheValue,
  decryptToolCommand,
  decryptWithFallback,
  encryptCacheValue,
  encryptToolCommand,
  isEncryptedCacheValue,
  isEncryptedToolCommand,
  toolCommandAad
} from "./store-crypto.js"
import type { StoreDb } from "./store-db.js"

export interface MigrationContext {
  readonly db: StoreDb
  readonly cacheEncryptionKey: Buffer
  readonly legacyEncryptionKey: Buffer | null
}

export function migrateEncryptedContent(context: MigrationContext): void {
  context.db.exec("BEGIN")
  try {
    encryptLegacyCacheEntries(context)
    encryptLegacyToolCommands(context)
    context.db.exec("COMMIT")
  } catch (error) {
    context.db.exec("ROLLBACK")
    throw error
  }
}

function encryptLegacyCacheEntries(context: MigrationContext): void {
  const rows = context.db
    .prepare(
      `SELECT key_hash AS keyHash, provider, model, response_json AS responseJson
       FROM cache_entries`
    )
    .all() as Array<{
      readonly keyHash: string
      readonly provider: string
      readonly model: string
      readonly responseJson: string
    }>
  const update = context.db.prepare(
    `UPDATE cache_entries SET response_json = ?
     WHERE key_hash = ? AND provider = ? AND model = ?`
  )
  for (const row of rows) {
    const aad = cacheAad(row)
    if (isEncryptedCacheValue(row.responseJson)) {
      const decrypted = decryptWithFallback({
        decrypt: decryptCacheValue,
        currentKey: context.cacheEncryptionKey,
        legacyKey: context.legacyEncryptionKey,
        encrypted: row.responseJson,
        aad
      })
      if (!decrypted.requiresReEncryption) {
        continue
      }
      update.run(
        encryptCacheValue(context.cacheEncryptionKey, decrypted.plaintext, aad),
        row.keyHash,
        row.provider,
        row.model
      )
      continue
    }
    update.run(
      encryptCacheValue(context.cacheEncryptionKey, row.responseJson, aad),
      row.keyHash,
      row.provider,
      row.model
    )
  }
}

function encryptLegacyToolCommands(context: MigrationContext): void {
  const rows = context.db
    .prepare("SELECT id, session_id AS sessionId, tool, command FROM tool_calls")
    .all() as Array<{
      readonly id: string
      readonly sessionId: string
      readonly tool: string
      readonly command: string
    }>
  const update = context.db.prepare(
    "UPDATE tool_calls SET command = ?, command_hash = ? WHERE id = ?"
  )
  for (const row of rows) {
    const aad = toolCommandAad(row)
    if (isEncryptedToolCommand(row.command)) {
      const decrypted = decryptWithFallback({
        decrypt: decryptToolCommand,
        currentKey: context.cacheEncryptionKey,
        legacyKey: context.legacyEncryptionKey,
        encrypted: row.command,
        aad
      })
      if (!decrypted.requiresReEncryption) {
        continue
      }
      update.run(
        encryptToolCommand(context.cacheEncryptionKey, decrypted.plaintext, aad),
        sha256(decrypted.plaintext),
        row.id
      )
      continue
    }
    const sanitized = sanitizeCommandForStorage(row.command)
    update.run(
      encryptToolCommand(context.cacheEncryptionKey, sanitized, aad),
      sha256(sanitized),
      row.id
    )
  }
}

export function validateEncryptedContent(db: StoreDb, cacheEncryptionKey: Buffer): void {
  const cacheRows = db
    .prepare(
      `SELECT key_hash AS keyHash, provider, model, response_json AS responseJson
       FROM cache_entries`
    )
    .all() as Array<{
      readonly keyHash: string
      readonly provider: string
      readonly model: string
      readonly responseJson: string
    }>
  for (const row of cacheRows) {
    decryptCacheValue(cacheEncryptionKey, row.responseJson, cacheAad(row))
  }
  const toolRows = db
    .prepare("SELECT id, session_id AS sessionId, tool, command FROM tool_calls")
    .all() as Array<{
      readonly id: string
      readonly sessionId: string
      readonly tool: string
      readonly command: string
    }>
  for (const row of toolRows) {
    decryptToolCommand(cacheEncryptionKey, row.command, toolCommandAad(row))
  }
}

export function unlinkLegacyEncryptionKey(keyPath: string): void {
  try {
    unlinkSync(keyPath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new StoreError(`Legacy encryption key was migrated but could not be removed from ${keyPath}: ${detail}`)
  }
}
