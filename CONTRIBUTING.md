# Contributing

Thanks for considering a contribution to own-harness. This document covers
development setup, the contribution workflow, and the project's quality
expectations.

## Project overview

own-harness is a pnpm workspace monorepo with these packages:

- `packages/contracts` — shared TypeScript types and schemas.
- `packages/core` — policy engine, cost engine, stats engine, learning loop,
  SQLite store, redaction, and telemetry.
- `packages/proxy` — loopback HTTP proxy for provider traffic and local
  ingest/API routes.
- `packages/desktop` — Codex Desktop, Cursor, VS Code, and OpenCode adapters
  plus IDE extension bundles.
- `packages/dashboard` — local dashboard UI.
- `packages/cli` — the `harness` CLI binary.

Architecture details live under `docs/` (start with `docs/architecture.md`
and `docs/data-model.md`).

## Development setup

Requirements: Node.js 22.13+ and pnpm 9+.

```bash
pnpm install
```

Available checks, all run at the repository root:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm coverage
pnpm build
pnpm audit --prod --audit-level high
```

`pnpm verify:install` provisions a fresh project with `harness init` and
verifies that the config, policy, and Claude hook assets were installed.
`pnpm pack:release` produces the CLI tarball, IDE bundles, and the
`SHA256SUMS` manifest under `dist-release/`.

## How to contribute

1. Fork the repository and create a branch from `main`.
2. Make focused changes that match the existing style. Read `AGENTS.md` at
   the repository root before editing; it is the source of truth for code
   style, error handling, and testing rules.
3. Run the full check suite listed above before opening a pull request.
4. Open a pull request against `main` using the pull request template. Fill
   in the behavior change, the verification you ran, and any security
   implications.
5. Keep the change minimal and scoped. Do not mix unrelated refactors into
   the same pull request.

## Code rules

The repository enforces the following conventions; details are in
`AGENTS.md`:

- Comments and documentation are in English.
- Prefer functional programming and pure functions. Use classes only for
  connectors and interfaces to external systems.
- Use strict typing everywhere; avoid untyped variables and generic types.
- No default parameter values; make all parameters explicit.
- Raise errors explicitly with specific error types and actionable messages.
  Never silently ignore failures and do not add fallbacks unless explicitly
  requested.
- Fix root causes, not symptoms. Prefer structured logging over interpolated
  messages.
- Do not revert unrelated changes in the working tree.

## Testing strategy

Respect the existing suite; do not add unit tests by default.

- Prefer integration, end-to-end, and smoke tests that validate real
  behavior over unit tests. Unit tests are reserved for stable datasets and
  pure data transformations.
- Avoid mocks when real calls are practical. Prefer local fake provider
  tests over fragile mock-based coverage (see
  `packages/proxy/test/fake-provider.test.ts`).
- Real external provider calls are manual and opt-in
  (`docs/real-provider-e2e.md`); CI never calls real providers.
- Add only the minimum test coverage needed for the requested change.

## Security and privacy expectations

- Secrets must never be written to the database or logs.
- The proxy must bind only to `127.0.0.1`.
- Telemetry is local-first and opt-in; raw code, prompts, file contents, and
  secrets are never published.
- Raw prompts and provider payloads are never persisted; tool commands are
  redacted and encrypted (AES-256-GCM) before storage.
- Changes that touch the security model must be flagged in the pull request
  description and, if a vulnerability is involved, reported through
  `SECURITY.md`'s private advisory flow instead of a public issue.

## Reporting bugs and feature requests

Use the issue templates:

- Bug reports: `.github/ISSUE_TEMPLATE/bug_report.md`
- Feature requests: `.github/ISSUE_TEMPLATE/feature_request.md`

For security vulnerabilities, follow `SECURITY.md` and do not open a public
issue.

## Code of conduct

All contributors are expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Be respectful, constructive, and
inclusive in issues, pull requests, and community spaces.
