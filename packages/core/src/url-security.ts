export function requireEncryptedRemoteUrl(value: string, context: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`Invalid ${context} URL: ${value}`)
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`${context} URL must not contain user information`)
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`${context} URL must not contain query parameters or fragments`)
  }
  if (parsed.protocol === "https:") {
    return parsed
  }
  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return parsed
  }
  throw new Error(`${context} URL must use HTTPS unless it targets loopback: ${value}`)
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}
