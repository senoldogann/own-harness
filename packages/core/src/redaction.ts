export function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/ASIA[0-9A-Z]{16}/g, "[REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{36,}/g, "[REDACTED]")
    .replace(/gh[ous]_[A-Za-z0-9]{36,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]")
    .replace(/hf_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/Bearer [A-Za-z0-9._~+/=-]{20,}/gi, "Bearer [REDACTED]")
}

export function redactSecretsWithPatterns(value: string, patterns: readonly string[]): string {
  let result = redactSecrets(value)
  for (const pattern of patterns) {
    result = result.replace(new RegExp(pattern, "g"), "[REDACTED]")
  }
  return result
}

export function sanitizeCommandForStorage(value: string): string {
  return redactSecrets(value)
}
