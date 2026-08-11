# Automatic Routing

Automatic routing is a separate control plane from policy `route` rules. It maps request models to providers without
requiring a learning-loop proposal.

## Configuration

```yaml
routing:
  mode: disabled
  rules:
    - id: cheap-default
      modelRegex: "deepseek/.*"
      provider: "openai-compatible"
      reason: "Route DeepSeek models to the compatible upstream"
```

- `disabled` (default): no automatic routing.
- `audit`: routing decisions are recorded with `routing:<rule-id>` but the upstream is unchanged.
- `enforce`: the first matching rule changes the upstream provider and API path.

`modelRegex` values are validated with `safe-regex2` during config parsing. Routing runs after policy evaluation;
an explicit policy `route` rule still wins.

## Status

`harness routing status` prints the active mode and rule summary.
