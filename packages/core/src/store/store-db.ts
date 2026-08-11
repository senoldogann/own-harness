import { closeSync, fchmodSync, lstatSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import {
  createPlatformEncryptionKeyStore,
  readLegacyEncryptionKey,
  type EncryptionKeyStore
} from "../encryption-key-store.js"
import {
  assertOpenFileGuardIdentity,
  openRegularFileGuard,
  preparePrivateDatabasePath
} from "../safe-files.js"
import { StoreError } from "../errors.js"

const require = createRequire(resolve(process.cwd(), "__own_harness_runtime__.cjs"))
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")

export type StoreDb = typeof DatabaseSync extends new (...args: never[]) => infer Instance ? Instance : never

export interface OpenDatabaseResult {
  readonly db: StoreDb
  readonly cacheEncryptionKey: Buffer
  readonly legacyEncryptionKey: Buffer | null
  readonly legacyKeyPath: string
}

export function openDatabase(dbPath: string, keyStoreOverride?: EncryptionKeyStore): OpenDatabaseResult {
  const preparedPath = preparePrivateDatabasePath(dbPath)
  const legacyKeyPath = `${preparedPath}.cache-key`
  const keyStore = keyStoreOverride ?? createPlatformEncryptionKeyStore(process.platform, legacyKeyPath)
  const cacheEncryptionKey = keyStore.loadOrCreate()
  const legacyEncryptionKey = process.platform === "darwin" ? readLegacyEncryptionKey(legacyKeyPath) : null
  const databaseGuard = openRegularFileGuard(preparedPath, 0o600)
  try {
    const db = new DatabaseSync(preparedPath)
    try {
      assertOpenFileGuardIdentity(databaseGuard, "Database")
      fchmodSync(databaseGuard.descriptor, 0o600)
    } catch (error) {
      db.close()
      throw error
    }
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    db.exec("PRAGMA busy_timeout = 5000")
    assertNoSymlinkSidecars(preparedPath)
    assertOpenFileGuardIdentity(databaseGuard, "Database")
    return { db, cacheEncryptionKey, legacyEncryptionKey, legacyKeyPath }
  } finally {
    closeSync(databaseGuard.descriptor)
  }
}

function assertNoSymlinkSidecars(dbPath: string): void {
  for (const sidecarPath of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      const metadata = lstatSync(sidecarPath)
      if (metadata.isSymbolicLink()) {
        throw new StoreError(`SQLite sidecar file must not be a symbolic link: ${sidecarPath}`)
      }
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }
}
