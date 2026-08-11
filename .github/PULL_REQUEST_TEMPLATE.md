## Summary

What does this change do and why? Keep it scoped; if it fixes an issue,
reference it (for example `Fixes #123`).

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Refactor
- [ ] Dependency update
- [ ] Release/packaging

## Behavior change

Describe user-visible behavior before and after this change. Include
`harness` commands or `harness.config.yaml` keys that change, if any.

## Verification

Check all that apply:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm coverage` passes
- [ ] `pnpm build` passes
- [ ] `pnpm audit --prod --audit-level high` passes
- [ ] Smoke/E2E test added or updated for the changed behavior

Describe the verification you ran (commands and observed results). CI uses
local fake providers only; if real provider calls are involved, note that
they were manual and opt-in.

## Security and privacy impact

Check any that apply and explain:

- [ ] No impact on the security or privacy model.
- [ ] Touches proxy binding, authentication, or token handling.
- [ ] Touches persistence, encryption, redaction, or telemetry.
- [ ] Touches policy distribution or signature verification.
- [ ] Introduces or updates dependencies.

Remember: secrets must never be written to the database or logs, the proxy
must bind only to `127.0.0.1`, and telemetry stays local-first, opt-in, and
content-free. If this change touches the security model, mention the
implications in the description.

## Checklist

- [ ] Followed the code rules in `AGENTS.md` (English comments, strict
  typing, no default parameters, explicit error handling).
- [ ] Changes are minimal and unrelated refactors are not included.
- [ ] No unrelated files were changed.
