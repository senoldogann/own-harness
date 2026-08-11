import { createHash, randomUUID } from "node:crypto"
import * as vscode from "vscode"
import { createVscodeExtension, type HarnessExtensionApi } from "@own-harness/desktop"

export function activate(context: vscode.ExtensionContext): HarnessExtensionApi {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const projectHash = process.env.HARNESS_PROJECT_HASH ?? hashWorkspacePath(workspacePath)
  const extension = createVscodeExtension(
    vscode,
    {
      ingestUrl: process.env.HARNESS_INGEST_URL ?? "http://127.0.0.1:4103",
      sessionId: process.env.HARNESS_SESSION_ID ?? randomUUID(),
      projectHash
    }
  )
  context.subscriptions.push(extension.activate())
  return extension.api
}

export function deactivate(): void {}

function hashWorkspacePath(workspacePath: string | undefined): string {
  return createHash("sha256").update(workspacePath ?? "no-workspace").digest("hex")
}
