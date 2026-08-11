import { execa } from "execa"
import { OwnHarnessError } from "./errors.js"
import { sha256 } from "./hash.js"

export async function rewriteCommandWithRtk(command: string): Promise<{
  readonly rewritten: string
  readonly usedRtk: boolean
}> {
  try {
    const result = await execa("rtk", ["rewrite", command], { timeout: 5000, reject: false })
    const rewritten = result.stdout.trim()
    if (result.failed && rewritten.length === 0) {
      throw new OwnHarnessError("RTK_REWRITE_FAILED", `rtk rewrite failed for command hash ${sha256(command)}`)
    }
    if (rewritten.length === 0 || rewritten === command) {
      return { rewritten: command, usedRtk: false }
    }
    return { rewritten, usedRtk: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new OwnHarnessError("RTK_REWRITE_FAILED", `rtk rewrite failed for command hash ${sha256(command)}; ${message}`)
  }
}
