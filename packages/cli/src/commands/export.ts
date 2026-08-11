import { createTelemetryService, HarnessStore } from "@own-harness/core"
import { bootstrap } from "../bootstrap.js"
import { writeTextFile } from "../fs-utils.js"

export function exportTelemetry(cwd: string): void {
  console.log(JSON.stringify(telemetryRecords(cwd), null, 2))
}

export function exportTelemetryToFile(cwd: string, filePath: string): void {
  writeTextFile(filePath, JSON.stringify(telemetryRecords(cwd), null, 2))
  console.log(`Exported telemetry to ${filePath}`)
}

export function exportAudit(cwd: string): void {
  console.log(JSON.stringify(auditRecords(cwd), null, 2))
}

export function exportAuditToFile(cwd: string, filePath: string): void {
  writeTextFile(filePath, JSON.stringify(auditRecords(cwd), null, 2))
  console.log(`Exported audit to ${filePath}`)
}

function auditRecords(cwd: string): Array<{
  readonly id: string
  readonly requestId: string
  readonly ruleId: string
  readonly action: string
  readonly mode: string
  readonly reason: string
  readonly createdAt: string
}> {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    return store.listPolicyDecisions()
  } finally {
    store.close()
  }
}

function telemetryRecords(cwd: string): Array<{
  readonly id: string
  readonly eventType: string
  readonly payloadJson: string
  readonly createdAt: string
}> {
  const boot = bootstrap(cwd)
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    const service = createTelemetryService(
      boot.config.telemetry.enabled,
      boot.telemetryPath,
      (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
      () => store.listTelemetryEvents()
    )
    return service.export()
  } finally {
    store.close()
  }
}
