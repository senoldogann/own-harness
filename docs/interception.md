# Tool interception

own-harness uses the strongest lifecycle surface exposed by each host. It does not infer tool completion from editor UI state.

## Cursor

When a folder is open, the Cursor extension installs project hooks in `.cursor/hooks.json` for `preToolUse`, `postToolUse`, and `postToolUseFailure`. The generated `.cursor/own-harness-hook.cjs` forwards the host-provided `tool_use_id`, so successful and failed tool results update the same SQLite record as their start event. Existing project hooks are preserved and duplicate own-harness entries are replaced during activation. Diagnostic commands remain available in an empty Cursor window without writing hook files.

Cursor hook payloads provide a nonzero failure signal but not a process exit code for every tool kind. Failure events therefore use exit code `1`; successful events use `0`. The real duration is retained when Cursor provides `duration_ms`.

## VS Code

The stable VS Code extension API can register and invoke language-model tools, but it does not expose a global event for observing tool invocations owned by other extensions. own-harness therefore exports a versioned extension API for cooperating extensions:

```ts
interface HarnessExtensionApi {
  readonly apiVersion: 1
  readonly agent: "vscode" | "cursor"
  readonly capabilities: {
    readonly globalToolObservation: false
    readonly typedLifecycleApi: true
    readonly cursorProjectHooks: boolean
  }
  readonly reportTool: (event: HarnessToolEvent) => Promise<void>
}
```

Consumers obtain this object from the extension's `activate()` result and report start/result events with the same `toolUseId`. The `own-harness.interceptionStatus` command returns the same capability declaration for diagnostics. `own-harness.reportTool` remains available for command-based integrations.

This API does not claim to observe third-party VS Code tools that do not call it. Full automatic interception in VS Code requires a future host-level global lifecycle event or cooperation from the tool-owning extension.

## OpenCode

The generated OpenCode plugin uses `tool.execute.before` and `tool.execute.after`. It also subscribes to `message.part.updated`: a tool part whose state is `error` produces `PostToolUseFailure` even when OpenCode omits `tool.execute.after`. The `callID` is used for correlation and duplicate terminal events are suppressed.

This closes the missing-after failure path exposed by OpenCode 1.18.16 without guessing from session-level errors.
