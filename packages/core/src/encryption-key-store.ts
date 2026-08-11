import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  writeFileSync
} from "node:fs"
import { StoreError } from "./errors.js"

const KEY_BYTES = 32
const KEYCHAIN_NOT_FOUND_STATUS = 44
const KEYCHAIN_TIMEOUT_MS = 30_000
const KEYCHAIN_MAX_BUFFER_BYTES = 64 * 1024
const DEFAULT_KEYCHAIN_SERVICE = "dev.own-harness.encryption"
const DEFAULT_KEYCHAIN_ACCOUNT = "store-master-v1"

export interface EncryptionKeyStore {
  loadOrCreate(): Buffer
}

interface KeychainCommandResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export class MacOsKeychainEncryptionKeyStore implements EncryptionKeyStore {
  private readonly service: string
  private readonly account: string

  public constructor(service: string, account: string) {
    this.service = service
    this.account = account
  }

  public loadOrCreate(): Buffer {
    const existing = this.find()
    if (existing !== null) {
      return decodeEncryptionKey(existing, "macOS Keychain")
    }

    const generated = randomBytes(KEY_BYTES).toString("base64")
    const created = runSecurityCommand(
      ["add-generic-password", "-a", this.account, "-s", this.service, "-w"],
      `${generated}\n${generated}\n`
    )
    if (created.status !== 0) {
      const concurrent = this.find()
      if (concurrent !== null) {
        return decodeEncryptionKey(concurrent, "macOS Keychain")
      }
      throw keychainCommandError("create", created)
    }

    const stored = this.find()
    if (stored === null) {
      throw new StoreError("macOS Keychain reported success but the encryption key cannot be read")
    }
    return decodeEncryptionKey(stored, "macOS Keychain")
  }

  private find(): string | null {
    const result = runSecurityCommand(
      ["find-generic-password", "-a", this.account, "-s", this.service, "-w"],
      null
    )
    if (result.status === 0) {
      return result.stdout.trim()
    }
    if (result.status === KEYCHAIN_NOT_FOUND_STATUS) {
      return null
    }
    throw keychainCommandError("read", result)
  }
}

export class FileEncryptionKeyStore implements EncryptionKeyStore {
  private readonly keyPath: string

  public constructor(keyPath: string) {
    this.keyPath = keyPath
  }

  public loadOrCreate(): Buffer {
    if (!existsSync(this.keyPath)) {
      try {
        writeFileSync(this.keyPath, `${randomBytes(KEY_BYTES).toString("base64")}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600
        })
      } catch (error) {
        if (!isNodeErrorWithCode(error, "EEXIST")) {
          throw error
        }
      }
    }
    return readEncryptionKeyFile(this.keyPath)
  }
}

export function createPlatformEncryptionKeyStore(
  platform: NodeJS.Platform,
  keyPath: string
): EncryptionKeyStore {
  if (platform === "darwin") {
    return new MacOsKeychainEncryptionKeyStore(DEFAULT_KEYCHAIN_SERVICE, DEFAULT_KEYCHAIN_ACCOUNT)
  }
  return new FileEncryptionKeyStore(keyPath)
}

export function readLegacyEncryptionKey(keyPath: string): Buffer | null {
  if (!existsSync(keyPath)) {
    return null
  }
  return readEncryptionKeyFile(keyPath)
}

function readEncryptionKeyFile(keyPath: string): Buffer {
  let descriptor: number | null = null
  try {
    descriptor = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    fchmodSync(descriptor, 0o600)
    return decodeEncryptionKey(readFileSync(descriptor, "utf8").trim(), keyPath)
  } catch (error) {
    if (isNodeErrorWithCode(error, "ELOOP")) {
      throw new StoreError(`Encryption key path must not be a symbolic link: ${keyPath}`)
    }
    throw error
  } finally {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
  }
}

function decodeEncryptionKey(encoded: string, source: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new StoreError(`Encryption key from ${source} is not canonical Base64 for ${KEY_BYTES} bytes`)
  }
  const key = Buffer.from(encoded, "base64")
  if (key.length !== KEY_BYTES) {
    throw new StoreError(`Encryption key from ${source} must decode to ${KEY_BYTES} bytes`)
  }
  return key
}

function runSecurityCommand(args: readonly string[], input: string | null): KeychainCommandResult {
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    input: input ?? undefined,
    maxBuffer: KEYCHAIN_MAX_BUFFER_BYTES,
    timeout: KEYCHAIN_TIMEOUT_MS
  })
  if (result.error !== undefined) {
    throw new StoreError(`macOS Keychain command could not run: ${result.error.message}`)
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

function keychainCommandError(operation: string, result: KeychainCommandResult): StoreError {
  const detail = result.stderr.trim() || "no diagnostic output"
  const termination = result.signal === null ? `status ${String(result.status)}` : `signal ${result.signal}`
  return new StoreError(`macOS Keychain ${operation} failed with ${termination}: ${detail}`)
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
