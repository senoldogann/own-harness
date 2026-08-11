import { StoreError } from "../errors.js"
import type { StoreDb } from "./store-db.js"

const SCHEMA_VERSION_KEY = "schema_version"

const ALLOWED_MIGRATION_TABLES = new Set([
  "requests",
  "tool_calls",
  "cache_entries",
  "cost_records",
  "optimization_proposals",
  "policy_decisions"
])

const COLUMN_MIGRATIONS: Readonly<Record<string, string>> = {
  estimated_cost_usd: "REAL NOT NULL DEFAULT 0",
  cache_read_tokens_in: "INTEGER NOT NULL DEFAULT 0",
  project_hash: "TEXT NOT NULL DEFAULT ''",
  account_fingerprint: "TEXT NOT NULL DEFAULT ''",
  upstream_url: "TEXT NOT NULL DEFAULT ''",
  content_type: "TEXT NOT NULL DEFAULT 'application/json'",
  normalized_input_hash: "TEXT NOT NULL DEFAULT ''",
  shingle_hash_json: "TEXT NOT NULL DEFAULT '[]'",
  rule_json: "TEXT NOT NULL DEFAULT '{}'",
  rule_type: "TEXT NOT NULL DEFAULT 'request'",
  created_at: "TEXT NOT NULL DEFAULT ''",
  pricing_status: "TEXT NOT NULL DEFAULT 'legacy-unknown'"
}

interface SchemaMigration {
  readonly version: number
  readonly apply: (db: StoreDb) => void
}

function createBaseSchema(db: StoreDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path_hash TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      agent TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      provider TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      tokens_in INTEGER NOT NULL,
      cache_read_tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      decision_id TEXT,
      duration_ms REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      raw_http_meta_json TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_session_id ON requests(session_id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      project_hash TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      command TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at);

    CREATE TABLE IF NOT EXISTS policy_decisions (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      action TEXT NOT NULL,
      mode TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_policy_decisions_request_id ON policy_decisions(request_id);

    CREATE TABLE IF NOT EXISTS cache_entries (
      key_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      project_hash TEXT NOT NULL DEFAULT '',
      account_fingerprint TEXT NOT NULL DEFAULT '',
      upstream_url TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'application/json',
      response_json TEXT NOT NULL,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      normalized_input_hash TEXT NOT NULL DEFAULT '',
      shingle_hash_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_hash, provider, model)
    );

    CREATE TABLE IF NOT EXISTS cost_records (
      request_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INTEGER NOT NULL,
      cache_read_tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      currency TEXT NOT NULL,
      pricing_status TEXT NOT NULL DEFAULT 'legacy-unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_cost_records_request_id ON cost_records(request_id);

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_events_created_at ON telemetry_events(created_at);

    CREATE TABLE IF NOT EXISTS optimization_proposals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      evidence TEXT NOT NULL,
      impact TEXT NOT NULL,
      rule_json TEXT NOT NULL DEFAULT '{}',
      rule_type TEXT NOT NULL DEFAULT 'request',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

function applyColumnMigrations(db: StoreDb): void {
  ensureColumn(db, "requests", "estimated_cost_usd")
  ensureColumn(db, "requests", "cache_read_tokens_in")
  ensureColumn(db, "tool_calls", "project_hash")
  ensureColumn(db, "cache_entries", "project_hash")
  ensureColumn(db, "cache_entries", "account_fingerprint")
  ensureColumn(db, "cache_entries", "upstream_url")
  ensureColumn(db, "cache_entries", "content_type")
  ensureColumn(db, "cache_entries", "estimated_cost_usd")
  ensureColumn(db, "cache_entries", "normalized_input_hash")
  ensureColumn(db, "cache_entries", "shingle_hash_json")
  ensureColumn(db, "optimization_proposals", "rule_json")
  ensureColumn(db, "optimization_proposals", "rule_type")
  ensureColumn(db, "policy_decisions", "created_at")
  ensureColumn(db, "cost_records", "pricing_status")
  ensureColumn(db, "cost_records", "cache_read_tokens_in")
}

function applyIndexMigrations(db: StoreDb): void {
  db.exec("CREATE INDEX IF NOT EXISTS idx_tool_calls_project_hash ON tool_calls(project_hash)")
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_cache_entries_semantic
     ON cache_entries(provider, model, project_hash, account_fingerprint, upstream_url, created_at DESC)`
  )
}

const MIGRATIONS: ReadonlyArray<SchemaMigration> = [
  { version: 1, apply: createBaseSchema },
  { version: 2, apply: applyColumnMigrations },
  { version: 3, apply: applyIndexMigrations }
]

export function migrateSchema(db: StoreDb): void {
  let schemaVersion = 0
  try {
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(SCHEMA_VERSION_KEY) as { value?: string } | undefined
    if (row !== undefined) {
      const parsed = Number(row.value)
      if (Number.isInteger(parsed) && parsed > 0) {
        schemaVersion = parsed
      }
    }
  } catch {
    // schema_meta does not exist on a brand-new database; migrations start from scratch
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= schemaVersion) {
      continue
    }
    migration.apply(db)
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(SCHEMA_VERSION_KEY, String(migration.version))
  }
}

function ensureColumn(db: StoreDb, table: string, column: string): void {
  if (!ALLOWED_MIGRATION_TABLES.has(table)) {
    throw new StoreError(`Unknown table for column migration: ${table}`)
  }
  const definition = COLUMN_MIGRATIONS[column]
  if (definition === undefined) {
    throw new StoreError(`Unknown column migration: ${column}`)
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.some((entry) => entry.name === column)) {
    return
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
