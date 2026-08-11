import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const harness = resolveHarnessBinary(process.env.HARNESS_BIN, process.env.VOLTA_HOME)
const version = execFileSync(harness, ["--version"], { encoding: "utf8" }).trim()
const tempDir = mkdtempSync(join(tmpdir(), "own-harness-verify-"))
const args = [harness, "init"]
execFileSync(args[0], args.slice(1), { cwd: tempDir, stdio: "inherit" })
for (const file of [
  "harness.config.yaml",
  ".harness/policies/default.yaml",
  ".harness/hooks/claude-hooks.sh",
  ".harness/hooks/claude-hooks.py"
]) {
  if (!existsSync(join(tempDir, file))) {
    throw new Error(`harness init did not create ${file}`)
  }
}
console.log(`verified harness ${version} install`)

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
