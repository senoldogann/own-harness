# Architecture

own-harness is a local control plane. It does not replace coding agents. It sits between agents and their providers, and between agents and their tool execution path.

## Data flow

```text
CLI agent or desktop extension
        |
        +-- provider traffic --> local HTTP proxy
        +-- tool/hook events --> local ingest
        |
        v
own-harness core
  - policy engine
  - cost engine
  - stats engine
  - learning loop
  - SQLite store
```

## Modules

- `contracts`: shared types and Zod schemas.
- `core`: store, policy, cost, stats, learning, telemetry.
- `proxy`: Fastify HTTP proxy and agent adapters.
- `cli`: user-facing commands.
- `desktop`: VS Code, Cursor, and ChatGPT/Codex desktop adapters.
- `desktop/extensions`: VS Code and Cursor extension hosts with a versioned lifecycle API, diagnostic capability reporting, and native Cursor project-hook provisioning.
- `dashboard`: local HTML dashboard.

## Boundaries

- Secrets are never written to the database or logs.
- The proxy binds only to `127.0.0.1`.
- Telemetry is local-first and opt-in.
- Raw code, prompts, file contents, and secrets are never exported.
- Tool stats APIs return command hashes by default; the dashboard exposes raw commands only in `--debug` mode behind a generated token.
- Tool commands are persisted with built-in secret patterns redacted, and policy `redact` patterns are applied before persistence.
