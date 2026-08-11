# Roadmap

## MVP

### Completed

- [x] Monorepo scaffold with TypeScript, pnpm workspaces, contracts, core, proxy, CLI, desktop, and dashboard packages.
- [x] Local SQLite store with projects, sessions, requests, tool calls, policy decisions, cache entries, cost records, telemetry events, and optimization proposals.
- [x] Policy engine with audit/enforce/disabled modes and YAML DSL validation.
- [x] Provider proxy with Claude `/v1/messages`, OpenAI `/v1/responses`, and OpenAI-compatible `/v1/chat/completions` support.
- [x] Exact-match cache with project/account/upstream scope isolation.
- [x] Semantic cache MVP with normalized prompt hashes and bounded word-shingle similarity.
- [x] Cost estimator, cache-read-aware pricing catalog, provider response usage extraction, and SSE usage accounting.
- [x] Stats engine for requests, tools, cost, cache savings, errors, and latency.
- [x] Local dashboard with HTML escaping and retention-aware store access.
- [x] Human-approved learning loop with idempotent proposals for cache, deny, expensive tools, budget overruns, provider routing, and repeated prompts.
- [x] Claude, Codex, and OpenCode CLI adapters with fake-binary smoke tests.
- [x] Desktop adapters for Codex Desktop, Cursor, VS Code, and OpenCode plugin with smoke tests.
- [x] Claude hook provisioning through `harness init` into `.harness/hooks/claude-hooks.sh`.
- [x] Local-first telemetry consent and privacy-safe export.
- [x] CI gates: typecheck, lint, test, coverage, build, and production audit.

### Completion validation

- [x] Real binary smoke E2E: verify `harness run claude/codex/opencode` against real installed CLIs on developer machines.
  - [x] `harness run claude/codex/opencode --version` works with real installed CLIs.
  - [x] Real Codex session through `harness run codex` against a local fake provider with SSE usage accounting.
  - [x] Real Claude session through `harness run claude` against a local fake provider with SSE usage accounting.
  - [x] Real OpenCode session through `harness run opencode` against a local fake provider with SSE usage accounting.
  - [x] `harness stats` after real Claude and OpenCode sessions.
- [x] `harness optimize` after real Claude and OpenCode sessions.
- [x] Real provider session: Codex + DeepSeek V4 Flash through `codex-router` records real usage (`tokens_in=28638`, `tokens_out=5`).
- [x] Real provider smoke E2E: Codex streaming usage accounting through the harness proxy.
- [x] Real provider E2E for OpenCode through the harness proxy with chat-completions to Responses translation on `codex-router` (`tokens_in=20195`, `tokens_out=7`, pricing `priced`).
- [x] Real provider E2E for Claude Code through the harness proxy and DeepSeek V4 Pro Anthropic endpoint (`tokens_in=12149`, `tokens_out=147`) including a correlated Bash Pre/PostToolUse lifecycle.
- [x] Installable CLI release: npm tarball, global binary, versioned artifacts, and clean uninstall flow.
- [x] Real VS Code and Cursor extension-host integration with installed VSIX activation, command execution, and SQLite event proof.
- [x] VS Code and Cursor ZIP and standard VSIX packaging (`pnpm pack:ides`).
- [x] Real ChatGPT/Codex Desktop attach flow with device-level verification and session lifecycle.
- [x] Policy DSL enforcement for `budget`, `route`, `redact`, and `compress`.
- [x] Learning loop proposals for expensive tools, budget overruns, provider routing, and prompt compression.
- [x] Learning loop proposals for latency/error-based routing.
- [x] Dashboard productization: session detail, request detail, proposal workflow, management-token authentication, and raw-command debug mode.
- [x] Opt-in telemetry pipeline with export/import and human-reviewed improvement loop.
- [x] Release packaging, installation docs, and upgrade path (signing deferred to app-store distribution).
- [x] Loopback-only proxy with optional environment-resolved all-route auth, signed policy distribution for TLS-fronted deployments, and audit export (`harness export --audit`).
- [x] Multi-user enterprise policy distribution and remote management dashboard (signed policy bundle endpoint, `harness policy pull`, read-only remote dashboard).

## Next Release Candidate

- [x] `harness init` clean-project E2E with the packaged global CLI.
- [x] `harness run claude --version` real CLI E2E.
- [x] `harness run codex --version` real CLI E2E.
- [x] `harness run opencode --version` real CLI E2E.
- [x] `harness stats` after real Codex CLI session.
- [x] `harness optimize` after real Codex CLI session.
- [x] Release candidate changelog and install instructions.

## Post-MVP

- [x] Automatic routing MVP: config-driven model-to-provider rules with `disabled`, `audit`, and `enforce` modes.
- [x] RTK interop for tool command rewriting is exposed as the `rtk.enabled` config feature (default off).
- [x] Cursor provider-level tool interception through native lifecycle hooks; VS Code typed lifecycle API and explicit diagnostic capability boundary.
- [x] Multi-user and enterprise policy distribution.
