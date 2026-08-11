import { randomBytes } from "node:crypto"
import { closeSync, constants, existsSync, fchmodSync, openSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname } from "node:path"
import { ConfigValidationError } from "./errors.js"
import { hmacSha256 } from "./hash.js"
import { preparePrivateDatabasePath, writeUtf8FileAtomicallyWithinRealRoot } from "./safe-files.js"

const TELEMETRY_SCHEMA_VERSION = 1
const TELEMETRY_HASH_PATTERN = /^[a-f0-9]{64}$/
const TELEMETRY_ID_PATTERN = /^[a-f0-9]{24}$/
const MAX_TELEMETRY_PAYLOAD_BYTES = 16 * 1024

type TelemetryFieldKind = "boolean" | "number" | "string"

const TELEMETRY_EVENT_FIELDS: Readonly<Record<string, Readonly<Record<string, TelemetryFieldKind>>>> = {
  proxy_request: {
    agent: "string",
    provider: "string",
    status: "string",
    cacheHit: "boolean",
    tokensIn: "number",
    cacheReadTokensIn: "number",
    tokensOut: "number",
    durationMs: "number",
    pricingStatus: "string"
  },
  tool_call: {
    agent: "string",
    tool: "string",
    status: "string"
  },
  tool_result: {
    agent: "string",
    tool: "string",
    status: "string",
    exitCode: "number",
    durationMs: "number"
  }
}

export interface TelemetryConsent {
  readonly enabled: boolean
  readonly consentedAt: string | null
  readonly secret: string
}

export interface TelemetryRecord {
  readonly id: string
  readonly eventType: string
  readonly payloadJson: string
  readonly createdAt: string
}

export interface TelemetryService {
  readonly status: () => TelemetryConsent
  readonly enable: () => void
  readonly disable: () => void
  readonly record: (eventType: string, payload: TelemetryPayload) => void
  readonly export: () => TelemetryRecord[]
}

export type TelemetryPayload =
  | string
  | number
  | boolean
  | null
  | TelemetryPayload[]
  | { [key: string]: TelemetryPayload }

interface ContentFreeTelemetryEnvelope {
  readonly schemaVersion: 1
  readonly data: Readonly<Record<string, string | number | boolean>>
}

export function createTelemetryService(
  configuredEnabled: boolean,
  consentPath: string,
  recordEvent: (eventType: string, payloadJson: string) => void,
  listEvents: () => TelemetryRecord[]
): TelemetryService {
  return {
    status: () => effectiveConsent(configuredEnabled, readConsent(consentPath)),
    enable: () => {
      if (!configuredEnabled) {
        throw new ConfigValidationError("Telemetry cannot be enabled while telemetry.enabled is false")
      }
      const consent = readConsent(consentPath)
      writeConsent(consentPath, {
        ...consent,
        enabled: true,
        consentedAt: new Date().toISOString()
      })
    },
    disable: () => {
      const consent = readConsent(consentPath)
      writeConsent(consentPath, {
        ...consent,
        enabled: false,
        consentedAt: consent.consentedAt
      })
    },
    record: (eventType, payload) => {
      if (!configuredEnabled) {
        return
      }
      const consent = readConsent(consentPath)
      if (!consent.enabled) {
        return
      }
      recordEvent(eventType, contentFreePayloadJson(eventType, payload, consent.secret))
    },
    export: () => validateTelemetryRecordsForExport(listEvents())
  }
}

export function assertContentFreeTelemetryRecord(record: TelemetryRecord): void {
  if (!TELEMETRY_ID_PATTERN.test(record.id)) {
    throw new ConfigValidationError("Telemetry record id must contain 24 lowercase hexadecimal characters")
  }
  requireEventFields(record.eventType)
  assertIsoTimestamp(record.createdAt)
  parseContentFreePayload(record.eventType, record.payloadJson)
}

export function validateTelemetryRecordsForExport(records: readonly TelemetryRecord[]): TelemetryRecord[] {
  const unsafeRecordIds: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined) {
      continue
    }
    try {
      assertContentFreeTelemetryRecord(record)
    } catch {
      unsafeRecordIds.push(TELEMETRY_ID_PATTERN.test(record.id) ? record.id : `invalid-id-at-index-${index}`)
    }
  }
  if (unsafeRecordIds.length > 0) {
    throw new ConfigValidationError(
      `Telemetry export blocked because records are not content-free: ${unsafeRecordIds.join(", ")}. ` +
      "Remove or migrate these records before exporting"
    )
  }
  return [...records]
}

function effectiveConsent(configuredEnabled: boolean, consent: TelemetryConsent): TelemetryConsent {
  return {
    ...consent,
    enabled: configuredEnabled && consent.enabled
  }
}

