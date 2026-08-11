# Security Policy

own-harness is a local control plane for AI coding agents. It intercepts
provider traffic and tool events on the local machine, applies policy, and
persists usage records locally. Because it handles agent traffic and
credentials, we treat the confidentiality and integrity of local data as a
core requirement.

## Supported versions

The project is pre-1.0 and currently ships one supported line: the latest
release on the `main` branch and the most recent tagged release.

| Version | Supported |
| --- | --- |
| Latest tagged release on `main` | Yes |
| Older tags | No |
| Unreleased `main` | No support, contributions welcome |

Security fixes are backported only to the latest tagged release. If you run
an older release, upgrade to the newest tag before reporting or evaluating a
vulnerability.

## Security model

The design keeps sensitive data on the local machine and limits network
exposure:

- The proxy and dashboard bind only to `127.0.0.1`. The config rejects any
  non-loopback `server.host`.
- All management and ingest routes require a per-user token stored at
  `~/.own-harness/auth-token` (mode `0600`). Optionally, every proxy route
  can require a token resolved from an environment variable
  (`server.authTokenEnv`).
- Secrets are never stored inline in the project config. The config accepts
  only strict environment-variable references for server and policy
  distribution secrets.
- Tool commands are secret-redacted before persistence, and cache response
  bodies plus redacted tool commands are encrypted with AES-256-GCM. On
  macOS the master key lives in the login Keychain
  (`dev.own-harness.encryption`); key material is never written to logs or
  the database.
- Raw prompts, file contents, and provider payloads are never stored. The
  semantic cache persists only hashes (SHA-256 of normalized text and lossy
  word-shingle hashes).
- Telemetry is local-first and opt-in. Exported records are content-free:
  values are HMAC-hashed with a per-install secret, and export is blocked if
  a record contains raw content.
- Policy distribution bundles are signed (HMAC-SHA256) and verified before
  `harness policy pull` replaces the local policy file.
- Auth comparisons and signature checks use timing-safe operations.
- The workspace config cannot redirect SQLite storage or the telemetry
  consent file; both are fixed under the trusted `HARNESS_HOME`/`~/.own-harness`
  root. State directories must be private to the current user and
  world-writable locations are rejected.

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities. Report them
through GitHub private security advisories instead:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability** (or **New advisory** under
   "Private vulnerability reporting").
3. Describe the vulnerability, the affected version, and a minimal
   reproduction. Include the exact `harness.config.yaml` and environment
   details only if they do not contain secrets.

### What happens next

- You will receive an acknowledgement within 3 business days.
- We will triage the report, confirm the scope and impact, and give you a
  timeline for a fix, usually within 14 days for confirmed high-severity
  issues.
- Fixes are released on the latest tagged version. We will coordinate public
  disclosure with you and credit you in the advisory unless you prefer to
  stay anonymous.

### Scope

In scope:

- Remote exploitation or privilege escalation through the proxy, dashboard,
  ingest, or management API.
- Data confidentiality or integrity failures: plaintext secrets in
  persistence, logs, or telemetry; broken encryption; or unauthorized cache
  scope access.
- Policy distribution weaknesses: signature bypass or forged policy bundles.
- Path traversal or symlink attacks on policy pull, proposal apply, or state
  file handling.

Out of scope (not vulnerabilities):

- Phishing or social engineering of local users.
- Attacks that require the attacker to already have code execution on the
  victim machine.
- Third-party provider outages or billing disputes.
- Feature requests and missing optional hardening, such as non-macOS
  secure-storage integration; report these as regular issues instead.

## Disclosure

We follow coordinated disclosure. Public details are published only after a
fix is available on the latest supported release, unless the issue is
already public or being actively exploited.

## Security-related code rules

Contributors must keep the invariants above intact:

- Secrets must never be written to the database, logs, or telemetry.
- The proxy must bind only to `127.0.0.1`.
- Telemetry remains local-first, opt-in, and content-free; raw code, prompts,
  file contents, and secrets are never published.
- CI runs only local fake providers; real external provider calls stay
  manual and opt-in (see `docs/real-provider-e2e.md`).

These rules are enforced by the project rules in `AGENTS.md` and by the CI
gates (`pnpm audit --prod --audit-level high` and the smoke test suite).

## Known limitations

Tracked in the issue tracker with the `security` label:

- The management token is exported to child agent processes
  (`HARNESS_AUTH_TOKEN`); a separate ingest-only credential is planned
  ([#1](https://github.com/senoldogann/own-harness/issues/1)).
- `harness policy pull` sends the distribution auth token before signature
  verification when running from an untrusted workspace config
  ([#2](https://github.com/senoldogann/own-harness/issues/2)).
- The SQLite database is opened twice with a post-open identity check, and
  WAL sidecar files are not opened with `O_NOFOLLOW`
  ([#3](https://github.com/senoldogann/own-harness/issues/3)).
- Third-party GitHub Actions are referenced by mutable major tags; pinning to
  commit SHAs is planned ([#4](https://github.com/senoldogann/own-harness/issues/4)).
