import { createStatsEngine, HarnessStore } from "@own-harness/core"
import { bootstrap } from "../bootstrap.js"

export function runStats(cwd: string): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const engine = createStatsEngine(store)
    console.log(JSON.stringify(engine.summary(), null, 2))
    console.log(JSON.stringify(engine.toolStats(), null, 2))
    console.log(JSON.stringify(engine.costStats(), null, 2))
  } finally {
    store.close()
  }
}
