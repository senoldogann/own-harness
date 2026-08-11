import { existsSync } from "node:fs"
import { bootstrap } from "../bootstrap.js"

export function runStatus(cwd: string): void {
  const boot = bootstrap(cwd)
  console.log(JSON.stringify({
    config: boot.config.proxy,
    store: boot.storePath,
    policy: boot.policyPath,
    telemetryFile: boot.telemetryPath,
    storeExists: existsSync(boot.storePath)
  }, null, 2))
}
