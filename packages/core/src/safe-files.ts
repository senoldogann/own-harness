import { randomBytes } from "node:crypto"
import type { Stats } from "node:fs"
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { StoreError } from "./errors.js"

export interface SafeFileWrite {
  readonly rootPath: string
  readonly relativePath: string
  readonly content: string
  readonly mode: number
}

export interface OpenRegularFileGuard {
  readonly path: string
  readonly descriptor: number
}

export function preparePrivateDatabasePath(dbPath: string): string {
  const resolvedPath = resolve(dbPath)
  const trustedRoot = selectTrustedRoot(resolvedPath)
  const realRoot = realpathSync(trustedRoot)
  assertPrivateDirectoryOwnership(realRoot, lstatSync(realRoot))
  const relativePath = requireContainedRelativePath(trustedRoot, resolvedPath)
  const relativeDirectory = dirname(relativePath)
  const realDirectory = ensureDirectories(realRoot, relativeDirectory, 0o700)
  const safePath = join(realDirectory, basename(relativePath))
  assertMissingOrRegularFile(safePath, "database")
  return safePath
}

export function assertSafeRegularFile(path: string, label: string): void {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new StoreError(`Unsafe ${label} path; expected a regular file: ${path}`)
  }
}

export function openRegularFileGuard(path: string, mode: number): OpenRegularFileGuard {
  let descriptor: number
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      mode
    )
  } catch (error) {
    if (isFileSystemError(error, "ELOOP")) {
      throw new StoreError(`File path must not be a symbolic link: ${path}`)
    }
    throw error
  }
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor)
    throw new StoreError(`File path must identify a regular file: ${path}`)
  }
  return { path, descriptor }
}

export function assertOpenFileGuardIdentity(guard: OpenRegularFileGuard, label: string): void {
  const openMetadata = fstatSync(guard.descriptor)
  const pathMetadata = lstatSync(guard.path)
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    openMetadata.dev !== pathMetadata.dev ||
    openMetadata.ino !== pathMetadata.ino
  ) {
    throw new StoreError(`${label} path changed while it was being opened: ${guard.path}`)
  }
}

export function resolveRealDirectoryRoot(rootPath: string): string {
  const metadata = lstatSync(rootPath)
  if (!metadata.isDirectory()) {
    throw new StoreError(`Workspace root must be a directory: ${rootPath}`)
  }
  return realpathSync(rootPath)
}

export function ensureDirectoryWithinRealRoot(
  realRoot: string,
  relativeDirectory: string,
  mode: number
): string {
  requireRealRoot(realRoot)
  const safeRelativePath = requireRelativePath(relativeDirectory)
  return ensureDirectories(realRoot, safeRelativePath, mode)
}

export function readUtf8FileWithinRealRoot(
  realRoot: string,
  relativePath: string
): string | null {
  requireRealRoot(realRoot)
  const safeRelativePath = requireRelativePath(relativePath)
  const parentPath = requireExistingDirectory(realRoot, dirname(safeRelativePath))
  const targetPath = join(parentPath, basename(safeRelativePath))
  try {
    const descriptor = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new StoreError(`Workspace target must be a regular file: ${targetPath}`)
      }
      return readFileSync(descriptor, "utf8")
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return null
    }
    if (isFileSystemError(error, "ELOOP")) {
      throw new StoreError(`Workspace target must not be a symbolic link: ${targetPath}`)
    }
    throw error
  }
}

export function readPrivateUtf8FileWithinRealRoot(
  realRoot: string,
  relativePath: string
): string | null {
  requireRealRoot(realRoot)
  const safeRelativePath = requireRelativePath(relativePath)
  const parentPath = requireExistingDirectory(realRoot, dirname(safeRelativePath))
  const targetPath = join(parentPath, basename(safeRelativePath))
  try {
    const descriptor = openSync(targetPath, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new StoreError(`Private target must be a regular file: ${targetPath}`)
      }
      fchmodSync(descriptor, 0o600)
      return readFileSync(descriptor, "utf8")
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return null
    }
    if (isFileSystemError(error, "ELOOP")) {
      throw new StoreError(`Private target must not be a symbolic link: ${targetPath}`)
    }
    throw error
  }
}

