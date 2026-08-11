# Policy DSL

The policy file is valid YAML and is parsed into a validated JSON structure.

## Modes

- `audit`: decisions are recorded but not enforced.
- `enforce`: decisions are enforced by the proxy.
- `disabled`: traffic passes through without policy evaluation.

## Rule types

- `tool`: matches tool calls.
- `request`: matches provider requests.
- `session`: matches session-level constraints.

## Resolution

The first matching rule wins. If no rule matches, `defaultAction` is used.

## Supported actions

`defaultAction` supports only `allow`, `deny`, and `log`; actions that require per-rule configuration are rejected as defaults so a misconfigured policy cannot silently fail open.

The MVP enforces these actions:

- `allow`: lets the traffic pass.
- `deny`: blocks provider requests and tool ingestion.
- `cache`: serves cached responses when the request is not streaming and the cache scope is complete. With
  `config.exactOnly` (default `true`) it uses the raw request hash; with `config.normalized: true` it also matches
  whitespace-normalized prompts. With `config.similarityThreshold`, it performs a bounded word-shingle similarity
  search over recent scoped cache entries and serves the best candidate at or above the threshold. `config.maxCandidates`
  caps the similarity search window (default `200`). Semantic matching is opt-in and disabled in the generated default policy.
- `log`: records the matched decision.
- `redact`: redacts matching request body strings and non-streaming response text.
- `compress`: truncates long request body strings and non-streaming response text.
- `budget`: blocks the session when recent recorded cost reaches `config.maxUsd`.
- `route`: forwards the request to the provider in `config.routeTo` instead of the original provider.

Session rules are evaluated before every provider request. A matching `deny` session rule blocks the request with `403`; a matching `budget` rule blocks with `429` when the last 24 hours of recorded cost reaches `config.maxUsd`.

`require` and `rewrite` are still rejected during policy validation.

Important limits in the MVP:

- Request-level `redact` and `compress` rewrite the forwarded provider body.
- Response-level `redact` and `compress` apply only to non-streaming responses.
- Streaming responses continue to apply built-in secret redaction only.
- `route` changes the upstream provider and API path, but does not rewrite the request payload; the target provider is expected to be compatible enough for the configured request.
- `budget` uses the last 24 hours of recorded `requests.cost_usd`.
- `cache` config keys: `ttlMinutes`, `exactOnly`, `normalized`, `similarityThreshold`, `maxCandidates`.

All `config.patterns` values and `match.commandRegex` values are checked with `safe-regex2` during validation.

## Example

```yaml
version: 1
mode: audit
defaultAction: allow
project: "*"
rules:
  - id: deny-destructive
    type: tool
    match:
      tools: ["Bash", "Shell"]
      commandRegex: "rm -rf /"
    action: deny
    reason: "Destructive command blocked"

  - id: route-to-compatible
    type: request
    match:
      providers: ["openai"]
    action: route
    reason: "OpenAI-compatible provider"
    config:
      routeTo: "openai-compatible"
```
