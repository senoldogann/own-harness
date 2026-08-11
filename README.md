# own-harness

Local control plane for AI coding agents. It intercepts provider traffic and tool events from Claude Code, Codex CLI, OpenCode, and desktop agents, applies policy, reduces cost, records statistics, and produces human-approved optimization proposals.

The cache supports exact-match and semantic MVP modes. Semantic cache normalizes prompt text and compares bounded
word-shingle similarity within the existing project/credential/upstream isolation; it stores only hashes, never raw
prompt text.

## Status

The MVP is implemented. The architecture is documented under `docs/`.

## Install

Requirements: Node.js 22.13+, pnpm 9+.

From a source checkout:

```bash
pnpm install
pnpm pack:release
pnpm install:global
harness --version
```

The CLI tarball, IDE bundles, and `SHA256SUMS` integrity manifest are written to `dist-release/`. The installed binary is `harness`.

## Verify

From a source checkout:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm coverage
pnpm build
pnpm audit --prod --audit-level high
```

`pnpm verify:install` creates a fresh project with `harness init` and checks that the config, policy, and Claude hook assets were provisioned.

## Desktop attach and IDE bundles

```bash
harness attach --desktop codex --verify-only
harness attach --desktop codex -- <args>
pnpm pack:ides
```

`harness attach --desktop codex` verifies the installed `codex` binary, starts the local proxy, records a `chatgpt-desktop` session, and launches Codex with an isolated `CODEX_HOME`. `pnpm pack:ides` writes ZIP bundles and standard VSIX packages for VS Code and Cursor to `dist-release/`.

## Remote access

The proxy binds only to `127.0.0.1`. To require authentication on every proxy route, reference an environment
variable in `harness.config.yaml` and set its value before starting the harness:

```yaml
server:
  host: "127.0.0.1"
  authTokenEnv: "HARNESS_SERVER_AUTH_TOKEN"
