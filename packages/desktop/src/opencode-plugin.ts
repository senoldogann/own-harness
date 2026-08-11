import type { AgentKind } from "@own-harness/contracts"

export interface OpenCodeToolArgs {
  readonly command?: string
  readonly input?: string
  readonly [key: string]: unknown
}

export interface OpenCodeToolBeforeInput {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
}

export interface OpenCodeToolBeforeOutput {
  readonly args: OpenCodeToolArgs
}

export interface OpenCodeToolAfterInput extends OpenCodeToolBeforeInput {
  readonly args: OpenCodeToolArgs
}

export interface OpenCodeToolAfterOutput {
  readonly metadata?: {
    readonly durationMs?: unknown
    readonly exitCode?: unknown
    readonly [key: string]: unknown
  }
}

export interface OpenCodeToolPartErrorEvent {
  readonly type: "message.part.updated"
  readonly properties: {
    readonly sessionID: string
    readonly part: {
      readonly type: "tool"
      readonly callID: string
      readonly tool: string
      readonly state: {
        readonly status: "error"
        readonly input: OpenCodeToolArgs
        readonly metadata?: Readonly<Record<string, unknown>>
        readonly time: {
          readonly start: number
          readonly end: number
        }
      }
    }
  }
}

export interface OpenCodeOtherEvent {
  readonly type: string
  readonly properties?: Readonly<Record<string, unknown>>
}

export type OpenCodeEvent = OpenCodeToolPartErrorEvent | OpenCodeOtherEvent

export interface OpenCodePlugin {
  readonly name: string
  readonly hooks: {
    readonly event: (input: { readonly event: OpenCodeEvent }) => Promise<void>
    readonly "tool.execute.before": (
      input: OpenCodeToolBeforeInput,
      output: OpenCodeToolBeforeOutput
    ) => Promise<void>
    readonly "tool.execute.after": (
      input: OpenCodeToolAfterInput,
      output: OpenCodeToolAfterOutput
    ) => Promise<void>
  }
}

export function createOpenCodeHarnessPlugin(): OpenCodePlugin {
  const startedAtByCallId = new Map<string, number>()
  const finalizedCallIds = new Set<string>()
  return {
    name: "own-harness",
    hooks: {
      event: async ({ event }) => {
        const failure = readToolPartFailure(event)
        if (failure === undefined || finalizedCallIds.has(failure.callID)) {
          return
        }
        rememberFinalizedCall(finalizedCallIds, failure.callID)
        startedAtByCallId.delete(failure.callID)
        await ingestFromOpenCode({
          input: {
            tool: failure.tool,
            sessionID: failure.sessionID,
            callID: failure.callID
          },
          args: failure.args,
          hookEvent: "PostToolUseFailure",
          exitCode: failure.exitCode,
          durationMs: failure.durationMs
        })
      },
      "tool.execute.before": async (input, output) => {
        assertCallId(input.callID)
        finalizedCallIds.delete(input.callID)
        await ingestFromOpenCode({
          input,
          args: output.args,
          hookEvent: "PreToolUse",
          exitCode: null,
          durationMs: 0
        })
        startedAtByCallId.set(input.callID, Date.now())
      },
      "tool.execute.after": async (input, output) => {
        assertCallId(input.callID)
        if (finalizedCallIds.delete(input.callID)) {
          return
        }
        const exitCode = toolExitCode(output)
        const durationMs = toolDurationMs(output, startedAtByCallId.get(input.callID))
        startedAtByCallId.delete(input.callID)
        await ingestFromOpenCode({
          input,
          args: input.args,
          hookEvent: exitCode === 0 ? "PostToolUse" : "PostToolUseFailure",
          exitCode,
          durationMs
        })
      }
    }
  }
}

function rememberFinalizedCall(finalizedCallIds: Set<string>, callId: string): void {
  const maximumRememberedCalls = 2_048
  if (finalizedCallIds.size >= maximumRememberedCalls) {
    const oldestCallId = finalizedCallIds.values().next().value
    if (typeof oldestCallId === "string") {
      finalizedCallIds.delete(oldestCallId)
    }
  }
  finalizedCallIds.add(callId)
}

interface OpenCodeToolFailure {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly args: OpenCodeToolArgs
  readonly exitCode: number
  readonly durationMs: number
}

function readToolPartFailure(event: OpenCodeEvent): OpenCodeToolFailure | undefined {
  if (event.type !== "message.part.updated") {
    return undefined
  }
  const candidate = event as OpenCodeToolPartErrorEvent
  const part = candidate.properties.part
  if (part.type !== "tool" || part.state.status !== "error") {
    return undefined
  }
  assertCallId(part.callID)
  const metadataExitCode = part.state.metadata?.exitCode
  return {
    tool: part.tool,
    sessionID: candidate.properties.sessionID,
    callID: part.callID,
    args: part.state.input,
    exitCode: typeof metadataExitCode === "number" && Number.isInteger(metadataExitCode) && metadataExitCode > 0
      ? metadataExitCode
      : 1,
    durationMs: Math.max(0, part.state.time.end - part.state.time.start)
  }
}

interface OpenCodeIngestOptions {
  readonly input: OpenCodeToolBeforeInput
  readonly args: OpenCodeToolArgs
  readonly hookEvent: "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  readonly exitCode: number | null
  readonly durationMs: number
}

