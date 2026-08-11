# own-harness

Local control plane for AI coding agents. `own-harness` intercepts provider
traffic and tool events from Claude Code, Codex, OpenCode, and desktop agents,
applies policy, reduces cost, records statistics, and produces
human-approved optimization proposals.

The proxy binds only to `127.0.0.1`, telemetry is opt-in and content-free, and
stored tool commands are encrypted at rest.

## Install

Requirements: Node.js 22.13+.

```bash
npm install -g own-harness
harness --version
```

## Quick start

Run from the project directory you want to monitor:

```bash
harness init        # writes harness.config.yaml, policy, and hook assets
harness run claude  # launches Claude through the local proxy
harness dashboard   # open http://127.0.0.1:4300 for usage, cost, and tools
```

`harness run codex` and `harness run opencode` work the same way. Usage,
cost, and tool records are stored locally in `~/.own-harness/state.db`.

The dashboard asks for a token: username `own-harness`, password is the local
management token printed by:

```bash
cat ~/.own-harness/auth-token
```

## Useful commands

```bash
harness stats       # request, token, and cost summary
harness optimize    # generate optimization proposals from local usage
harness proposal list   # review proposals
harness proposal apply  # apply an approved proposal
harness export --audit  # export policy audit records
```

## Documentation

Architecture, policy DSL, data model, and provider details live in the
[GitHub repository](https://github.com/senoldogann/own-harness) under `docs/`.

## License

MIT
