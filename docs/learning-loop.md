# Learning Loop

The learning loop is human-approved optimization, not LLM fine-tuning.

## Signals

- Repeated requests produce `cache` proposals.
- Repeated expensive tool calls produce `compress` proposals.
- Blocked tools produce `deny` proposals.
- High total session cost produces a `budget` proposal.
- High-cost provider usage produces a `route` proposal.
- High error rate or average latency on a provider produces a `route` proposal.
- Repeated high-cost prompts produce `prompt`-kind `compress` proposals.

All proposal kinds are idempotent: `harness optimize` does not create a second pending proposal for the same `kind` and `evidence`.

## Workflow

1. `harness optimize --since 7d`
2. `harness proposal list`
3. `harness proposal show <id>`
4. `harness proposal approve <id>`
5. `harness proposal apply <id>`
