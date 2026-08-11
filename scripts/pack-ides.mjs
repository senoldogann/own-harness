import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ZipFile } from "yazl"
import { createWriteStream } from "node:fs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releaseDir = join(root, "dist-release")
mkdirSync(releaseDir, { recursive: true })

const targets = ["vscode", "cursor"]

for (const target of targets) {
  const sourceDir = join(root, "packages", "desktop", "extensions", target)
  const entry = join(sourceDir, "src", "extension.ts")
  const packageJson = join(sourceDir, "package.json")
  const buildDir = mkdtempSync(join(tmpdir(), `own-harness-${target}-`))
  const bundled = join(buildDir, "extension.js")

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: bundled,
    sourcemap: false,
    alias: {
      "@own-harness/desktop": join(root, "packages", "desktop", "src", "extension-bundle.ts")
    },
    external: ["vscode"]
  })

  const bundleDir = join(releaseDir, `${target}-extension`)
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(join(bundleDir, "dist"), { recursive: true })
  writeFileSync(join(bundleDir, "package.json"), readFileSync(packageJson, "utf8"))
  writeFileSync(join(bundleDir, "LICENSE"), readFileSync(join(root, "LICENSE"), "utf8"))
  writeFileSync(join(bundleDir, "dist", "extension.js"), readFileSync(bundled, "utf8"))

  const zipPath = join(releaseDir, `${target}-extension.zip`)
  rmSync(zipPath, { force: true })
  await createZip(bundleDir, zipPath)
  const vsixPath = join(releaseDir, `${target}-extension.vsix`)
  rmSync(vsixPath, { force: true })
  execFileSync(process.execPath, [
    join(root, "node_modules", "@vscode", "vsce", "vsce"),
    "package",
    "--no-dependencies",
    "--allow-missing-repository",
    "--out",
    vsixPath
  ], { cwd: bundleDir, stdio: "inherit" })
  rmSync(buildDir, { recursive: true, force: true })
  console.log(`packed ${target} extension: ${zipPath}, ${vsixPath}`)
}

function createZip(sourceDir, zipPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const zip = new ZipFile()
    const output = createWriteStream(zipPath)
    zip.outputStream.pipe(output)
    zip.addFile(join(sourceDir, "package.json"), "package.json")
    zip.addFile(join(sourceDir, "LICENSE"), "LICENSE")
    zip.addFile(join(sourceDir, "dist", "extension.js"), "dist/extension.js")
    zip.end()
    output.once("close", resolvePromise)
    zip.outputStream.once("error", rejectPromise)
  })
}