function readConsent(consentPath: string): TelemetryConsent {
  const safePath = preparePrivateDatabasePath(consentPath)
  if (!existsSync(safePath)) {
    return {
      enabled: false,
      consentedAt: null,
      secret: randomSecret()
    }
  }
  const descriptor = openSync(safePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    fchmodSync(descriptor, 0o600)
    let parsed: Partial<TelemetryConsent>
    try {
      parsed = JSON.parse(readFileSync(descriptor, "utf8")) as Partial<TelemetryConsent>
    } catch {
      throw new ConfigValidationError("Telemetry consent file is invalid JSON")
    }
    if (
      typeof parsed.enabled !== "boolean" ||
      typeof parsed.secret !== "string" ||
      !TELEMETRY_HASH_PATTERN.test(parsed.secret) ||
      (parsed.consentedAt !== null && parsed.consentedAt !== undefined && !isIsoTimestamp(parsed.consentedAt))
    ) {
      throw new ConfigValidationError("Telemetry consent file is invalid")
    }
    return {
      enabled: parsed.enabled,
      consentedAt: parsed.consentedAt ?? null,
      secret: parsed.secret
    }
  } finally {
    closeSync(descriptor)
  }
}

function writeConsent(consentPath: string, consent: TelemetryConsent): void {
  const safePath = preparePrivateDatabasePath(consentPath)
  const realParent = realpathSync(dirname(safePath))
  writeUtf8FileAtomicallyWithinRealRoot({
    rootPath: realParent,
    relativePath: basename(safePath),
    content: JSON.stringify(consent, null, 2),
    mode: 0o600
  })
}

function contentFreePayloadJson(eventType: string, payload: TelemetryPayload, secret: string): string {
  const fields = requireEventFields(eventType)
  if (!isPlainRecord(payload)) {
    throw new ConfigValidationError(`Telemetry event ${eventType} requires an object payload`)
  }
  requireExactKeys(payload, Object.keys(fields), eventType)
  const data: Record<string, string | number | boolean> = {}
  for (const [field, kind] of Object.entries(fields)) {
    const value = payload[field]
    if (kind === "string" && typeof value === "string") {
      data[field] = hmacSha256(value, secret)
      continue
    }
    if (kind === "number" && typeof value === "number" && Number.isFinite(value)) {
      data[field] = value
      continue
    }
    if (kind === "boolean" && typeof value === "boolean") {
      data[field] = value
      continue
    }
    throw new ConfigValidationError(`Telemetry event ${eventType} has an invalid ${field} field`)
  }
  const envelope: ContentFreeTelemetryEnvelope = { schemaVersion: TELEMETRY_SCHEMA_VERSION, data }
  return JSON.stringify(envelope)
}

function parseContentFreePayload(eventType: string, payloadJson: string): ContentFreeTelemetryEnvelope {
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_TELEMETRY_PAYLOAD_BYTES) {
    throw new ConfigValidationError(`Telemetry payload exceeds ${MAX_TELEMETRY_PAYLOAD_BYTES} bytes`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadJson)
  } catch {
    throw new ConfigValidationError("Telemetry payload must be valid content-free JSON")
  }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ["schemaVersion", "data"]) || parsed.schemaVersion !== 1) {
    throw new ConfigValidationError("Telemetry payload must use content-free schema version 1")
  }
  if (!isPlainRecord(parsed.data)) {
    throw new ConfigValidationError(`Telemetry event ${eventType} requires content-free object data`)
  }
  const fields = requireEventFields(eventType)
  requireExactKeys(parsed.data, Object.keys(fields), eventType)
  for (const [field, kind] of Object.entries(fields)) {
    const value = parsed.data[field]
    const valid = kind === "string"
      ? typeof value === "string" && TELEMETRY_HASH_PATTERN.test(value)
      : kind === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === "boolean"
    if (!valid) {
      throw new ConfigValidationError(`Telemetry event ${eventType} has an invalid content-free ${field} field`)
    }
  }
  return parsed as unknown as ContentFreeTelemetryEnvelope
}

function requireEventFields(eventType: string): Readonly<Record<string, TelemetryFieldKind>> {
  const fields = TELEMETRY_EVENT_FIELDS[eventType]
  if (fields === undefined) {
    throw new ConfigValidationError("Unsupported telemetry event type")
  }
  return fields
}

function assertIsoTimestamp(value: string): void {
  if (!isIsoTimestamp(value)) {
    throw new ConfigValidationError("Telemetry record createdAt must be an ISO-8601 timestamp")
  }
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function requireExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], eventType: string): void {
  if (!hasExactKeys(value, expectedKeys)) {
    throw new ConfigValidationError(`Telemetry event ${eventType} contains missing or unsupported fields`)
  }
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function randomSecret(): string {
  return randomBytes(32).toString("hex")
}
