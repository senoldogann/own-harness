import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { renderDashboardHtml, renderRemoteDashboardHtml, type RemoteDashboardOptions } from "@own-harness/dashboard"
import { createStatsEngine, HarnessStore } from "@own-harness/core"
import type { BootstrapResult } from "../bootstrap.js"
import { bootstrap } from "../bootstrap.js"
import { applyProposalToPolicy, approveProposalById, rejectProposalById } from "./proposal.js"

export interface DashboardServer {
  readonly close: () => Promise<void>
  readonly port: number
}

export async function createDashboardServer(
  cwd: string,
  host: string,
  port: number,
  debugEnabled: boolean,
  remote?: RemoteDashboardOptions
): Promise<DashboardServer> {
  if (host !== "127.0.0.1") {
    throw new Error(`Dashboard host must be 127.0.0.1; received ${host}`)
  }
  const boot = bootstrap(cwd)
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(cwd, boot, debugEnabled, remote, request, response)
  })
  await listen(server, port, host)
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Dashboard server did not bind to a port")
  }
  return {
    close: () => closeServer(server),
    port: address.port
  }
}

export async function runDashboard(
  cwd: string,
  host: string,
  port: number,
  debugEnabled: boolean,
  remote?: RemoteDashboardOptions
): Promise<void> {
  const dashboard = await createDashboardServer(cwd, host, port, debugEnabled, remote)
  console.log(`Dashboard listening on http://127.0.0.1:${dashboard.port}`)
  console.log("Dashboard authentication required: use the local management token with Bearer auth or Basic username own-harness")
}

async function handleRequest(
  cwd: string,
  boot: BootstrapResult,
  debugEnabled: boolean,
  remote: RemoteDashboardOptions | undefined,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestPath = request.url?.split("?", 1)[0] ?? "/"
  try {
    validateDashboardRequest(request)
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/health" && !isDashboardAuthorized(request.headers.authorization, boot.authToken)) {
      sendUnauthorized(response)
      return
    }
    if (request.method === "GET") {
      await handleGet(cwd, boot, debugEnabled, remote, url, response)
      return
    }
    if (request.method === "POST") {
      await handlePost(cwd, boot, debugEnabled, remote, url, response)
      return
    }
    sendJson(response, 405, { error: "Method not allowed" })
  } catch (error) {
    console.error(JSON.stringify({
      event: "dashboard_error",
      path: requestPath,
      message: error instanceof Error ? error.message : String(error)
    }))
    sendJson(response, 400, { error: "Invalid dashboard request" })
  }
}

async function handleGet(
  cwd: string,
  boot: BootstrapResult,
  debugEnabled: boolean,
  remote: RemoteDashboardOptions | undefined,
  url: URL,
  response: ServerResponse
): Promise<void> {
  if (url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" })
    return
  }
  if (url.pathname === "/") {
    if (remote !== undefined) {
      const html = await renderRemoteDashboardHtml(remote)
      sendText(response, 200, "text/html; charset=utf-8", html)
      return
    }
    const html = renderDashboardHtml({
      storePath: boot.storePath,
      retentionDays: boot.config.store.retentionDays,
      debugEnabled
    })
    sendText(response, 200, "text/html; charset=utf-8", html)
    return
  }
  if (remote !== undefined && url.pathname.startsWith("/api/")) {
    sendJson(response, 501, { error: "Remote dashboard is read-only; local API is disabled" })
    return
  }
  if (url.pathname === "/api/v1/stats/summary") {
    const summary = withStore(boot, (store) => createStatsEngine(store).summary())
    sendJson(response, 200, { summary })
    return
  }
  if (url.pathname === "/api/v1/sessions") {
    const sessions = withStore(boot, (store) => store.listSessions())
    sendJson(response, 200, { sessions })
    return
  }
  if (url.pathname === "/api/v1/requests") {
    const requests = withStore(boot, (store) => store.listRequestsSince("1970-01-01T00:00:00Z"))
    sendJson(response, 200, { requests })
    return
  }
  if (url.pathname === "/api/v1/proposals") {
    const proposals = withStore(boot, (store) => store.listProposals())
    sendJson(response, 200, { proposals })
    return
  }
  if (url.pathname === "/api/v1/tools") {
    if (!debugEnabled) {
      sendJson(response, 403, { error: "Debug mode is required" })
      return
    }
    const tools = withStore(boot, (store) => store.listToolCallsSince("1970-01-01T00:00:00Z"))
    sendJson(response, 200, { tools })
    return
  }
  sendJson(response, 404, { error: `Not found: ${url.pathname}` })
}

async function handlePost(
  cwd: string,
  boot: BootstrapResult,
  debugEnabled: boolean,
  remote: RemoteDashboardOptions | undefined,
  url: URL,
  response: ServerResponse
): Promise<void> {
  if (remote !== undefined) {
    sendJson(response, 403, { error: "Remote dashboard is read-only; proposal mutations are disabled" })
    return
  }
  const match = /^\/api\/v1\/proposals\/([^/]+)\/(approve|reject|apply)$/.exec(url.pathname)
  if (match === null) {
    sendJson(response, 404, { error: `Not found: ${url.pathname}` })
    return
  }
  if (!debugEnabled) {
    sendJson(response, 403, { error: "Debug mode is required for proposal mutations" })
    return
  }
  const proposalId = decodeURIComponent(match[1] ?? "")
  const action = match[2]
  if (action === "approve") {
    sendJson(response, 200, { ok: true, message: approveProposalById(cwd, proposalId) })
    return
  }
  if (action === "reject") {
    sendJson(response, 200, { ok: true, message: rejectProposalById(cwd, proposalId) })
    return
  }
  sendJson(response, 200, { ok: true, message: applyProposalToPolicy(cwd, proposalId) })
}

function validateDashboardRequest(request: IncomingMessage): void {
  const port = request.socket.localPort
  if (port === undefined) {
    throw new Error("Dashboard request has no local port")
  }
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const host = request.headers.host
  if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
    throw new Error("Dashboard request has an invalid Host header")
  }
  const origin = request.headers.origin
  if (origin !== undefined) {
    const parsedOrigin = new URL(origin)
    if (parsedOrigin.protocol !== "http:" || !allowedHosts.has(parsedOrigin.host.toLowerCase())) {
      throw new Error("Dashboard request has an invalid Origin header")
    }
  }
}

function withStore<T>(boot: BootstrapResult, operation: (store: HarnessStore) => T): T {
  const store = new HarnessStore({ dbPath: boot.storePath, retentionDays: boot.config.store.retentionDays })
  try {
    return operation(store)
  } finally {
    store.close()
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  sendText(response, statusCode, "application/json; charset=utf-8", JSON.stringify(body))
}

function sendUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": 'Basic realm="own-harness", charset="UTF-8"',
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  })
  response.end(JSON.stringify({ error: "Dashboard authentication required" }))
}

function sendText(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  })
  response.end(body)
}

function isDashboardAuthorized(authorization: string | undefined, expectedToken: string): boolean {
  if (authorization === undefined) {
    return false
  }
  if (authorization.startsWith("Bearer ")) {
    return safeEqual(authorization.slice("Bearer ".length), expectedToken)
  }
  if (!authorization.startsWith("Basic ")) {
    return false
  }
  const encoded = authorization.slice("Basic ".length)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return false
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8")
  const separator = decoded.indexOf(":")
  if (separator === -1 || decoded.slice(0, separator) !== "own-harness") {
    return false
  }
  return safeEqual(decoded.slice(separator + 1), expectedToken)
}

function safeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve())
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
