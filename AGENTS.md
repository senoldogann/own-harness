# Global Rules

## Code Style

- Comments in English.
- Prefer functional programming over OOP.
- Use OOP classes only for connectors and interfaces to external systems.
- Write pure functions; only modify return values, never input parameters or global state.
- Follow DRY, KISS, and YAGNI principles.
- Use strict typing everywhere: function returns, variables, collections.
- Check if logic already exists before writing new code.
- Avoid untyped variables and generic types.
- Never use default parameter values; make all parameters explicit.
- Create proper type definitions for complex data structures.
- All imports at the top of the file.
- Write simple single-purpose functions; no multi-mode behavior, no flag parameters that switch logic.

## Error Handling

- Always raise errors explicitly, never silently ignore them.
- Use specific error types that clearly indicate what went wrong.
- Avoid catch-all exception handlers that hide the root cause.
- Error messages should be clear and actionable.
- No fallbacks unless explicitly requested.
- Fix root causes, not symptoms.
- External API or service calls: use retries with warnings, then raise the last error.
- Error messages must include enough context to debug: request params, response body, status codes.
- Logging should use structured fields instead of interpolating dynamic values into message strings.

## Language Specifics

- Prefer structured data models over loose dictionaries.
- Avoid generic types like `any`, `unknown`, or `Record<string, any>`.
- Use modern package management files like `package.json`.
- Use the language's strict type features when available.

## Libraries and Dependencies

- Install dependencies in project environments, not globally.
- Add dependencies to project config files, not as one-off manual installs.
- If a dependency is installed locally, read its source code when needed instead of guessing.
- Update project configuration files when adding dependencies.

## Testing

- Respect the current repository testing strategy and existing test suite.
- Do not add new unit tests by default.
- Prefer integration, end-to-end, or smoke tests that validate real behavior.
- Use unit tests only rarely, mainly for stable datasets or pure data transformations.
- Never add unit tests just to increase coverage numbers.
- Avoid mocks when real calls are practical.
- Prefer local fake provider integration tests over fragile mock-based coverage.
- Add only the minimum test coverage needed for the requested change.

## Terminal Usage

- Prefer non-interactive commands with flags over interactive ones.
- Always use non-interactive git diff: `git --no-pager diff` or `git diff | cat`.
- Prefer `rg` for searching code and files.

## Codex Workflow

- Read the existing code and relevant `AGENTS.md` files before editing.
- Keep changes minimal and related to the current request.
- Match the existing style of the repository even if it differs from personal preference.
- Do not revert unrelated changes.
- If unsure, inspect the codebase instead of inventing patterns.
- When project instructions include test or lint commands, run them before finishing if the task changed code.

## Verification

- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before finishing any task that changes code.
- Security: secrets must never be written to the database or logs.
- Local proxy must bind only to `127.0.0.1`.
- Telemetry is local-first and opt-in; raw code, prompts, file contents, and secrets must never be published.
- Real external provider calls are not made in CI; tests use local fake providers.
