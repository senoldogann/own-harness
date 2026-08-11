import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { ConfigValidationError } from "@own-harness/core"

export function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1))
  }
  return path
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function readJsonFile<T>(path: string): T {
  if (!existsSync(path)) {
    throw new ConfigValidationError(`File not found: ${path}`)
  }
  return JSON.parse(readFileSync(path, "utf8")) as T
}

export function readTextFile(path: string): string {
  if (!existsSync(path)) {
    throw new ConfigValidationError(`File not found: ${path}`)
  }
  return readFileSync(path, "utf8")
}

export function writeTextFile(path: string, content: string): void {
  ensureDir(dirname(path))
  writeFileSync(path, content, "utf8")
}

export function assertExclusiveProjectWriteTargets(root: string, targets: readonly string[]): void {
  const paths = resolveProjectPaths(root, targets)
  for (const path of paths.targets) {
    assertExistingPathIsSafe(paths.root, path)
    if (existsSync(path)) {
      throw new ConfigValidationError(`Initialization destination already exists: ${path}`)
    }
  }
}

export function writeProjectFileExclusive(
  root: string,
  path: string,
  content: string | Uint8Array,
  mode: number
): void {
  const paths = resolveProjectPaths(root, [path])
  const target = paths.targets[0]
  if (target === undefined) {
    throw new ConfigValidationError(`Initialization destination is missing: ${path}`)
  }
  createSafeParentDirectories(paths.root, dirname(target))
  assertExistingPathIsSafe(paths.root, target)
  const descriptor = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode
  )
  try {
    writeFileSync(descriptor, content)
  } finally {
    closeSync(descriptor)
  }
}

interface ProjectPaths {
  readonly root: string
  readonly targets: readonly string[]
}

function resolveProjectPaths(root: string, targets: readonly string[]): ProjectPaths {
  const absoluteRoot = resolve(root)
  const realRoot = realpathSync(absoluteRoot)
  const resolvedTargets = targets.map((target) => {
    const absoluteTarget = resolve(target)
    const relativeTarget = relative(absoluteRoot, absoluteTarget)
    if (!isContainedRelativePath(relativeTarget)) {
      throw new ConfigValidationError(`Initialization destination escapes project root: ${absoluteTarget}`)
    }
    return resolve(realRoot, relativeTarget)
  })
  return { root: realRoot, targets: resolvedTargets }
}

function assertExistingPathIsSafe(root: string, target: string): void {
  const relativeTarget = relative(root, target)
  if (!isContainedRelativePath(relativeTarget)) {
    throw new ConfigValidationError(`Initialization destination escapes project root: ${target}`)
  }
  const segments = relativeTarget.split(sep).filter((segment) => segment.length > 0)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    if (!existsSync(current)) {
      return
    }
    const metadata = lstatSync(current)
    if (metadata.isSymbolicLink()) {
      throw new ConfigValidationError(`Initialization path contains a symbolic link: ${current}`)
    }
    const isTarget = current === target
    if (!isTarget && !metadata.isDirectory()) {
      throw new ConfigValidationError(`Initialization parent is not a directory: ${current}`)
    }
    assertRealPathContained(root, current)
  }
}

function createSafeParentDirectories(root: string, parent: string): void {
  const relativeParent = relative(root, parent)
  if (relativeParent === "") {
    return
  }
  if (!isContainedRelativePath(relativeParent)) {
    throw new ConfigValidationError(`Initialization parent escapes project root: ${parent}`)
  }
  const segments = relativeParent.split(sep).filter((segment) => segment.length > 0)
  let current = root
  for (const segment of segments) {
    current = resolve(current, segment)
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 })
    }
    const metadata = lstatSync(current)
    if (metadata.isSymbolicLink()) {
      throw new ConfigValidationError(`Initialization path contains a symbolic link: ${current}`)
    }
    if (!metadata.isDirectory()) {
      throw new ConfigValidationError(`Initialization parent is not a directory: ${current}`)
    }
    assertRealPathContained(root, current)
  }
}

function assertRealPathContained(root: string, path: string): void {
  const resolvedPath = realpathSync(path)
  const relativePath = relative(root, resolvedPath)
  if (!isContainedRelativePath(relativePath)) {
    throw new ConfigValidationError(`Initialization path resolves outside project root: ${path}`)
  }
}

function isContainedRelativePath(path: string): boolean {
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
