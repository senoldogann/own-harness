import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releaseDir = join(root, "dist-release")
const cliPackage = JSON.parse(
  readFileSync(join(root, "packages", "cli", "package.json"), "utf8")
)
if (typeof cliPackage.version !== "string" || cliPackage.version.length === 0) {
  throw new Error("packages/cli/package.json must contain a non-empty version")
}
const artifactNames = [
  `own-harness-cli-${cliPackage.version}.tgz`,
  "cursor-extension.vsix",
  "cursor-extension.zip",
  "vscode-extension.vsix",
  "vscode-extension.zip"
]

const lines = artifactNames.map((artifactName) => {
  const digest = createHash("sha256")
    .update(readFileSync(join(releaseDir, artifactName)))
    .digest("hex")
  return `${digest}  ${artifactName}`
})

writeFileSync(join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8")
console.log(`wrote checksums for ${artifactNames.length} release artifacts`)
