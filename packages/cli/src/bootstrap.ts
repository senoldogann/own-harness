import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, parse, resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import {
  createTelemetryService,
  parseHarnessConfig,
  parsePolicyConfig,
  preparePrivateDatabasePath,
  readPrivateUtf8FileWithinRealRoot,
  readUtf8FileWithinRealRoot,
  resolveRealDirectoryRoot,
  writeUtf8FileExclusivelyWithinRealRoot,
  type HarnessConfig,
  type HarnessStore,
  type PolicyConfig,
  type TelemetryService
} from "@own-harness/core"
import {
  assertExclusiveProjectWriteTargets,
  writeProjectFileExclusive
} from "./fs-utils.js"

const require = createRequire(import.meta.url)
const HARNESS_HOME_ENVIRONMENT_VARIABLE = "HARNESS_HOME"

export interface BootstrapResult {
  readonly config: HarnessConfig
  readonly policy: PolicyConfig
  readonly harnessHome: string
  readonly storePath: string
  readonly policyPath: string
  readonly telemetryPath: string
  readonly authToken: string
  readonly serverAuthToken: string | undefined
  readonly distributionSignatureSecret: string | undefined
}

interface SecretEnvironment {
  readonly [name: string]: string | undefined
}

export function bootstrap(cwd: string): BootstrapResult {
  const workspaceRoot = resolveRealDirectoryRoot(resolve(cwd))
  const configSource = readUtf8FileWithinRealRoot(workspaceRoot, "harness.config.yaml")
  if (configSource === null) {
    throw new Error("harness.config.yaml not found in current directory")
  }
  const config = parseConfigSource(configSource)
  const storePath = preparePrivateDatabasePath(join(resolveHarnessHome(process.env), "state.db"))
  const harnessHome = dirname(storePath)
  const policyPath = join(workspaceRoot, ".harness", "policies", "default.yaml")
  const telemetryPath = join(harnessHome, "telemetry.json")
  const policySource = readUtf8FileWithinRealRoot(
    workspaceRoot,
    join(".harness", "policies", "default.yaml")
  )
  if (policySource === null) {
    throw new Error("Policy file not found in current directory")
  }
  const policy = parsePolicySource(policySource)
  const authToken = loadOrCreateLocalAuthToken(harnessHome)
  const serverAuthToken = resolveConfiguredSecret(
    config.server?.authTokenEnv,
    "server.authTokenEnv",
    16,
    process.env
  )
    const distributionSignatureSecret = resolveConfiguredSecret(
      config.distribution?.signatureSecretEnv,
      "distribution.signatureSecretEnv",
      32,
      process.env
    )
  return {
    config,
    policy,
    harnessHome,
    storePath,
    policyPath,
    telemetryPath,
    authToken,
    serverAuthToken,
    distributionSignatureSecret
  }
}

function resolveConfiguredSecret(
  environmentVariableName: string | undefined,
  configField: string,
  minimumLength: number,
  environment: SecretEnvironment
): string | undefined {
  if (environmentVariableName === undefined) {
    return undefined
  }
  const secret = environment[environmentVariableName]
  if (secret === undefined || secret.length === 0) {
    throw new Error(`${configField} references unset environment variable ${environmentVariableName}`)
  }
  if (secret.length < minimumLength) {
    throw new Error(
      `${configField} environment variable ${environmentVariableName} must contain at least ${minimumLength} characters`
    )
  }
  return secret
}

export function createBootstrapTelemetry(
  store: HarnessStore,
  boot: BootstrapResult
): TelemetryService {
  return createTelemetryService(
    boot.config.telemetry.enabled,
    boot.telemetryPath,
    (eventType, payloadJson) => store.insertTelemetryEvent(eventType, payloadJson),
    () => store.listTelemetryEvents()
  )
}

function resolveHarnessHome(environment: SecretEnvironment): string {
  const configuredHome = environment[HARNESS_HOME_ENVIRONMENT_VARIABLE]
  if (configuredHome === undefined) {
    return join(homedir(), ".own-harness")
  }
  if (configuredHome.length === 0 || !isAbsolute(configuredHome)) {
    throw new Error(`${HARNESS_HOME_ENVIRONMENT_VARIABLE} must be an absolute directory path`)
  }
  const resolvedHome = resolve(configuredHome)
  if (resolvedHome === parse(resolvedHome).root) {
    throw new Error(`${HARNESS_HOME_ENVIRONMENT_VARIABLE} must not identify a filesystem root`)
  }
  return resolvedHome
}

function loadOrCreateLocalAuthToken(harnessHome: string): string {
  const realHarnessHome = resolveRealDirectoryRoot(harnessHome)
  const existingToken = readPrivateUtf8FileWithinRealRoot(realHarnessHome, "auth-token")
  if (existingToken !== null) {
    const token = existingToken.trim()
    if (!/^[a-f0-9]{64}$/.test(token)) {
      throw new Error(`Invalid local management token in ${join(realHarnessHome, "auth-token")}`)
    }
    return token
  }
  const token = randomBytes(32).toString("hex")
  writeUtf8FileExclusivelyWithinRealRoot({
    rootPath: realHarnessHome,
    relativePath: "auth-token",
    content: `${token}\n`,
    mode: 0o600
  })
  return token
}

