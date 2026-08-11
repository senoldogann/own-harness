# Data Model

SQLite database at `~/.own-harness/state.db`. `store.home` is fixed to that application-owned location so a workspace
cannot redirect state writes. An operator or isolated test process can set `HARNESS_HOME` to an absolute non-root
directory before starting the CLI. That directory and its ancestors must be private to the current user; world-writable
locations such as `/tmp` are rejected. The telemetry consent file is fixed to `telemetry.json` under the same trusted
application root; a workspace cannot select another destination.

## Tables

- `projects`
- `sessions`
- `requests`
- `tool_calls`
- `policy_decisions`
- `cache_entries`
- `cost_records`
- `telemetry_events`
- `optimization_proposals`

`requests` includes `estimated_cost_usd` so cache savings can be reported from the original cost instead of a zero-cost cache record. `cache_entries` is scoped by `project_hash`, `account_fingerprint`, and `upstream_url`; cache entries without scope are never served.

`cache_entries` also stores `normalized_input_hash` and `shingle_hash_json` for semantic matching. The normalized
hash is the SHA-256 of whitespace-normalized prompt text; the shingle list is a sorted set of 32-bit hashes of
lowercased word bigrams. Shingles are lossy and not reversible, so raw prompt text is not persisted.

## Privacy

Only hashes and metrics are stored by default. Tool commands are stored with built-in secret patterns redacted (`sk-...`, `AKIA...`), and policy-specific `redact` patterns are applied before persistence when a redaction rule matches. Raw prompts, file contents, and provider payloads are never stored.

Cache response bodies and redacted tool commands are encrypted with AES-256-GCM. On macOS, the application master key
is stored as a generic password in the user's login Keychain under service `dev.own-harness.encryption`; no adjacent key
file is created. When an older `$HARNESS_HOME/state.db.cache-key` exists, every encrypted cache and tool row is
authenticated, decrypted with the legacy key, and re-encrypted with the Keychain key in one SQLite transaction. The
legacy file is removed only after the committed rows have been decrypted again with the Keychain key. Keychain access
errors stop store startup instead of falling back to a plaintext key file.

On non-macOS platforms the key remains in `$HARNESS_HOME/state.db.cache-key` with mode `0600` because this release does
not integrate a native secure-storage provider for those platforms. Deleting the macOS Keychain item makes encrypted
rows unrecoverable; backups therefore need the corresponding login Keychain backup as well as `state.db`. Copying a
database between paths on the same macOS account continues to work because the Keychain key is application-wide.

`sessions`, `projects`, and `optimization_proposals` are retained as metadata beyond the request/tool retention window by design. `requests`, `tool_calls`, `policy_decisions`, `cost_records`, `cache_entries`, and `telemetry_events` are purged by `store.retentionDays`.

`policy_decisions` are keyed by either a `requests.id` or a `tool_calls.id`. Retention purges decisions together with
their old parent records, so recent tool-level audit decisions survive a purge and stale decisions do not accumulate.