```

```bash
export HARNESS_SERVER_AUTH_TOKEN="replace-with-at-least-16-characters"
```

The config stores only the environment-variable name. The token value is resolved in memory and is never written
to the project config, logs, or database.

Local CLI sessions also generate a per-user management token at `~/.own-harness/auth-token` (mode `0600`). The token
protects `/api/*` management and ingest routes; provider routes stay available on loopback for agent traffic. Claude
hooks, OpenCode, and desktop extensions read it from `HARNESS_AUTH_TOKEN` automatically.

The workspace config cannot redirect application state: `store.home` must remain `~/.own-harness`, and
`telemetry.optInFile` must remain `~/.own-harness/telemetry.json`. For an explicitly isolated local run, set
`HARNESS_HOME` to an absolute directory before invoking the CLI; both SQLite and telemetry consent then stay under
that trusted root. The directory and its ancestors must be private to the current user; world-writable locations such
as `/tmp` are rejected. Relative paths and filesystem roots are rejected. Existing `auth-token` files must be regular
files; the CLI rejects symbolic links and enforces mode `0600`.

```bash
export HARNESS_HOME="/absolute/path/to/isolated-own-harness"
```

## Audit export

```bash
harness export --audit --file audit.json
```

The file contains policy decision records with rule, action, mode, reason, and timestamp.

## RTK integration

`rtk` command rewriting is optional and disabled by default. To enable it, set `rtk.enabled: true` in `harness.config.yaml`. When disabled, tool commands are stored and ingested unchanged.

## Commands

```bash
harness init
harness serve
harness run claude -- <args>
harness run codex -- <args>
harness run opencode -- <args>
harness attach --desktop codex
harness dashboard [--debug]
harness dashboard --remote-url http://127.0.0.1:4103 --token <token>
harness stats
harness optimize --since 7d
harness proposal list
harness proposal show <id>
harness proposal approve <id>
harness proposal reject <id>
harness proposal apply <id>
harness policy validate
harness policy pull
harness routing status
harness telemetry status
harness telemetry enable
harness telemetry disable
harness telemetry import <file>
harness export [--file <path>]
```

## Policy distribution

Set `distribution.serverUrl` and `distribution.signatureSecretEnv` in `harness.config.yaml`, then provide the
referenced environment variable before starting or pulling policies:

```yaml
distribution:
  serverUrl: "https://harness.example.com"
  signatureSecretEnv: "HARNESS_DISTRIBUTION_SIGNATURE_SECRET"
```

```bash
export HARNESS_DISTRIBUTION_SIGNATURE_SECRET="replace-with-a-strong-shared-secret"
```

The proxy exposes
`GET /api/v1/policy/bundle` with a signed policy payload; `harness policy pull` verifies the signature, validates
the policy, backs up the current file, and atomically replaces it. Remote clients can override the server URL or
bearer token with `harness policy pull --url <url> --token <token>`.
Policy reads, exclusive backups, and replacement stay inside the real workspace root and reject symbolic-link parents
or final targets.

Existing configs must migrate plaintext fields before upgrading: replace `server.authToken: "..."` with
`server.authTokenEnv: "YOUR_ENV_NAME"`, and replace `distribution.signatureSecret: "..."` with
`distribution.signatureSecretEnv: "YOUR_ENV_NAME"`. Put the previous values in those environment variables and
remove the plaintext values from the config. Inline secret fields are rejected.

The dashboard can render a remote control plane read-only with `harness dashboard --remote-url <url> --token <token>`.
Remote dashboard mode disables local API and proposal mutations by design.

## Automatic routing

Set `routing.mode` to `audit` or `enforce` in `harness.config.yaml` and define model-to-provider rules:

```yaml
routing:
  mode: enforce
  rules:
    - id: cheap-default
      modelRegex: "deepseek/.*"
      provider: "openai-compatible"
      reason: "Route DeepSeek models to the compatible upstream"
```

The first matching rule wins. `audit` records a routing decision without changing the upstream; `enforce` forwards
to the configured provider. Routing is disabled by default. `harness routing status` shows the active configuration.

## OpenCode through a Responses-only router

Set `proxy.translateChatToResponses: true` in `harness.config.yaml` when the configured OpenAI upstream only exposes
the Responses API (for example `codex-router`). The proxy then translates OpenCode chat-completions traffic to
Responses requests and converts non-streaming and streaming responses back to chat-completions format. The adapter's
placeholder `harness-local` API key is not forwarded upstream.

## Upgrade

For a source checkout, pull the new revision, rebuild, pack, and install globally again:

```bash
pnpm build
pnpm pack:cli
pnpm install:global
```

`pnpm install:global` replaces the existing global `own-harness` install. Local harness data under `~/.own-harness` and project `.harness/` files are preserved.

## Uninstall

```bash
pnpm uninstall:global
```

This removes the global `harness` binary. Local SQLite data and project hook files are left in place by design.

## Core idea

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

Telemetry is local-first and opt-in. The learning loop generates compress/cache/deny/budget/route/prompt proposals from local anonymized usage data. Applied proposals always require human approval.

Provider POST requests use exactly one upstream attempt. HTTP 429 throttling responses, transport failures, timeouts,
and 5xx responses are returned without automatic replay because their billing outcome can be ambiguous. HTTP 429
also emits a structured warning that makes manual retry responsibility explicit. Cost records
also expose `pricingStatus`: `priced` for a catalog match, `unpriced` when the model has no configured price, and
`legacy-unknown` for records created before this signal was introduced.

The generated config includes DeepSeek V4 Pro and Flash cache-miss, cache-read, and output prices for Anthropic,
OpenAI, and OpenAI-compatible routes. Usage accounting recognizes Anthropic `cache_read_input_tokens`, OpenAI
`input_tokens_details.cached_tokens` and `prompt_tokens_details.cached_tokens`, and DeepSeek
`prompt_cache_hit_tokens`. When a model has no explicit `cacheReadInputPerMillion` price, cache-read input is charged
at its normal `inputPerMillion` rate instead of assuming an undocumented discount.
