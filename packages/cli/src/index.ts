#!/usr/bin/env node
import { Command } from "commander"
import { attachDesktop } from "./commands/attach.js"
import { runDashboard } from "./commands/dashboard.js"
import { showDocs } from "./commands/docs.js"
import { exportAudit, exportAuditToFile, exportTelemetry, exportTelemetryToFile } from "./commands/export.js"
import { runInit } from "./commands/init.js"
import { parseDayCount, runOptimize } from "./commands/optimize.js"
import { applyProposal, approveProposal, listProposals, rejectProposal, showProposal } from "./commands/proposal.js"
import { pullPolicy, validatePolicy } from "./commands/policy.js"
import { runRoutingStatus } from "./commands/routing.js"
import { runAgent } from "./commands/run.js"
import { runServe } from "./commands/serve.js"
import { runStats } from "./commands/stats.js"
import { runStatus } from "./commands/status.js"
import { importTelemetry, telemetryDisable, telemetryEnable, telemetryStatus } from "./commands/telemetry.js"
import { ingestToolCall } from "./commands/ingest.js"

const program = new Command()

program
  .name("harness")
  .description("Local control plane for AI coding agents")
  .version("1.0.0")
  .enablePositionalOptions()

const cwd = process.cwd()

program
  .command("init")
  .description("Initialize harness project files")
  .action(() => runInit(cwd))

program
  .command("serve")
  .description("Start the local provider proxy")
  .action(() => runServe(cwd))

program
  .command("run")
  .description("Run an agent through the harness")
  .argument("<kind>", "claude, codex, or opencode")
  .argument("[args...]", "agent arguments")
  .passThroughOptions()
  .action((kind: string, args: string[]) => void runAgent(kind as "claude" | "codex" | "opencode", cwd, args))

program
  .command("attach")
  .description("Attach to a desktop agent")
  .requiredOption("--desktop <name>", "desktop agent name")
  .option("--verify-only", "verify the desktop device without launching a session")
  .argument("[args...]", "agent arguments")
  .passThroughOptions()
  .action((args: string[], options: { desktop: string; verifyOnly?: boolean }) => {
    void attachDesktop(cwd, options.desktop, args, options.verifyOnly === true)
  })

program
  .command("ingest")
  .description("Ingest a tool call through the harness")
  .argument("<tool>", "tool name")
  .argument("<command>", "raw command")
  .action((tool: string, command: string) => void ingestToolCall(cwd, tool, command))

program
  .command("status")
  .description("Show harness status")
  .action(() => runStatus(cwd))

program
  .command("dashboard")
  .description("Start the local dashboard")
  .option("--host <host>", "dashboard host", "127.0.0.1")
  .option("--port <port>", "dashboard port", "4300")
  .option("--debug", "enable raw command inspection in addition to the management token")
  .option("--remote-url <url>", "read-only dashboard source URL")
  .option("--token <token>", "bearer token for the read-only dashboard source")
  .action((options: { host: string; port: string; debug: boolean; remoteUrl?: string; token?: string }) => {
    const remote = options.remoteUrl === undefined
      ? undefined
      : { serverUrl: options.remoteUrl, ...(options.token === undefined ? {} : { authToken: options.token }) }
    void runDashboard(cwd, options.host, Number(options.port), options.debug, remote)
  })

program
  .command("stats")
  .description("Show local statistics")
  .action(() => runStats(cwd))

program
  .command("optimize")
  .description("Generate optimization proposals from local data")
  .option("--since <days>", "days of history", "7")
  .action((options: { since: string }) => runOptimize(cwd, parseDayCount(options.since)))

program
  .command("proposal")
  .description("Manage optimization proposals")
  .argument("[action]", "list, show, approve, reject, or apply")
  .argument("[id]", "proposal id")
  .action((action: string | undefined, id: string | undefined) => {
    if (action === undefined || action === "list") {
      listProposals(cwd)
      return
    }
    if (action === "show") {
      if (id === undefined) {
        throw new Error("proposal id is required")
      }
      showProposal(cwd, id)
      return
    }
    if (action === "apply") {
      if (id === undefined) {
        throw new Error("proposal id is required")
      }
      applyProposal(cwd, id)
      return
    }
    if (action === "approve") {
      if (id === undefined) {
        throw new Error("proposal id is required")
      }
      approveProposal(cwd, id)
      return
    }
    if (action === "reject") {
      if (id === undefined) {
        throw new Error("proposal id is required")
      }
      rejectProposal(cwd, id)
      return
    }
    throw new Error(`Unknown proposal action: ${action}`)
  })

program
  .command("policy")
  .description("Manage policy")
  .argument("[action]", "validate or pull")
  .option("--url <url>", "policy distribution server URL override")
  .option("--token <token>", "bearer token override for the policy distribution server")
  .action((action: string | undefined, options: { url?: string; token?: string }) => {
    if (action === undefined || action === "validate") {
      validatePolicy(cwd)
      return
    }
    if (action === "pull") {
      return pullPolicy(cwd, options.url, options.token)
    }
    throw new Error(`Unknown policy action: ${action}`)
  })

program
  .command("routing")
  .description("Show automatic routing configuration")
  .action(() => runRoutingStatus(cwd))

program
  .command("telemetry")
  .description("Manage telemetry consent")
  .argument("[action]", "status, enable, disable, or import")
  .argument("[file]", "telemetry export file for import")
  .action((action: string | undefined, file: string | undefined) => {
    if (action === undefined || action === "status") {
      telemetryStatus(cwd)
      return
    }
    if (action === "enable") {
      telemetryEnable(cwd)
      return
    }
    if (action === "disable") {
      telemetryDisable(cwd)
      return
    }
    if (action === "import") {
      if (file === undefined) {
        throw new Error("telemetry import requires a file path")
      }
      importTelemetry(cwd, file)
      return
    }
    throw new Error(`Unknown telemetry action: ${action}`)
  })

program
  .command("export")
  .description("Export anonymized telemetry payload")
  .option("--file <path>", "write export to a file instead of stdout")
  .option("--audit", "export policy decision audit records")
  .action((options: { file?: string; audit?: boolean }) => {
    if (options.audit === true) {
      if (options.file !== undefined) {
        exportAuditToFile(cwd, options.file)
        return
      }
      exportAudit(cwd)
      return
    }
    if (options.file !== undefined) {
      exportTelemetryToFile(cwd, options.file)
      return
    }
    exportTelemetry(cwd)
  })

program
  .command("docs")
  .description("Show docs path")
  .action(() => showDocs(cwd))

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
