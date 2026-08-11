# Changelog

## 1.0.1 (2026-08-11)

- Add an npm-facing README to the published package so the registry page is
  no longer blank.

## 1.0.0 (2026-08-11)

First stable open-source release.

### Security hardening

- Fixed a proxy authentication bypass where absolute-form and percent-encoded
  request targets bypassed the management-token gate.
- Added a client-disconnect guard for SSE streaming so upstream bodies are not
  read after the client closes.
- Expanded secret redaction to GitLab, GitHub OAuth/SSO, Hugging Face, and AWS
  temporary credential formats.
- Bounded reported token usage from upstream SSE events.
- Raised the policy-distribution HMAC secret minimum to 32 characters and
  hardened header forwarding so local tokens cannot leak upstream.
- `harness verify:install` now validates artifact checksums and file modes.
- CI pins third-party actions to commit SHAs and runs with least-privilege
  permissions.

### Open source

- Published under the MIT license with `SECURITY.md`, `CONTRIBUTING.md`, and a
  code of conduct.
- `own-harness` is published to the npm registry.

## 0.1.0 (2026-08-10)

Initial release candidate.

### Features

- Local provider proxy for Claude, Codex, and OpenAI-compatible traffic with streaming, cache, usage accounting, and policy enforcement.
- Policy DSL with audit, enforce, and disabled modes; tool, request, and session rules; `allow`, `deny`, `cache`, `log`, `redact`, `compress`, `budget`, and `route` actions.
- Local SQLite store with project/session/request/tool/policy/cost/cache/telemetry/proposal records and retention.
- Human-approved learning loop that produces cache, deny, compress, budget, route, and prompt proposals from local usage.
- Claude, Codex, and OpenCode CLI adapters plus Claude hook provisioning through `harness init`.
- VS Code and Cursor extension-host integrations, provisioned OpenCode plugin, and Codex Desktop adapter.
- Local dashboard with session/request detail, proposal workflow, and token-protected raw command debug mode.
- Local-first opt-in telemetry with privacy-safe export and idempotent import.
- Installable CLI tarball with global install, verify, upgrade, and uninstall flows.
- Loopback proxy auth through `server.authTokenEnv` and policy audit export (`harness export --audit`).
- `harness attach --desktop codex` with device verification and session lifecycle.
- VS Code and Cursor ZIP bundles and standard VSIX packages via `pnpm pack:ides`.
- Signed policy bundle distribution through `/api/v1/policy/bundle` and `harness policy pull`.
- Read-only remote management dashboard through `harness dashboard --remote-url`.
- OpenCode adapter supports provider-prefixed model IDs such as `own-harness/<model>`.
- Proxy `start()` returns the actual bound port when configured with port `0`.
- Claude Code runs through DeepSeek's Anthropic-compatible endpoint, including correlated Pre/PostToolUse results.
- VS Code and Cursor VSIX packages are verified in their real extension test hosts with SQLite event proof.

### Security

- Proxy and dashboard bind only to `127.0.0.1`.
- Tool commands are secret-redacted and AES-256-GCM encrypted before persistence; legacy plaintext records are migrated on store open.
- Cache is scoped by project, credential, organization, and upstream URL.
- Claude `PreToolUse` deny uses the payload event and fails closed on ambiguity.
- Dashboard reads and proposal mutations require the local management token through the Authorization header; credentials are never placed in URLs.
- Proxy auth tokens are never forwarded to the upstream provider; upstream credentials are only forwarded when they differ.
- Local `/api/*` routes are protected by a generated per-user management token in `~/.own-harness/auth-token`.
- Workspace config cannot redirect SQLite writes; storage is fixed to `~/.own-harness` unless the trusted process sets
  an absolute `HARNESS_HOME`. Telemetry consent is fixed under the same trusted root. Management-token files reject
  symbolic links and are created exclusively with mode `0600`.
- Policy pull reads, creates its backup exclusively, and atomically replaces the policy through real-workspace-root,
  no-follow file operations; symbolic-link parents and targets are rejected.
- Proposal application uses the same real-workspace-root, exclusive-backup, and atomic-replacement boundary as policy
  pull.
- Auth comparisons are timing-safe; policy bundle signatures use timing-safe verification.
- Config restricts `server.host` to loopback, rejects inline server and distribution secrets, and accepts only strict environment-variable references through `server.authTokenEnv` and `distribution.signatureSecretEnv`; remote service URLs require HTTPS and reject embedded credentials, query strings, and fragments.
- SQLite uses `busy_timeout`, `0600` database permissions, and race-safe project creation.
- Policy decisions now carry `created_at`; cache entries refresh `created_at` on every write.
- Legacy plaintext cache and tool-command records are encrypted on store open.
- Learning loop proposals use stable evidence and tool-specific rules; approved/applied proposals are not regenerated.
- Built-in redaction covers GitHub, Slack, Google, JWT, PEM, and case-insensitive OpenAI-style keys; streaming responses apply policy redaction patterns.
- Streaming and non-streaming upstream responses are size-limited; dashboard responses include security headers.
- Claude's local `/api/hello` connectivity probe is isolated from authenticated `/api/v1/*` management routes.
- Packaged Claude hooks remain compatible with the macOS system Python 3.9 runtime.

### RTK integration

- `rtk.enabled` config flag controls tool command rewriting. It is disabled by default.

### Semantic cache MVP

- Cache rules support `normalized`, `similarityThreshold`, and `maxCandidates` in addition to `exactOnly` and `ttlMinutes`.
- Semantic matching uses a SHA-256 of whitespace-normalized prompt text and a sorted word-bigram shingle fingerprint.
- Similarity search is bounded by `maxCandidates` (default 200), scoped by project, credential, organization, and upstream URL, and disabled for streaming responses.
- Raw prompt text is never stored; only normalized hashes and lossy shingle hashes are persisted.

### Automatic routing MVP

- `routing.mode` supports `disabled`, `audit`, and `enforce`; `routing.rules` map model regexes to providers.
- Routing decisions are recorded as policy decisions with `routing:<rule-id>` rule ids.
- Routing model regexes are validated and ReDoS-checked during config parsing.
- `harness routing status` prints the active routing configuration.

### OpenCode chat-completions translation

- `proxy.translateChatToResponses` lets OpenCode run through a Responses-only upstream such as `codex-router`.
- Non-streaming Responses payloads are converted to chat completions; streaming Responses SSE events are translated to chat-completion chunks with a separate `[DONE]` event.
- Provider usage is extracted from translated Responses payloads and stored in `requests` and `cost_records`.
- Streaming routes no longer crash when a client disconnects after headers are sent.

### Notes

- Real Codex, OpenCode, and Claude+DeepSeek provider E2E, ChatGPT/Codex Desktop attach verification, and IDE packaging are complete.
