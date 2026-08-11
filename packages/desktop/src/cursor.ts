import type { AgentKind } from "@own-harness/contracts"
import type { HarnessStore } from "@own-harness/core"
import { randomId, sha256 } from "@own-harness/core"

export interface CursorEvent {
  readonly tool: string
  readonly command: string
  readonly sessionId: string
  readonly projectHash: string
  readonly durationMs: number
  readonly exitCode: number | null
}

export class CursorAdapter {
  public readonly kind: AgentKind = "cursor"

  public constructor(private readonly store: HarnessStore) {}

  public readonly recordToolCall = (event: CursorEvent): void => {
    this.store.insertToolCall({
      id: randomId(),
      sessionId: event.sessionId,
      agent: this.kind,
      projectHash: event.projectHash,
      tool: event.tool,
      command: event.command,
      commandHash: sha256(event.command),
      exitCode: event.exitCode,
      durationMs: event.durationMs,
      status: event.exitCode === 0 ? "ok" : "error"
    })
  }
}
