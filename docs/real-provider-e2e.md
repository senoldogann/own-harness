# Real Provider E2E

Real provider verification is manual and opt-in; CI only uses local fake providers.

## Release artifact installation

The `dist-release/own-harness-cli-0.1.0.tgz` artifact was rebuilt and installed globally on 2026-08-11.
`harness --version` returned `0.1.0`, and the install smoke test verified that `harness init` creates the config,
default policy, and both Claude hook assets in a clean temporary directory. The verifier resolves the Volta shim
when pnpm removes it from the package-script `PATH`; `HARNESS_BIN` remains available for an explicit binary path:

```bash
npm install -g ./dist-release/own-harness-cli-0.1.0.tgz
pnpm verify:install
```

## Codex + DeepSeek through codex-router

```bash
BASE=$(sed -n 's/^openai_base_url = "\(.*\)"/\1/p' ~/.codex/config.toml | head -1)
OPENAI_BASE_URL="$BASE" harness run codex -m deepseek/deepseek-v4-flash exec \
  --skip-git-repo-check --json 'Reply with exactly: E2E-OK'
```

Verified on 2026-08-11 against the rebuilt artifact: `E2E-OK`. SQLite recorded one request with
`agent=codex`, `provider=openai`, `model=deepseek/deepseek-v4-flash`, `tokens_in=28658`, `tokens_out=5`,
`cache_hit=0`, `status=ok`, `pricing_status=priced`, and `cost_usd=0.0040`; the owning session was persisted as
`ended` with a non-null end time.

Codex reports that this custom model is absent from its local model metadata and uses fallback metadata. Its
unrelated featured-plugin warm-up also returned HTTP 401, but neither warning prevented the provider response.

## OpenCode + DeepSeek through harness and codex-router

The harness proxy translates OpenCode chat completions to Responses when the config is enabled:

```yaml
proxy:
  translateChatToResponses: true
```

```bash
BASE=$(sed -n 's/^openai_base_url = "\(.*\)"/\1/p' ~/.codex/config.toml | head -1)
OPENAI_BASE_URL="$BASE" harness run opencode -m own-harness/deepseek/deepseek-v4-flash run \
  --format json 'Reply with exactly: OPENCODE-E2E-OK'
```

Verified on 2026-08-11 against the rebuilt artifact: `OPENCODE-E2E-OK`. The answer request recorded
`tokens_in=20195`, `tokens_out=7`, and `cost_usd=0.0028`; OpenCode also made one auxiliary request with
`tokens_in=537`, `tokens_out=9`, and `cost_usd=0.0001`. Both SQLite rows have `agent=opencode`, `provider=openai`,
`model=deepseek/deepseek-v4-flash`, `cache_hit=0`, `status=ok`, and `pricing_status=priced`, and their owning session
was persisted as `ended` with a non-null end time.

## Claude Code + DeepSeek V4 Pro

Verified on 2026-08-11 through DeepSeek's Anthropic-compatible endpoint using Claude Code 2.1.227. The prompt returned
exactly `CLAUDE-E2E-OK`, and a safe Bash tool returned `CLAUDE-TOOL-OK`. SQLite recorded two successful Anthropic
requests for `deepseek-v4-pro` with aggregate usage `tokens_in=12149`, `tokens_out=147`, `cache_hit=0`, and an ended
Claude session. The correlated Bash row recorded `exit_code=0`, `duration_ms=51`, and `status=ok`; its command is
encrypted at rest.

A separate fresh-project pricing check recorded `11997/38` tokens, `pricing_status=priced`, and `$0.0053` for
DeepSeek V4 Pro. The generated catalog now distinguishes its cache-miss and cache-read input tariffs whenever the
provider usage payload reports cache-read tokens.

The runtime also verified `SessionStart`, `PreToolUse`, and `PostToolUse`. Claude's `/api/hello` connectivity probe is
handled locally without weakening authentication on own-harness `/api/v1/*` management routes.
