import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaudeAdapter, createCodexAdapter, createOpenCodeAdapter } from "../src/adapters.js"

const previousEnv = new Map<string, string | undefined>()

afterEach(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  previousEnv.clear()
})

describe("agent adapters", () => {
  it("launches Claude with provider base URL and hook settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-claude-adapter-"))
    writeFakeBinary(dir, "claude", "claude-ok")
    const adapter = createClaudeAdapter("http://127.0.0.1:4103")
    const command = adapter.buildLaunchCommand({
      args: ["--print", "hello"],
      cwd: dir
    })
    expect(command).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:4103")
    expect(command).toContain("--settings")
    expect(command).toContain(".harness/hooks/claude-hooks.sh")
    const settings = settingsFromLaunchCommand(command)
    expect(Object.keys(settings.hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure"
    ])
    setEnv("PATH", `${dir}:${process.env.PATH ?? ""}`)
    const child = adapter.launch({
      args: ["--print", "hello"],
      cwd: dir,
      sessionId: "session-claude",
      projectHash: "project-claude"
    })
    const code = await waitExit(child)
    expect(code).toBe(0)
    const envFile = readFileSync(join(dir, "claude.env"), "utf8")
    expect(envFile).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:4103")
    expect(envFile).toContain("HARNESS_SESSION_ID=session-claude")
    expect(envFile).toContain("HARNESS_AGENT=claude")
    expect(envFile).toContain("HARNESS_PROJECT_HASH=project-claude")
    rmSync(dir, { recursive: true, force: true })
  })

  it("quotes crafted Claude hook paths as a single POSIX shell argument", () => {
    const root = mkdtempSync(join(tmpdir(), "own-harness-claude-quote-"))
    const crafted = join(root, "$(touch injected)$HOME`touch ticked`'line\nend")
    const hookDir = join(crafted, ".harness", "hooks")
    mkdirSync(hookDir, { recursive: true })
    const marker = join(root, "hook-ran")
    const hookPath = join(hookDir, "claude-hooks.sh")
    writeFileSync(hookPath, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`, "utf8")
    chmodSync(hookPath, 0o755)

    const command = createClaudeAdapter("http://127.0.0.1:4103").buildLaunchCommand({
      args: [],
      cwd: crafted
    })
    const settings = settingsFromLaunchCommand(command)
    const preToolUseHooks = settings.hooks.PreToolUse
    if (preToolUseHooks === undefined) {
      throw new Error("Claude PreToolUse hooks were not generated")
    }
    const hookCommand = preToolUseHooks[0]?.hooks[0]?.command
    if (hookCommand === undefined) {
      throw new Error("Claude PreToolUse hook command was not generated")
    }
    execFileSync("sh", ["-c", hookCommand], { cwd: root })

    expect(existsSync(marker)).toBe(true)
    expect(existsSync(join(root, "injected"))).toBe(false)
    expect(existsSync(join(root, "ticked"))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it("passes the auth token and model env through Claude settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-claude-settings-"))
    writeFakeBinary(dir, "claude", "claude-settings-ok")
    setEnv("ANTHROPIC_AUTH_TOKEN", "smoke-test-token")
    setEnv("ANTHROPIC_MODEL", "smoke-test-model")
    setEnv("ANTHROPIC_DEFAULT_SONNET_MODEL", "smoke-test-sonnet")
    setEnv("CLAUDE_CODE_SUBAGENT_MODEL", "smoke-test-subagent")
    setEnv("CLAUDE_CODE_EFFORT_LEVEL", "high")
    const adapter = createClaudeAdapter("http://127.0.0.1:4103")
    const command = adapter.buildLaunchCommand({
      args: ["--print", "hello"],
      cwd: dir
    })
    const settings = settingsFromLaunchCommand(command)
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4103")
    for (const key of CLAUDE_SETTINGS_ENV_KEYS) {
      const value = process.env[key]
      if (value === undefined) {
        expect(settings.env[key]).toBeUndefined()
      } else {
        expect(settings.env[key]).toBe(value)
      }
    }
    setEnv("PATH", `${dir}:${process.env.PATH ?? ""}`)
    const child = adapter.launch({
      args: ["--print", "hello"],
      cwd: dir,
      sessionId: "session-claude-settings",
      projectHash: "project-claude-settings"
    })
    const code = await waitExit(child)
    expect(code).toBe(0)
    const launchSettings = settingsFromArgvFile(join(dir, "claude.argv"))
    expect(launchSettings.env.ANTHROPIC_AUTH_TOKEN).toBe("smoke-test-token")
    expect(launchSettings.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high")
    const envFile = readFileSync(join(dir, "claude.env"), "utf8")
    expect(envFile).toContain("ANTHROPIC_AUTH_TOKEN=smoke-test-token")
    expect(envFile).toContain("ANTHROPIC_MODEL=smoke-test-model")
    expect(envFile).toContain("CLAUDE_CODE_EFFORT_LEVEL=high")
    rmSync(dir, { recursive: true, force: true })
  })

  it("launches Codex with custom provider base URL and isolated CODEX_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-codex-adapter-"))
    writeFakeBinary(dir, "codex", "codex-ok")
    const adapter = createCodexAdapter("http://127.0.0.1:4103")
    const command = adapter.buildLaunchCommand({
      args: ["exec", "--json"],
      cwd: dir
    })
    expect(command).toContain("CODEX_HOME=")
    expect(command).toContain("model_providers.openai-custom.base_url=http://127.0.0.1:4103/v1")
    expect(command).toContain("model_provider=openai-custom")
    expect(command).toContain("wire_api=responses")
    expect(command).toContain("supports_websockets=false")
    setEnv("PATH", `${dir}:${process.env.PATH ?? ""}`)
    const child = adapter.launch({
      args: ["exec", "--json"],
      cwd: dir,
      sessionId: "session-codex",
      projectHash: "project-codex"
    })
    const code = await waitExit(child)
    expect(code).toBe(0)
    const envFile = readFileSync(join(dir, "codex.env"), "utf8")
    expect(envFile).toContain("HARNESS_AGENT=codex")
    expect(envFile).toContain("CODEX_HOME=")
    expect(envFile).toContain("HARNESS_INGEST_URL=http://127.0.0.1:4103")
    rmSync(dir, { recursive: true, force: true })
  })

  it("launches OpenCode with provider base URL and plugin env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "own-harness-opencode-adapter-"))
    writeFakeBinary(dir, "opencode", "opencode-ok")
    const adapter = createOpenCodeAdapter("http://127.0.0.1:4103")
    const command = adapter.buildLaunchCommand({
      args: ["run", "--model", "own-harness/gpt-5.6-sol"],
      cwd: dir
    })
    expect(command).toContain("OPENCODE_CONFIG=")
    expect(command).toContain("run")
    setEnv("PATH", `${dir}:${process.env.PATH ?? ""}`)
    const child = adapter.launch({
      args: ["run", "--model", "own-harness/gpt-5.6-sol"],
      cwd: dir,
      sessionId: "session-opencode",
      projectHash: "project-opencode"
    })
    const code = await waitExit(child)
    expect(code).toBe(0)
    const envFile = readFileSync(join(dir, "opencode.env"), "utf8")
    expect(envFile).toContain("HARNESS_BASE_URL=http://127.0.0.1:4103")
    expect(envFile).toContain("OPENCODE_CONFIG=")
    expect(envFile).toContain("HARNESS_SESSION_ID=session-opencode")
    expect(envFile).toContain("HARNESS_PROJECT_HASH=project-opencode")
    const configFile = readFileSync(join(dir, ".harness", "opencode.json"), "utf8")
    expect(configFile).toContain("http://127.0.0.1:4103/v1")
    expect(configFile).toContain("gpt-5.6-sol")
    const pluginPath = join(dir, ".opencode", "plugins", "own-harness.mjs")
    const pluginFile = readFileSync(pluginPath, "utf8")
    expect(pluginFile).toContain('"tool.execute.before"')
    expect(pluginFile).toContain('"tool.execute.after"')
    expect(pluginFile).toContain('event: async ({ event })')
    expect(pluginFile).toContain('event?.type !== "message.part.updated"')
    expect(pluginFile).toContain("toolUseId: input.callID")
    execFileSync(process.execPath, ["--check", pluginPath])
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects OpenCode config paths that escape through symbolic links", () => {
    const workspace = mkdtempSync(join(tmpdir(), "own-harness-opencode-path-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-opencode-outside-"))
    const marker = join(outside, "opencode.json")
    writeFileSync(marker, "unchanged", "utf8")
    symlinkSync(outside, join(workspace, ".harness"))

    expect(() => createOpenCodeAdapter("http://127.0.0.1:4103").launch({
      args: ["run", "--model", "own-harness/gpt-5.6-sol"],
      cwd: workspace,
      sessionId: "session-opencode",
      projectHash: "project-opencode"
    })).toThrow("Unsafe directory component")
    expect(readFileSync(marker, "utf8")).toBe("unchanged")
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it("rejects an OpenCode config file symbolic link", () => {
    const workspace = mkdtempSync(join(tmpdir(), "own-harness-opencode-target-"))
    const outside = mkdtempSync(join(tmpdir(), "own-harness-opencode-target-outside-"))
    mkdirSync(join(workspace, ".harness"), { recursive: true })
    const marker = join(outside, "opencode.json")
    writeFileSync(marker, "unchanged", "utf8")
    symlinkSync(marker, join(workspace, ".harness", "opencode.json"))

    expect(() => createOpenCodeAdapter("http://127.0.0.1:4103").launch({
      args: ["run", "--model", "own-harness/gpt-5.6-sol"],
      cwd: workspace,
      sessionId: "session-opencode",
      projectHash: "project-opencode"
    })).toThrow("expected a regular file")
    expect(readFileSync(marker, "utf8")).toBe("unchanged")
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

})

interface ClaudeHookSettings {
  readonly env: Record<string, string>
  readonly hooks: Record<string, Array<{
    readonly hooks: Array<{ readonly command: string }>
  }>>
}

function settingsFromLaunchCommand(command: string): ClaudeHookSettings {
  const marker = "--settings "
  const markerIndex = command.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error("Claude launch command does not contain --settings")
  }
  return JSON.parse(command.slice(markerIndex + marker.length)) as ClaudeHookSettings
}

function settingsFromArgvFile(argvPath: string): ClaudeHookSettings {
  const args = readFileSync(argvPath, "utf8").split("\n")
  const markerIndex = args.indexOf("--settings")
  if (markerIndex === -1) {
    throw new Error("Claude launch args do not contain --settings")
  }
  const settingsJson = args[markerIndex + 1]
  if (settingsJson === undefined) {
    throw new Error("Claude launch args are missing the settings JSON")
  }
  return JSON.parse(settingsJson) as ClaudeHookSettings
}

function writeFakeBinary(dir: string, name: string, marker: string): void {
  const path = join(dir, name)
  const content = `#!/usr/bin/env bash
env | sort > "${dir}/${name}.env"
printf '%s\\n' "$@" > "${dir}/${name}.argv"
echo "${marker}"
exit 0
`
  writeFileSync(path, content, { encoding: "utf8", mode: 0o755 })
  chmodSync(path, 0o755)
}

const CLAUDE_SETTINGS_ENV_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_EFFORT_LEVEL"
] as const

function setEnv(key: string, value: string): void {
  previousEnv.set(key, process.env[key])
  process.env[key] = value
}

function waitExit(child: ReturnType<ReturnType<typeof createClaudeAdapter>["launch"]>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
}
