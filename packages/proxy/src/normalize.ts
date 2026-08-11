import type { AgentKind, ProviderKind } from "@own-harness/contracts"
import type { ProviderRequestBody } from "@own-harness/core"

export function detectProvider(path: string): ProviderKind {
  if (path.includes("/messages")) {
    return "anthropic"
  }
  if (path.includes("/responses")) {
    return "openai"
  }
  return "openai-compatible"
}

export function detectAgentFromHeaders(headers: Record<string, string | undefined>): AgentKind {
  const userAgent = headers["user-agent"] ?? ""
  if (userAgent.includes("claude")) {
    return "claude"
  }
  if (userAgent.includes("codex")) {
    return "codex"
  }
  if (userAgent.includes("opencode")) {
    return "opencode"
  }
  return "vscode"
}

export function extractModelFromBody(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return ""
  }
  const record = body as ProviderRequestBody
  return typeof record.model === "string" ? record.model : ""
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
}

export function redactSecretsWithPatterns(value: string, patterns: readonly string[]): string {
  let result = redactSecrets(value)
  for (const pattern of patterns) {
    result = result.replace(new RegExp(pattern, "g"), "[REDACTED]")
  }
  return result
}

export function compressText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, maxChars)}... [truncated by own-harness]`
}
