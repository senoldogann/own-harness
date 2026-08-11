import { join } from "node:path"
import {
  ensureDirectoryWithinRealRoot,
  readUtf8FileWithinRealRoot,
  resolveRealDirectoryRoot,
  writeUtf8FileAtomicallyWithinRealRoot
} from "@own-harness/core"

interface CursorHookCommand {
  readonly command: string
  readonly matcher: string
  readonly timeout: number
}

interface CursorHooksDocument {
  readonly document: JsonObject
  readonly hooks: Readonly<Record<string, readonly CursorHookCommand[]>>
}

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject
interface JsonObject {
  readonly [key: string]: JsonValue
}

export interface CursorHookInstallation {
  readonly configPath: string
  readonly scriptPath: string
}

const HOOK_STEPS = ["preToolUse", "postToolUse", "postToolUseFailure"] as const
const HOOK_COMMAND = "node .cursor/own-harness-hook.cjs"

export function installCursorProjectHooks(workspacePath: string): CursorHookInstallation {
  const realWorkspace = resolveRealDirectoryRoot(workspacePath)
  const cursorDirectory = ensureDirectoryWithinRealRoot(realWorkspace, ".cursor", 0o700)
  const configPath = join(cursorDirectory, "hooks.json")
  const scriptPath = join(cursorDirectory, "own-harness-hook.cjs")
  const current = readCursorHooksDocument(realWorkspace, ".cursor/hooks.json")
  writeUtf8FileAtomicallyWithinRealRoot({
    rootPath: realWorkspace,
    relativePath: ".cursor/hooks.json",
    content: JSON.stringify(mergeCursorHooks(current), null, 2) + "\n",
    mode: 0o600
  })
  writeUtf8FileAtomicallyWithinRealRoot({
    rootPath: realWorkspace,
    relativePath: ".cursor/own-harness-hook.cjs",
    content: cursorHookScriptSource(),
    mode: 0o700
  })
  return { configPath, scriptPath }
}

function readCursorHooksDocument(realWorkspace: string, relativePath: string): CursorHooksDocument {
  const path = join(realWorkspace, relativePath)
  const content = readUtf8FileWithinRealRoot(realWorkspace, relativePath)
  if (content === null) {
    return { document: {}, hooks: {} }
  }
  const parsed: unknown = JSON.parse(content)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Cursor hooks config must contain an object: ${path}`)
  }
  const hooks = (parsed as { readonly hooks?: unknown }).hooks
  if (hooks === undefined) {
    return { document: parsed as JsonObject, hooks: {} }
  }
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    throw new Error(`Cursor hooks config has an invalid hooks object: ${path}`)
  }
  const validatedHooks = readHookCommands(hooks, path)
  return { document: parsed as JsonObject, hooks: validatedHooks }
}

function readHookCommands(
  hooks: object,
  path: string
): Readonly<Record<string, readonly CursorHookCommand[]>> {
  const validated: Record<string, readonly CursorHookCommand[]> = {}
  for (const [step, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) {
      throw new Error(`Cursor hook step ${step} must contain an array: ${path}`)
    }
    validated[step] = value.map((entry, index) => readHookCommand(entry, step, index, path))
  }
  return validated
}

function readHookCommand(value: unknown, step: string, index: number, path: string): CursorHookCommand {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Cursor hook ${step}[${index}] must contain an object: ${path}`)
  }
  const command = (value as { readonly command?: unknown }).command
  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`Cursor hook ${step}[${index}] requires command: ${path}`)
  }
  const matcher = (value as { readonly matcher?: unknown }).matcher
  const timeout = (value as { readonly timeout?: unknown }).timeout
  return {
    command,
    matcher: typeof matcher === "string" ? matcher : ".*",
    timeout: typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0 ? timeout : 10
  }
}

function mergeCursorHooks(config: CursorHooksDocument): JsonObject {
  const nextHooks: Record<string, readonly CursorHookCommand[]> = { ...config.hooks }
  for (const step of HOOK_STEPS) {
    const existing = config.hooks[step] ?? []
    const withoutOwnHarness = existing.filter((hook) => hook.command !== HOOK_COMMAND)
    nextHooks[step] = [
      ...withoutOwnHarness,
      { command: HOOK_COMMAND, matcher: ".*", timeout: 10 }
    ]
  }
  return { ...config.document, hooks: serializeHookCommands(nextHooks) }
}

function serializeHookCommands(
  hooks: Readonly<Record<string, readonly CursorHookCommand[]>>
): JsonObject {
  const serialized: Record<string, readonly JsonObject[]> = {}
  for (const [step, commands] of Object.entries(hooks)) {
    serialized[step] = commands.map((hook) => ({
      command: hook.command,
      matcher: hook.matcher,
      timeout: hook.timeout
    }))
  }
  return serialized
}

export function cursorHookScriptSource(): string {
  return `#!/usr/bin/env node
const { createHash } = require("node:crypto")

const chunks = []
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  void main().catch((error) => {
    process.stderr.write(\`own-harness Cursor hook failed: \${String(error)}\\n\`)
    process.exitCode = 1
  })
})

async function main() {
  const input = JSON.parse(chunks.join("") || "{}")
  const event = input.hook_event_name
  const hookEvent = event === "preToolUse"
    ? "PreToolUse"
    : event === "postToolUse" ? "PostToolUse" : "PostToolUseFailure"
  const command = readCommand(input)
  const toolUseId = requireString(input.tool_use_id, "tool_use_id")
  const sessionId = process.env.HARNESS_SESSION_ID ?? requireString(input.conversation_id, "conversation_id")
  const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : process.cwd()
  const projectHash = process.env.HARNESS_PROJECT_HASH ?? createHash("sha256").update(cwd).digest("hex")
  const baseUrl = (process.env.HARNESS_INGEST_URL ?? "http://127.0.0.1:4103").replace(/\\/$/, "")
  const headers = { "content-type": "application/json" }
  const ingestToken = process.env.HARNESS_INGEST_TOKEN ?? process.env.HARNESS_AUTH_TOKEN
  if (typeof ingestToken === "string" && ingestToken.length > 0) {
    headers.authorization = \`Bearer \${ingestToken}\`
  }
  const response = await fetch(\`\${baseUrl}/api/v1/ingest\`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tool: requireString(input.tool_name, "tool_name"),
      command,
      sessionId,
      projectHash,
      agent: "cursor",
      hookEvent,
      toolUseId,
      exitCode: hookEvent === "PreToolUse" ? null : hookEvent === "PostToolUse" ? 0 : 1,
      durationMs: nonnegativeInteger(input.duration_ms)
    })
  })
  if (!response.ok) throw new Error(\`own-harness Cursor hook ingest failed: HTTP \${response.status}\`)
  process.stdout.write("{}")
}

function readCommand(input) {
  const toolInput = input.tool_input
  if (typeof toolInput === "object" && toolInput !== null) {
    if (typeof toolInput.command === "string") return toolInput.command
    if (typeof toolInput.path === "string") return toolInput.path
    if (typeof toolInput.file_path === "string") return toolInput.file_path
  }
  return requireString(input.tool_name, "tool_name")
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new Error(\`Cursor hook requires \${field}\`)
  return value
}

function nonnegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
}
`
}
