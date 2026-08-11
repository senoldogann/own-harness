import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { StoreError } from "../errors.js"

export const CACHE_ENCRYPTION_PREFIX = "ohc1:"
export const TOOL_COMMAND_ENCRYPTION_PREFIX = "oht1:"

export interface CacheAadFields {
  readonly keyHash: string
  readonly provider: string
  readonly model: string
}

export interface ToolCommandAadFields {
  readonly id: string
  readonly sessionId: string
  readonly tool: string
}

export function cacheAad(fields: CacheAadFields): Buffer {
  return Buffer.from(`${fields.keyHash}\u0000${fields.provider}\u0000${fields.model}`, "utf8")
}

export function toolCommandAad(fields: ToolCommandAadFields): Buffer {
  return Buffer.from(`${fields.id}\u0000${fields.sessionId}\u0000${fields.tool}`, "utf8")
}

export function isEncryptedToolCommand(value: string): boolean {
  return value.startsWith(TOOL_COMMAND_ENCRYPTION_PREFIX)
}

export function isEncryptedCacheValue(value: string): boolean {
  return value.startsWith(CACHE_ENCRYPTION_PREFIX)
}

export function encryptToolCommand(key: Buffer, plaintext: string, aad: Buffer): string {
  return encryptAesGcmValue(key, plaintext, aad, TOOL_COMMAND_ENCRYPTION_PREFIX)
}

export function decryptToolCommand(key: Buffer, encrypted: string, aad: Buffer): string {
  return decryptAesGcmValue(key, encrypted, aad, TOOL_COMMAND_ENCRYPTION_PREFIX, "Tool command")
}

export function encryptCacheValue(key: Buffer, plaintext: string, aad: Buffer): string {
  return encryptAesGcmValue(key, plaintext, aad, CACHE_ENCRYPTION_PREFIX)
}

export function decryptCacheValue(key: Buffer, encrypted: string, aad: Buffer): string {
  return decryptAesGcmValue(key, encrypted, aad, CACHE_ENCRYPTION_PREFIX, "Cache entry")
}

export interface DecryptedLegacyValue {
  readonly plaintext: string
  readonly requiresReEncryption: boolean
}

export function decryptWithFallback(options: {
  readonly decrypt: (key: Buffer, encrypted: string, aad: Buffer) => string
  readonly currentKey: Buffer
  readonly legacyKey: Buffer | null
  readonly encrypted: string
  readonly aad: Buffer
}): DecryptedLegacyValue {
  try {
    return {
      plaintext: options.decrypt(options.currentKey, options.encrypted, options.aad),
      requiresReEncryption: false
    }
  } catch (currentError) {
    if (options.legacyKey === null) {
      throw currentError
    }
    return {
      plaintext: options.decrypt(options.legacyKey, options.encrypted, options.aad),
      requiresReEncryption: true
    }
  }
}

function encryptAesGcmValue(key: Buffer, plaintext: string, aad: Buffer, prefix: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${prefix}${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`
}

function decryptAesGcmValue(
  key: Buffer,
  encrypted: string,
  aad: Buffer,
  prefix: string,
  subject: string
): string {
  if (!encrypted.startsWith(prefix)) {
    throw new StoreError(`${subject} is not encrypted`)
  }
  const payload = Buffer.from(encrypted.slice(prefix.length), "base64")
  if (payload.length < 29) {
    throw new StoreError(`${subject} encryption payload is malformed`)
  }
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new StoreError(`${subject} decryption failed: ${detail}`)
  }
}
