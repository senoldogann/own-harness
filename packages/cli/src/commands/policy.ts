import { randomBytes } from "node:crypto"
import { join, resolve } from "node:path"
import {
  createPolicyBundle,
  parsePolicyConfig,
  readUtf8FileWithinRealRoot,
  requireEncryptedRemoteUrl,
  resolveRealDirectoryRoot,
  verifyPolicyBundle,
  writeUtf8FileAtomicallyWithinRealRoot,
  writeUtf8FileExclusivelyWithinRealRoot,
  type PolicyBundle
} from "@own-harness/core"
import { stringify as stringifyYaml } from "yaml"
import { bootstrap } from "../bootstrap.js"

export function validatePolicy(cwd: string): void {
  bootstrap(cwd)
  console.log("Policy is valid")
}

export async function pullPolicy(
  cwd: string,
  urlOverride: string | undefined,
  tokenOverride: string | undefined
): Promise<void> {
  const boot = bootstrap(cwd)
  const distribution = boot.config.distribution
  const serverUrl = urlOverride ?? distribution?.serverUrl
  if (serverUrl === undefined) {
    throw new Error("Policy distribution server is not configured; set distribution.serverUrl or pass --url")
  }
  requireEncryptedRemoteUrl(serverUrl, "policy distribution server")
  const signatureSecret = boot.distributionSignatureSecret
  if (signatureSecret === undefined) {
    throw new Error(
      "Policy distribution signature secret is not configured; set distribution.signatureSecretEnv"
    )
  }
  const authToken = tokenOverride ?? boot.serverAuthToken
  const headers: Record<string, string> = {
    accept: "application/json"
  }
  if (authToken !== undefined) {
    headers.authorization = `Bearer ${authToken}`
  }
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/v1/policy/bundle`, {
    headers,
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`Policy bundle fetch failed with status ${response.status}: ${detail.slice(0, 200)}`)
  }
  const payload = await response.json() as unknown
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Policy bundle response is not an object")
  }
  const bundle = payload as PolicyBundle
  if (bundle.policy === undefined || typeof bundle.signature !== "string" || typeof bundle.version !== "string") {
    throw new Error("Policy bundle response is missing required fields")
  }
  if (!verifyPolicyBundle(bundle, signatureSecret)) {
    throw new Error("Policy bundle signature verification failed")
  }
  const signedAt = new Date(bundle.signedAt)
  if (Number.isNaN(signedAt.getTime()) || Date.now() - signedAt.getTime() > 10 * 60 * 1000) {
    throw new Error("Policy bundle signature is too old")
  }
  parsePolicyConfig(JSON.stringify(bundle.policy))
  const expectedVersion = createPolicyBundle(bundle.policy, signatureSecret, bundle.signedAt).version
  if (bundle.version !== expectedVersion) {
    throw new Error("Policy bundle version does not match its policy content")
  }

  const workspaceRoot = resolveRealDirectoryRoot(resolve(cwd))
  const policyRelativePath = join(".harness", "policies", "default.yaml")
  const currentPolicy = readUtf8FileWithinRealRoot(workspaceRoot, policyRelativePath)
  if (currentPolicy === null) {
    throw new Error(`Policy file disappeared before replacement: ${boot.policyPath}`)
  }
  const backupRelativePath = join(
    ".harness",
    "policies",
    "backups",
    `${Date.now()}-${randomBytes(8).toString("hex")}-remote.yaml`
  )
  writeUtf8FileExclusivelyWithinRealRoot({
    rootPath: workspaceRoot,
    relativePath: backupRelativePath,
    content: currentPolicy,
    mode: 0o600
  })
  const nextPolicyYaml = stringifyYaml(bundle.policy)
  writeUtf8FileAtomicallyWithinRealRoot({
    rootPath: workspaceRoot,
    relativePath: policyRelativePath,
    content: nextPolicyYaml,
    mode: 0o600
  })
  console.log(`Pulled policy bundle ${bundle.version} from ${serverUrl}`)
}
