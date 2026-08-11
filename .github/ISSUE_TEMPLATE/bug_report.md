---
name: Bug report
about: Report a reproducible problem with own-harness
title: "[Bug] "
labels: bug
assignees: ""
---

## Summary

A clear and concise description of the bug. Include what you expected to
happen and what actually happened.

## Environment

- own-harness version (from `harness --version`):
- Node.js version:
- pnpm version:
- Operating system and architecture:
- Provider/agent (Claude Code, Codex CLI, OpenCode, desktop extension):
- Install method (source checkout, global CLI tarball, IDE bundle):

## Reproduction

Steps to reproduce, in order:

1.
2.
3.

Include the exact commands you ran. Redact any secrets and provider API keys
before pasting output. Do not include prompt content unless it is essential;
own-harness never stores raw prompts.

## Configuration

Paste the relevant part of `harness.config.yaml` with secret values replaced
by environment-variable names. Inline secrets are rejected by design, so a
redacted config is expected.

## Expected behavior

## Actual behavior

Paste command output and, if available, the harness log lines or dashboard
error. Omit any sensitive values.

## Additional context

- Does the issue reproduce with `HARNESS_HOME` pointed at a fresh isolated
  directory?
- Does it reproduce on the latest tagged release?
- Any related issues or documentation.
