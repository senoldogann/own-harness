import { createHash, createHmac, randomBytes } from "node:crypto"

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function hmacSha256(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex")
}

export function randomId(): string {
  return randomBytes(12).toString("hex")
}
