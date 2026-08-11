import type { AgentKind } from "@own-harness/contracts"

export interface HarnessToolEvent {
  readonly tool: string
  readonly command: string
  readonly durationMs?: number
  readonly exitCode?: number | null
  readonly hookEvent?: "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  readonly toolUseId?: string
}

export interface ExtensionApiLike {
  readonly commands: {
    readonly registerCommand: (
      command: string,
      listener: (...args: unknown[]) => unknown
    ) => { readonly dispose: () => void }
  }
}

export interface HarnessExtensionOptions {
  readonly agent: "vscode" | "cursor"
  readonly ingestUrl: string
  readonly sessionId: string
  readonly projectHash: string
}

export interface HarnessExtension {
  readonly activate: () => { readonly dispose: () => void }
  readonly reportTool: (event: HarnessToolEvent) => Promise<Response>
  readonly api: HarnessExtensionApi
}

export interface HarnessExtensionCapabilities {
  readonly globalToolObservation: false
  readonly typedLifecycleApi: true
  readonly cursorProjectHooks: boolean
}

export interface HarnessExtensionApi {
  readonly apiVersion: 1
  readonly agent: HarnessAgentKind
  readonly capabilities: HarnessExtensionCapabilities
  readonly reportTool: (event: HarnessToolEvent) => Promise<void>
}

export function createHarnessExtension(
  api: ExtensionApiLike,
  options: HarnessExtensionOptions
): HarnessExtension {
  const reportTool = async (event: HarnessToolEvent): Promise<Response> => {
    const headers: Record<string, string> = { "content-type": "application/json" }
    const authToken = process.env.HARNESS_INGEST_TOKEN ?? process.env.HARNESS_AUTH_TOKEN
    if (authToken !== undefined && authToken.length > 0) {
      headers.authorization = `Bearer ${authToken}`
    }
    const response = await fetch(`${options.ingestUrl.replace(/\/$/, "")}/api/v1/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tool: event.tool,
        command: event.command,
        sessionId: options.sessionId,
        agent: options.agent,
        projectHash: options.projectHash,
        exitCode: event.exitCode ?? null,
        durationMs: event.durationMs ?? 0,
        ...(event.hookEvent === undefined ? {} : { hookEvent: event.hookEvent }),
        ...(event.toolUseId === undefined ? {} : { toolUseId: event.toolUseId })
      })
    })
    if (!response.ok) {
      throw new Error(`own-harness ingest failed for ${options.agent}: HTTP ${response.status}`)
    }
    return response
  }

  const activate = (): { readonly dispose: () => void } => {
    const reportRegistration = api.commands.registerCommand("own-harness.reportTool", async (event: unknown) => {
      const parsed = parseToolEvent(event)
      await reportTool(parsed)
    })
    const statusRegistration = api.commands.registerCommand("own-harness.interceptionStatus", () => ({
      apiVersion: 1,
      agent: options.agent,
      capabilities
    }))
    return {
      dispose: () => {
        reportRegistration.dispose()
        statusRegistration.dispose()
      }
    }
  }

  const capabilities: HarnessExtensionCapabilities = {
    globalToolObservation: false,
    typedLifecycleApi: true,
    cursorProjectHooks: options.agent === "cursor"
  }
  const extensionApi: HarnessExtensionApi = {
    apiVersion: 1,
    agent: options.agent,
    capabilities,
    reportTool: async (event) => {
      await reportTool(event)
    }
  }

  return {
    activate,
    reportTool,
    api: extensionApi
  }
}

function parseToolEvent(value: unknown): HarnessToolEvent {
  if (typeof value !== "object" || value === null) {
    throw new Error("own-harness.reportTool requires a tool event object")
  }
  const record = value as Record<string, unknown>
  if (typeof record.tool !== "string" || typeof record.command !== "string") {
    throw new Error("own-harness.reportTool requires tool and command")
  }
  return {
    tool: record.tool,
    command: record.command,
    ...(typeof record.durationMs === "number"
      ? { durationMs: record.durationMs }
      : {}),
    ...(record.exitCode === null || typeof record.exitCode === "number"
      ? { exitCode: record.exitCode as number | null }
      : {}),
    ...(isHookEvent(record.hookEvent) ? { hookEvent: record.hookEvent } : {}),
    ...(typeof record.toolUseId === "string" ? { toolUseId: record.toolUseId } : {})
  }
}

function isHookEvent(value: unknown): value is "PreToolUse" | "PostToolUse" | "PostToolUseFailure" {
  return value === "PreToolUse" || value === "PostToolUse" || value === "PostToolUseFailure"
}

export type HarnessAgentKind = Extract<AgentKind, "vscode" | "cursor">
