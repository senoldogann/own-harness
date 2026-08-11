import { createLearningLoop, HarnessStore } from "@own-harness/core"
import { isoDaysAgo } from "@own-harness/core"
import { bootstrap } from "../bootstrap.js"

export function parseDayCount(value: string): number {
  const trimmed = value.trim()
  const match = /^(\d+)(?:d|days?)?$/.exec(trimmed)
  if (match === null) {
    throw new Error(`Invalid --since value: ${value}; expected a day count such as 7d or 7`)
  }
  return Number(match[1])
}

export function runOptimize(cwd: string, sinceDays: number): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const loop = createLearningLoop(store)
    const ids = loop.optimize(isoDaysAgo(sinceDays))
    console.log(JSON.stringify({ proposalIds: ids }, null, 2))
  } finally {
    store.close()
  }
}