export function initProject(cwd: string): void {
  const configPath = resolve(cwd, "harness.config.yaml")
  if (existsSync(configPath)) {
    throw new Error(
      `harness.config.yaml already exists in ${cwd}. ` +
      "This project is already initialized; run `harness init` in a fresh directory " +
      "or use the existing config with `harness run <agent>` / `harness dashboard`."
    )
  }
  const policyPath = resolve(cwd, ".harness", "policies", "default.yaml")
  const hookPath = resolve(cwd, ".harness", "hooks", "claude-hooks.sh")
  const hookPythonPath = resolve(dirname(hookPath), "claude-hooks.py")
  assertExclusiveProjectWriteTargets(cwd, [configPath, policyPath, hookPath, hookPythonPath])
  writeProjectFileExclusive(cwd, configPath, defaultConfigYaml(), 0o600)
  writeProjectFileExclusive(cwd, policyPath, defaultPolicyYaml(), 0o600)
  writeProjectFileExclusive(cwd, hookPath, readFileSync(claudeHookAssetPath()), 0o755)
  writeProjectFileExclusive(cwd, hookPythonPath, readFileSync(claudeHookPythonAssetPath()), 0o600)
  chmodSync(hookPath, 0o755)
}

function claudeHookAssetPath(): string {
  return require.resolve("../assets/claude-hooks.sh")
}

function claudeHookPythonAssetPath(): string {
  return require.resolve("../assets/claude-hooks.py")
}

function parseConfigSource(source: string): HarnessConfig {
  const parsed = parseYamlJson(source)
  return parseHarnessConfig(JSON.stringify(parsed))
}

function parsePolicySource(source: string): PolicyConfig {
  const parsed = parseYamlJson(source)
  return parsePolicyConfig(JSON.stringify(parsed))
}

function parseYamlJson(source: string): unknown {
  return parseYaml(source)
}

function defaultConfigYaml(): string {
  return `version: 1
proxy:
  host: "127.0.0.1"
  port: 4103
  translateChatToResponses: false
store:
  home: "~/.own-harness"
  retentionDays: 90
telemetry:
  enabled: false
  optInFile: "~/.own-harness/telemetry.json"
server:
  host: "127.0.0.1"
  # authTokenEnv: "HARNESS_SERVER_AUTH_TOKEN"
# distribution:
#   serverUrl: "https://harness.example.com"
#   signatureSecretEnv: "HARNESS_DISTRIBUTION_SIGNATURE_SECRET"
rtk:
  enabled: false
routing:
  mode: disabled
  rules: []
pricing:
  defaultCurrency: "USD"
  models:
    - provider: "anthropic"
      model: "claude-*"
      inputPerMillion: 3.0
      outputPerMillion: 15.0
    - provider: "openai"
      model: "gpt-*"
      inputPerMillion: 2.5
      outputPerMillion: 10.0
    - provider: "anthropic"
      model: "*deepseek-v4-pro*"
      inputPerMillion: 0.435
      cacheReadInputPerMillion: 0.0435
      outputPerMillion: 0.87
    - provider: "anthropic"
      model: "*deepseek-v4-flash*"
      inputPerMillion: 0.14
      cacheReadInputPerMillion: 0.014
      outputPerMillion: 0.28
    - provider: "openai"
      model: "*deepseek-v4-pro*"
      inputPerMillion: 0.435
      cacheReadInputPerMillion: 0.0435
      outputPerMillion: 0.87
    - provider: "openai"
      model: "*deepseek-v4-flash*"
      inputPerMillion: 0.14
      cacheReadInputPerMillion: 0.014
      outputPerMillion: 0.28
    - provider: "openai-compatible"
      model: "*deepseek-v4-pro*"
      inputPerMillion: 0.435
      cacheReadInputPerMillion: 0.0435
      outputPerMillion: 0.87
    - provider: "openai-compatible"
      model: "*deepseek-v4-flash*"
      inputPerMillion: 0.14
      cacheReadInputPerMillion: 0.014
      outputPerMillion: 0.28
    - provider: "openai-compatible"
      model: "*"
      inputPerMillion: 2.5
      outputPerMillion: 10.0
`
}

function defaultPolicyYaml(): string {
  return `version: 1
mode: audit
defaultAction: allow
project: "*"
rules:
  - id: deny-destructive
    type: tool
    match:
      tools: ["Bash", "Shell"]
      commandRegex: "rm -rf /"
    action: deny
    reason: "Destructive command blocked"

  - id: compress-git
    type: tool
    match:
      tools: ["Bash", "Shell"]
      commandPrefix: ["git", "pnpm build", "npm test"]
    action: log
    reason: "Mark common developer tool calls"
    config:
      maxLines: 80
      maxChars: 4000

  - id: redact-secrets
    type: request
    match:
      direction: outbound
    action: log
    reason: "Monitor outbound requests"
    config:
      patterns:
        - "sk-[A-Za-z0-9_-]{20,}"
        - "AKIA[0-9A-Z]{16}"

  - id: session-budget
    type: session
    match:
      project: "*"
    action: log
    reason: "Monitor session cost"
    config:
      maxUsd: 5
      warnAt: 0.8
      blockAt: 1.0
`
}