export function writeUtf8FileExclusivelyWithinRealRoot(options: SafeFileWrite): string {
  requireRealRoot(options.rootPath)
  const safeRelativePath = requireRelativePath(options.relativePath)
  const parentPath = ensureDirectories(options.rootPath, dirname(safeRelativePath), 0o700)
  const targetPath = join(parentPath, basename(safeRelativePath))
  assertMissingOrRegularFile(targetPath, "workspace target")
  let descriptor: number | null = null
  try {
    descriptor = openSync(
      targetPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      options.mode
    )
    writeFileSync(descriptor, options.content, "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    assertSafeRegularFile(targetPath, "workspace target")
    assertUnchangedRealDirectory(options.rootPath, parentPath)
    return targetPath
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
    throw error
  }
}

export function writeUtf8FileAtomicallyWithinRealRoot(options: SafeFileWrite): string {
  requireRealRoot(options.rootPath)
  const safeRelativePath = requireRelativePath(options.relativePath)
  const parentPath = ensureDirectories(options.rootPath, dirname(safeRelativePath), 0o700)
  const targetPath = join(parentPath, basename(safeRelativePath))
  assertMissingOrRegularFile(targetPath, "workspace target")
  const temporaryPath = join(
    parentPath,
    `.${basename(targetPath)}.${process.pid.toString(10)}.${randomBytes(12).toString("hex")}.tmp`
  )
  let descriptor: number | null = null
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      options.mode
    )
    writeFileSync(descriptor, options.content, "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    assertUnchangedRealDirectory(options.rootPath, parentPath)
    assertMissingOrRegularFile(targetPath, "workspace target")
    renameSync(temporaryPath, targetPath)
    assertSafeRegularFile(targetPath, "workspace target")
    assertUnchangedRealDirectory(options.rootPath, parentPath)
    return targetPath
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor)
    }
    removeTemporaryFile(temporaryPath)
    throw error
  }
}

function selectTrustedRoot(path: string): string {
  const candidates = [resolve(process.cwd()), resolve(homedir()), resolve(tmpdir())]
    .filter((candidate) => isPathWithin(candidate, path))
    .sort((left, right) => right.length - left.length)
  return candidates[0] ?? resolve(sep)
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath)
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
}

function requireContainedRelativePath(rootPath: string, targetPath: string): string {
  const relativePath = relative(rootPath, targetPath)
  if (!isPathWithin(rootPath, targetPath) || relativePath.length === 0) {
    throw new StoreError(`Path must identify a file within its trusted root: ${targetPath}`)
  }
  return requireRelativePath(relativePath)
}

function requireRelativePath(path: string): string {
  if (path.length === 0 || path === ".") {
    return "."
  }
  if (isAbsolute(path)) {
    throw new StoreError(`Workspace path must be relative: ${path}`)
  }
  const segments = path.split(sep)
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new StoreError(`Workspace path contains an unsafe component: ${path}`)
  }
  return path
}

function ensureDirectories(realRoot: string, relativeDirectory: string, mode: number): string {
  if (relativeDirectory === ".") {
    return realRoot
  }
  let currentPath = realRoot
  for (const component of relativeDirectory.split(sep)) {
    const nextPath = join(currentPath, component)
    try {
      const metadata = lstatSync(nextPath)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new StoreError(`Unsafe directory component: ${nextPath}`)
      }
      assertPrivateDirectoryOwnership(nextPath, metadata)
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error
      }
      mkdirSync(nextPath, { mode })
      const metadata = lstatSync(nextPath)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new StoreError(`Unsafe directory component created concurrently: ${nextPath}`)
      }
    }
    const realPath = realpathSync(nextPath)
    if (realPath !== nextPath) {
      throw new StoreError(`Directory component changed identity: ${nextPath}`)
    }
    currentPath = nextPath
  }
  return currentPath
}

function assertPrivateDirectoryOwnership(directoryPath: string, metadata: Stats): void {
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new StoreError(`State directory is not owned by the current user: ${directoryPath}`)
  }
  if ((Number(metadata.mode) & 0o022) !== 0) {
    throw new StoreError(
      `State directory grants group/other write or execute access; expected private mode: ${directoryPath}`
    )
  }
}

function requireExistingDirectory(realRoot: string, relativeDirectory: string): string {
  if (relativeDirectory === ".") {
    return realRoot
  }
  let currentPath = realRoot
  for (const component of relativeDirectory.split(sep)) {
    const nextPath = join(currentPath, component)
    const metadata = lstatSync(nextPath)
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(nextPath) !== nextPath) {
      throw new StoreError(`Unsafe directory component: ${nextPath}`)
    }
    currentPath = nextPath
  }
  return currentPath
}

function requireRealRoot(realRoot: string): void {
  if (realpathSync(realRoot) !== realRoot || !lstatSync(realRoot).isDirectory()) {
    throw new StoreError(`Safe file root must be a real directory: ${realRoot}`)
  }
}

function assertMissingOrRegularFile(path: string, label: string): void {
  try {
    assertSafeRegularFile(path, label)
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return
    }
    throw error
  }
}

function assertUnchangedRealDirectory(realRoot: string, directoryPath: string): void {
  if (!isPathWithin(realRoot, directoryPath) || realpathSync(directoryPath) !== directoryPath) {
    throw new StoreError(`Workspace directory changed during write: ${directoryPath}`)
  }
}

function removeTemporaryFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}
