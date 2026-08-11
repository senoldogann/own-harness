import { assertContentFreeTelemetryRecord, createTelemetryService, HarnessStore } from "@own-harness/core"
import { TelemetryEventSchema } from "@own-harness/contracts"
import { bootstrap } from "../bootstrap.js"
import { readTextFile } from "../fs-utils.js"

export function telemetryStatus(cwd: string): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const service = createTelemetryService(
      boot.config.telemetry.enabled,
      boot.telemetryPath,
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    const { secret: _secret, ...publicStatus } = service.status()
    console.log(JSON.stringify(publicStatus, null, 2))
  } finally {
    store.close()
  }
}

export function telemetryEnable(cwd: string): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const service = createTelemetryService(
      boot.config.telemetry.enabled,
      boot.telemetryPath,
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    service.enable()
    console.log("Telemetry enabled")
  } finally {
    store.close()
  }
}

export function telemetryDisable(cwd: string): void {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const service = createTelemetryService(
      boot.config.telemetry.enabled,
      boot.telemetryPath,
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    service.disable()
    console.log("Telemetry disabled")
  } finally {
    store.close()
  }
}

export function importTelemetry(cwd: string, filePath: string): void {
  const records = parseTelemetryFile(filePath)
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    let imported = 0
    let skipped = 0
    for (const record of records) {
      if (store.importTelemetryEvent(record)) {
        imported += 1
      } else {
        skipped += 1
      }
    }
    console.log(JSON.stringify({ imported, skipped }, null, 2))
  } finally {
    store.close()
  }
}

function parseTelemetryFile(filePath: string): Array<{
  readonly id: string
  readonly eventType: string
  readonly payloadJson: string
  readonly createdAt: string
}> {
  const source = readTextFile(filePath)
  const parsed = JSON.parse(source) as unknown
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.map((item) => {
    const record = TelemetryEventSchema.parse(item)
    assertContentFreeTelemetryRecord(record)
    return record
  })
}
