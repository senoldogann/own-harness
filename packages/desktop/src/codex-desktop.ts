import type { AgentKind } from "@own-harness/contracts"
import { spawn, type ChildProcess } from "node:child_process"

export interface CodexDesktopAdapter {
  readonly kind: AgentKind
  readonly launchCommand: (options: {
    readonly baseUrl: string
    readonly cwd: string
    readonly sessionId: string
    readonly projectHash: string
  }) => string
  readonly launch: (options: {
    readonly baseUrl: string
    readonly cwd: string
    readonly sessionId: string
    readonly projectHash: string
    readonly args: readonly string[]
  }) => ChildProcess
}

export function createCodexDesktopAdapter(): CodexDesktopAdapter {
  return {
    kind: "chatgpt-desktop",
    launchCommand: ({ baseUrl, cwd, sessionId, projectHash }) =>
      [
        "CODEX_HOME=" + JSON.stringify(cwd + "/.harness/codex-desktop"),
        "HARNESS_SESSION_ID=" + JSON.stringify(sessionId),
        "HARNESS_AGENT=chatgpt-desktop",
        "HARNESS_PROJECT_HASH=" + JSON.stringify(projectHash),
        "codex",
        "-c",
        `openai_base_url=${baseUrl}`,
        "-c",
        "wire_api=responses",
        "-C",
        JSON.stringify(cwd)
      ].join(" "),
    launch: ({ baseUrl, cwd, sessionId, projectHash, args }) =>
      spawn("codex", ["-c", `openai_base_url=${baseUrl}`, "-c", "wire_api=responses", "-C", cwd, ...args], {
        cwd,
        env: {
          ...process.env,
          CODEX_HOME: `${cwd}/.harness/codex-desktop`,
          HARNESS_SESSION_ID: sessionId,
          HARNESS_AGENT: "chatgpt-desktop",
          HARNESS_PROJECT_HASH: projectHash
        },
        stdio: "inherit"
      })
  }
}
