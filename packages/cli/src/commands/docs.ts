import { resolve } from "node:path"
import { existsSync } from "node:fs"

export function showDocs(cwd: string): void {
  const docsPath = resolve(cwd, "docs", "architecture.md")
  if (!existsSync(docsPath)) {
    console.log("Docs directory not initialized")
    return
  }
  console.log(docsPath)
}
