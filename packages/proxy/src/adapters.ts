import type { AgentKind, ProviderKind } from "@own-harness/contracts"
import { spawn, type ChildProcess } from "node:child_process"
import {
  resolveRealDirectoryRoot,
  rewriteCommandWithRtk,
  writeUtf8FileAtomicallyWithinRealRoot
} from "@own-harness/core"
import { openCodePluginModuleSource } from "@own-harness/desktop"

export interface AgentAdapter {
  readonly kind: AgentKind
  readonly provider: ProviderKind
  readonly rewriteToolCommand: (command: string) => Promise<{
    readonly rewritten: string
    readonly usedRtk: boolean
  }>
  readonly buildLaunchCommand: (options: {
    readonly args: readonly string[]
    readonly cwd: string
  }) => string
  readonly launch: (options: {
    readonly args: readonly string[]
    readonly cwd: string
    readonly sessionId: string
    readonly projectHash: string
  }) => ChildProcess
}

export function createClaudeAdapter(baseUrl: string): AgentAdapter {
  const hookCommand = (cwd: string) =>
    `bash ${quotePosixShellArgument(`${cwd}/.harness/hooks/claude-hooks.sh`)}`
  const settingsJson = (cwd: string) => JSON.stringify({
    env: claudeSettingsEnv(baseUrl),
    hooks: {
      SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(cwd) }] }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(cwd) }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(cwd) }] }],
      PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand(cwd) }] }]
    }
  })
  return {
    kind: "claude",
    provider: "anthropic",
    rewriteToolCommand: (command) => rewriteCommandWithRtk(command),
    buildLaunchCommand: ({ args, cwd }) =>
      [
        "ANTHROPIC_BASE_URL=" + baseUrl,
        "claude",
        ...args,
        "--settings",
        settingsJson(cwd)
      ].join(" "),
    launch: ({ args, cwd, sessionId, projectHash }) => {
      return spawn("claude", [...args, "--settings", settingsJson(cwd)], {
        cwd,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: baseUrl,
          HARNESS_SESSION_ID: sessionId,
          HARNESS_AGENT: "claude",
          HARNESS_PROJECT_HASH: projectHash,
          HARNESS_INGEST_URL: baseUrl
        },
        stdio: "inherit"
      })
    }
  }
}

function quotePosixShellArgument(value: string): string {
  if (value.includes("\0")) {
    throw new Error("Claude hook path must not contain a NUL character")
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

interface ClaudeSettingsEnv {
  readonly ANTHROPIC_BASE_URL: string
  readonly ANTHROPIC_AUTH_TOKEN?: string
  readonly ANTHROPIC_MODEL?: string
  readonly ANTHROPIC_DEFAULT_OPUS_MODEL?: string
  readonly ANTHROPIC_DEFAULT_SONNET_MODEL?: string
  readonly ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
  readonly CLAUDE_CODE_SUBAGENT_MODEL?: string
  readonly CLAUDE_CODE_EFFORT_LEVEL?: string
}

const CLAUDE_SETTINGS_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL"
] as const

function claudeSettingsEnv(baseUrl: string): ClaudeSettingsEnv {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ...pickEnvValues(CLAUDE_SETTINGS_ENV_KEYS)
  }
}

function pickEnvValues<T extends string>(keys: readonly T[]): Partial<Record<T, string>> {
  const picked: Partial<Record<T, string>> = {}
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined) {
      picked[key] = value
    }
  }
  return picked
}