async function ingestFromOpenCode(options: OpenCodeIngestOptions): Promise<void> {
  const command = readCommand(options.args)
  if (command.length === 0) {
    return
  }
  const baseUrl = process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:4103"
  const headers: Record<string, string> = { "content-type": "application/json" }
  const authToken = process.env.HARNESS_AUTH_TOKEN
  if (authToken !== undefined && authToken.length > 0) {
    headers.authorization = `Bearer ${authToken}`
  }
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tool: options.input.tool,
      command,
      sessionId: process.env.HARNESS_SESSION_ID ?? options.input.sessionID,
      projectHash: process.env.HARNESS_PROJECT_HASH,
      agent: "opencode" as AgentKind,
      exitCode: options.exitCode,
      durationMs: options.durationMs,
      hookEvent: options.hookEvent,
      toolUseId: options.input.callID
    })
  })
  if (!response.ok) {
    throw new Error(`Harness ingest failed with status ${response.status}`)
  }
}

function readCommand(args: OpenCodeToolArgs): string {
  if (typeof args.command === "string") {
    return args.command
  }
  if (typeof args.input === "string") {
    return args.input
  }
  return ""
}

function toolExitCode(output: OpenCodeToolAfterOutput): number {
  const raw = output.metadata?.exitCode
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0
}

function toolDurationMs(output: OpenCodeToolAfterOutput, startedAt: number | undefined): number {
  const raw = output.metadata?.durationMs
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) {
    return raw
  }
  return startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)
}

function assertCallId(callId: string): void {
  if (callId.length === 0) {
    throw new Error("OpenCode tool hook requires callID for lifecycle correlation")
  }
}

export function openCodePluginModuleSource(): string {
  return `const startedAtByCallId = new Map()
const finalizedCallIds = new Set()

export const OwnHarnessPlugin = async () => ({
  event: async ({ event }) => {
    const failure = readToolPartFailure(event)
    if (failure === undefined || finalizedCallIds.has(failure.callID)) return
    rememberFinalizedCall(failure.callID)
    startedAtByCallId.delete(failure.callID)
    await postIngest(
      { tool: failure.tool, sessionID: failure.sessionID, callID: failure.callID },
      failure.args,
      "PostToolUseFailure",
      failure.exitCode,
      failure.durationMs
    )
  },
  "tool.execute.before": async (input, output) => {
    assertCallId(input.callID)
    finalizedCallIds.delete(input.callID)
    await postIngest(input, output.args, "PreToolUse", null, 0)
    startedAtByCallId.set(input.callID, Date.now())
  },
  "tool.execute.after": async (input, output) => {
    assertCallId(input.callID)
    if (finalizedCallIds.delete(input.callID)) return
    const exitCode = nonnegativeInteger(output?.metadata?.exitCode) ?? 0
    const measuredDuration = nonnegativeInteger(output?.metadata?.durationMs)
    const startedAt = startedAtByCallId.get(input.callID)
    const durationMs = measuredDuration ?? (startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt))
    startedAtByCallId.delete(input.callID)
    await postIngest(input, input.args, exitCode === 0 ? "PostToolUse" : "PostToolUseFailure", exitCode, durationMs)
  }
})

function rememberFinalizedCall(callID) {
  if (finalizedCallIds.size >= 2048) {
    const oldestCallID = finalizedCallIds.values().next().value
    if (typeof oldestCallID === "string") finalizedCallIds.delete(oldestCallID)
  }
  finalizedCallIds.add(callID)
}

function readToolPartFailure(event) {
  if (event?.type !== "message.part.updated") return undefined
  const part = event.properties?.part
  if (part?.type !== "tool" || part.state?.status !== "error") return undefined
  assertCallId(part.callID)
  const metadataExitCode = nonnegativeInteger(part.state.metadata?.exitCode)
  return {
    tool: part.tool,
    sessionID: event.properties.sessionID,
    callID: part.callID,
    args: part.state.input,
    exitCode: metadataExitCode !== undefined && metadataExitCode > 0 ? metadataExitCode : 1,
    durationMs: Math.max(0, part.state.time.end - part.state.time.start)
  }
}

async function postIngest(input, args, hookEvent, exitCode, durationMs) {
  const command = readCommand(args)
  if (command.length === 0) return
  const baseUrl = process.env.HARNESS_BASE_URL ?? "http://127.0.0.1:4103"
  const headers = { "content-type": "application/json" }
  const authToken = process.env.HARNESS_AUTH_TOKEN
  if (typeof authToken === "string" && authToken.length > 0) headers.authorization = \`Bearer \${authToken}\`
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl
  const response = await fetch(\`\${normalizedBaseUrl}/api/v1/ingest\`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tool: input.tool,
      command,
      sessionId: process.env.HARNESS_SESSION_ID ?? input.sessionID,
      projectHash: process.env.HARNESS_PROJECT_HASH,
      agent: "opencode",
      exitCode,
      durationMs,
      hookEvent,
      toolUseId: input.callID
    })
  })
  if (!response.ok) throw new Error(\`Harness ingest failed with status \${response.status}\`)
}

function readCommand(args) {
  if (typeof args?.command === "string") return args.command
  if (typeof args?.input === "string") return args.input
  return ""
}

function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function assertCallId(callId) {
  if (typeof callId !== "string" || callId.length === 0) {
    throw new Error("OpenCode tool hook requires callID for lifecycle correlation")
  }
}
`
}
