# IDE Extensions

`vscode/` and `cursor/` use the editor-provided `vscode` extension-host API to register the `own-harness.reportTool` and `own-harness.interceptionStatus` commands and report tool events to the local own-harness ingest endpoint.

The host adapter logic lives in `@own-harness/desktop` (`createVscodeExtension`, `createCursorExtension`, and the shared `createHarnessExtension`). Both entrypoints return a typed, versioned API for cooperating extensions. Cursor additionally installs its native project `preToolUse`, `postToolUse`, and `postToolUseFailure` hooks for automatic lifecycle capture. See `docs/interception.md` for the exact capability boundary.

Run `pnpm pack:ides` from the repository root to produce ZIP bundles and standard `.vsix` packages in `dist-release/`. The command listener is a manual integration point; automatic provider or editor tool interception remains available only when the editor host exposes a corresponding API.