export function createCodexAdapter(baseUrl: string): AgentAdapter {
  const providerId = "openai-custom"
  const providerOverrides = [
    "-c",
    "model_provider=" + providerId,
    "-c",
    `model_providers.${providerId}.name=${providerId}`,
    "-c",
    `model_providers.${providerId}.base_url=${baseUrl.replace(/\/$/, "")}/v1`,
    "-c",
    `model_providers.${providerId}.supports_websockets=false`,
    "-c",
    `model_providers.${providerId}.wire_api=responses`,
    "-c",
    `model_providers.${providerId}.requires_openai_auth=false`
  ]
  return {
    kind: "codex",
    provider: "openai",
    rewriteToolCommand: (command) => rewriteCommandWithRtk(command),
    buildLaunchCommand: ({ args, cwd }) =>
      [
        "CODEX_HOME=" + cwd + "/.harness/codex",
        "codex",
        ...providerOverrides,
        ...(hasModelArg(args) ? [] : ["-m", "gpt-5.6-sol"]),
        "-C",
        cwd,
        ...args
      ].join(" "),
    launch: ({ args, cwd, sessionId, projectHash }) =>
      spawn("codex", [...providerOverrides, ...(hasModelArg(args) ? [] : ["-m", "gpt-5.6-sol"]), "-C", cwd, ...args], {
        cwd,
        env: {
          ...process.env,
          CODEX_HOME: `${cwd}/.harness/codex`,
          HARNESS_SESSION_ID: sessionId,
          HARNESS_AGENT: "codex",
          HARNESS_PROJECT_HASH: projectHash,
          HARNESS_INGEST_URL: baseUrl
        },
        stdio: "inherit"
      })
  }
}

function hasModelArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === "-m" || arg === "--model")
}

export function createOpenCodeAdapter(baseUrl: string): AgentAdapter {
  return {
    kind: "opencode",
    provider: "openai-compatible",
    rewriteToolCommand: (command) => rewriteCommandWithRtk(command),
    buildLaunchCommand: ({ args, cwd }) =>
      [
        "OPENCODE_CONFIG=" + openCodeConfigPath(cwd),
        "opencode",
        ...args
      ].join(" "),
    launch: ({ args, cwd, sessionId, projectHash }) => {
      const modelId = requireOpenCodeModel(args)
      writeOpenCodeConfig(cwd, baseUrl, modelId)
      return spawn("opencode", [...args], {
        cwd,
        env: {
          ...process.env,
          HARNESS_BASE_URL: baseUrl,
          OPENCODE_CONFIG: openCodeConfigPath(cwd),
          HARNESS_SESSION_ID: sessionId,
          HARNESS_AGENT: "opencode",
          HARNESS_PROJECT_HASH: projectHash
        },
        stdio: "inherit"
      })
    }
  }
}

function requireOpenCodeModel(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "-m" || arg === "--model") {
      const value = args[index + 1]
      if (value !== undefined) {
        return modelIdFromValue(value)
      }
    }
    if (arg !== undefined && arg.startsWith("--model=")) {
      return modelIdFromValue(arg.slice("--model=".length))
    }
  }
  throw new Error("OpenCode requires --model own-harness/<model>")
}

function modelIdFromValue(value: string): string {
  const providerPrefix = "own-harness/"
  const modelId = value.startsWith(providerPrefix) ? value.slice(providerPrefix.length) : value
  if (modelId.length === 0) {
    throw new Error(`OpenCode model is empty: ${value}`)
  }
  return modelId
}

function writeOpenCodeConfig(cwd: string, baseUrl: string, modelId: string): void {
  const config = {
    provider: {
      "own-harness": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${baseUrl.replace(/\/$/, "")}/v1`,
          apiKey: "harness-local"
        },
        models: {
          [modelId]: { name: modelId }
        }
      }
    }
  }
  const realWorkspace = resolveRealDirectoryRoot(cwd)
  writeUtf8FileAtomicallyWithinRealRoot({
    rootPath: realWorkspace,
    relativePath: ".harness/opencode.json",
    content: JSON.stringify(config, null, 2),
    mode: 0o600
  })
  writeUtf8FileAtomicallyWithinRealRoot({
    rootPath: realWorkspace,
    relativePath: ".opencode/plugins/own-harness.mjs",
    content: openCodePluginModuleSource(),
    mode: 0o600
  })
}

function openCodeConfigPath(cwd: string): string {
  return `${cwd}/.harness/opencode.json`
}

export function createAdapter(kind: AgentKind, baseUrl: string): AgentAdapter {
  if (kind === "claude") {
    return createClaudeAdapter(baseUrl)
  }
  if (kind === "codex") {
    return createCodexAdapter(baseUrl)
  }
  if (kind === "opencode") {
    return createOpenCodeAdapter(baseUrl)
  }
  throw new Error(`Unsupported adapter kind: ${kind}`)
}
