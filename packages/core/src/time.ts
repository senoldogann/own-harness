export function isoNow(): string {
  return new Date().toISOString()
}

export function isoDaysAgo(days: number): string {
  if (!Number.isFinite(days)) {
    throw new Error(`Invalid days value: ${days}`)
  }
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

export function isoFromMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}
