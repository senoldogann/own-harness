export type StructuredLogFields = Readonly<Record<string, string | number | boolean>>

export function logError(fields: StructuredLogFields): void {
  console.error(JSON.stringify(fields))
}

export function logWarn(fields: StructuredLogFields): void {
  console.warn(JSON.stringify(fields))
}
