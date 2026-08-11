import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const harness = resolveHarnessBinary(process.env.HARNESS_BIN, process.env.VOLTA_HOME)
const version = execFileSync(harness, ["--version"], { encoding: "utf8" }).trim()
const tempDir = mkdtempSync(join(tmpdir(), "own-harness-verify-"))
const args = [harness, "init"]
execFileSync(args[0], args.slice(1), { cwd: tempDir, stdio: "inherit" })
const expectedModes = {
  "harness.config.yaml": 0o600,
  ".harness/policies/default.yaml": 0o600,
  ".harness/hooks/claude-hooks.sh": 0o755,
  ".harness/hooks/claude-hooks.py": 0o600
}
for (const file of Object.keys(expectedModes)) {
  if (!existsSync(join(tempDir, file))) {
    throw new Error(`harness init did not create ${file}`)
  }
  const actualMode = statSync(join(tempDir, file)).mode & 0o777
  if (actualMode !== expectedModes[file]) {
    throw new Error(`harness init created ${file} with mode ${actualMode.toString(8)}, expected ${expectedModes[file].toString(8)}`)
  }
}
verifyReleaseChecksumsIfPresent()
console.log(`verified harness ${version} install`)

function verifyReleaseChecksumsIfPresent() {
  const releaseDir = join(process.cwd(), "dist-release")
  const checksumsPath = join(releaseDir, "SHA256SUMS")
  if (!existsSync(checksumsPath)) {
    return
  }
  const lines = readFileSync(checksumsPath, "utf8").trim().split("\n")
  for (const line of lines) {
    const [expectedDigest, artifactName] = line.split(/\s+/)
    if (expectedDigest === undefined || artifactName === undefined) {
      throw new Error(`Malformed SHA256SUMS line: ${line}`)
    }
    const artifactPath = join(releaseDir, artifactName)
    if (!existsSync(artifactPath)) {
      throw new Error(`Release checksum references missing artifact: ${artifactName}`)
    }
    const actualDigest = createHash("sha256")
      .update(readFileSync(artifactPath))
      .digest("hex")
    if (actualDigest !== expectedDigest) {
      throw new Error(`Release checksum mismatch for ${artifactName}`)
    }
  }
  console.log(`verified ${lines.length} release artifact checksums`)
}

function resolveHarnessBinary(configuredBinary, voltaHome) {
  if (configuredBinary !== undefined) {
    return configuredBinary
  }
  if (voltaHome !== undefined) {
    const voltaBinary = join(voltaHome, "bin", "harness")
    if (existsSync(voltaBinary)) {
      return voltaBinary
    }
  }
  return "harness"
}
