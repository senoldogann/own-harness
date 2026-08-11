import type {
  OptimizationProposal,
  RequestRecord,
  SessionRecord,
  StatsSummary,
  ToolStats
} from "@own-harness/contracts"
import { createStatsEngine, HarnessStore, requireEncryptedRemoteUrl } from "@own-harness/core"

export interface DashboardOptions {
  readonly storePath: string
  readonly retentionDays?: number
  readonly debugEnabled: boolean
  readonly readOnly?: boolean
}

export interface RemoteDashboardOptions {
  readonly serverUrl: string
  readonly authToken?: string
}

interface DashboardData {
  readonly summary: StatsSummary
  readonly sessions: SessionRecord[]
  readonly requests: RequestRecord[]
  readonly tools: ToolStats[]
  readonly costs: DashboardCost[]
  readonly proposals: OptimizationProposal[]
}

interface DashboardCost {
  readonly provider: string
  readonly model: string
  readonly totalCostUsd: number
  readonly totalTokens: number
  readonly requestCount: number
}

export function renderDashboardHtml(options: DashboardOptions): string {
  const data = loadDashboardData(options)
  return renderContent(data, options.debugEnabled, options.readOnly === true)
}

export async function renderRemoteDashboardHtml(options: RemoteDashboardOptions): Promise<string> {
  const data = await loadRemoteDashboardData(options)
  return renderContent(data, false, true)
}

function loadDashboardData(options: DashboardOptions): DashboardData {
  const storeOptions = options.retentionDays === undefined
    ? { dbPath: options.storePath }
    : { dbPath: options.storePath, retentionDays: options.retentionDays }
  const store = new HarnessStore(storeOptions)
  try {
    const engine = createStatsEngine(store)
    return {
      summary: engine.summary(),
      sessions: store.listSessions(),
      requests: store.listRequestsSince("1970-01-01T00:00:00Z"),
      tools: engine.toolStats(),
      costs: engine.costStats(),
      proposals: store.listProposals()
    }
  } finally {
    store.close()
  }
}

function renderContent(data: DashboardData, debugEnabled: boolean, readOnly: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>own-harness</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: system-ui, sans-serif; margin: 0; background: #f5f5f4; color: #1c1917; }
    header { background: #1c1917; color: #fafaf9; padding: 0.75rem 1.25rem; display: flex; align-items: center; gap: 1rem; }
    h1 { font-size: 1.1rem; margin: 0; }
    nav { display: flex; gap: 0.35rem; margin-left: auto; }
    nav button { background: transparent; color: #fafaf9; border: 1px solid #57534e; border-radius: 6px; padding: 0.35rem 0.65rem; cursor: pointer; }
    nav button.active { background: #d6d3d1; color: #1c1917; border-color: #d6d3d1; }
    main { max-width: 1100px; margin: 1.25rem auto; padding: 0 1.25rem; }
    section { margin: 1.5rem 0; }
    h2 { font-size: 1rem; margin: 0 0 0.6rem; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
    .card { background: #fff; border: 1px solid #d6d3d1; border-radius: 8px; padding: 0.75rem; }
    .card b { display: block; font-size: 1.15rem; margin-top: 0.25rem; }
    .card span { color: #57534e; font-size: 0.8rem; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { border: 1px solid #d6d3d1; padding: 0.45rem 0.6rem; text-align: left; font-size: 0.85rem; vertical-align: top; }
    th { background: #e7e5e4; }
    tbody tr[data-click] { cursor: pointer; }
    .detail { background: #fafaf9; font-family: ui-monospace, monospace; font-size: 0.8rem; word-break: break-all; }
    .pill { display: inline-block; border-radius: 999px; padding: 0.1rem 0.5rem; font-size: 0.75rem; }
    .pill-ok { background: #dcfce7; color: #14532d; }
    .pill-error { background: #fee2e2; color: #7f1d1d; }
    .pill-blocked { background: #fef3c7; color: #713f12; }
    .pill-pending { background: #e0f2fe; color: #0c4a6e; }
    .pill-approved { background: #dcfce7; color: #14532d; }
    .pill-rejected { background: #fee2e2; color: #7f1d1d; }
    .pill-applied { background: #e7e5e4; color: #292524; }
    button.action { border: 1px solid #a8a29e; background: #fafaf9; border-radius: 6px; padding: 0.25rem 0.6rem; cursor: pointer; }
    button.action:hover { background: #e7e5e4; }
    .muted { color: #57534e; }
    .empty { padding: 0.75rem; background: #fff; border: 1px solid #d6d3d1; border-radius: 8px; }
  </style>
</head>
<body>
  <header>
    <h1>own-harness</h1>
    <nav>
      <button data-view="overview" class="active">Overview</button>
      <button data-view="sessions">Sessions</button>
      <button data-view="requests">Requests</button>
      <button data-view="proposals">Proposals</button>
      <button data-view="tools">Tools</button>
    </nav>
  </header>
  <main id="app"></main>
  <script>
"use strict";
const DATA = ${escapeScriptJson(JSON.stringify(data))};
const DEBUG_ENABLED = ${debugEnabled ? "true" : "false"};
const READ_ONLY = ${readOnly ? "true" : "false"};

function initialView() {
  const requested = new URLSearchParams(window.location.search).get("view");
  if (["overview", "sessions", "requests", "proposals", "tools"].includes(requested ?? "")) {
    return requested;
  }
  return "overview";
}

const state = {
  view: initialView(),
  sessionFilter: "",
  expandedRequest: "",
  rawTools: [],
  rawStatus: "idle"
};
const app = document.getElementById("app");

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className !== undefined && className !== "") {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = String(text);
  }
  return el;
}

function statusPill(status) {
  return h("span", "pill pill-" + status, status);
}

function table(headers, rows) {
  const tableEl = h("table");
  const head = h("thead");
  const headRow = h("tr");
  for (const header of headers) {
    headRow.append(h("th", "", header));
  }
  head.append(headRow);
  tableEl.append(head);
  const body = h("tbody");
  for (const row of rows) {
    body.append(row);
  }
  tableEl.append(body);
  return tableEl;
}

function textRow(value, fallback) {
  const td = h("td");
  if (value === null || value === undefined || value === "") {
    td.textContent = fallback;
    td.className = "muted";
  } else {
    td.textContent = String(value);
  }
  return td;
}

function card(label, value, suffix) {
  const el = h("div", "card");
  el.append(h("span", "", label), h("b", "", value + (suffix ?? "")));
  return el;
}

function overviewView() {
  const section = h("section");
  section.append(h("h2", "", "Overview"));
  const cards = h("div", "cards");
  cards.append(
    card("Requests", DATA.summary.totalRequests),
    card("Cost", "$" + Number(DATA.summary.totalCostUsd).toFixed(4)),
    card("Cache hit rate", (DATA.summary.cacheHitRate * 100).toFixed(1), "%"),
    card("Error rate", (DATA.summary.errorRate * 100).toFixed(1), "%"),
    card("Avg duration", Number(DATA.summary.averageDurationMs).toFixed(1), "ms"),
    card("Blocked", DATA.summary.blockedCount),
    card("Audit", DATA.summary.auditCount),
    card("Savings", "$" + Number(DATA.summary.estimatedSavingsUsd).toFixed(4))
  );
  section.append(cards);
  const agents = h("h2", "section-heading", "By agent");
  agents.style.marginTop = "1.25rem";
  section.append(agents);
  section.append(table(["Agent", "Requests"], Object.entries(DATA.summary.byAgent).map((entry) => {
    const row = h("tr");
    row.append(h("td", "", entry[0]), h("td", "", entry[1]));
    return row;
  })));
  if (DATA.costs.length > 0) {
    section.append(h("h2", "section-heading", "Costs"));
    section.append(table(["Provider", "Model", "Cost", "Tokens", "Requests"], DATA.costs.map((cost) => {
      const row = h("tr");
      row.append(
        h("td", "", cost.provider),
        h("td", "", cost.model),
        h("td", "", "$" + Number(cost.totalCostUsd).toFixed(4)),
        h("td", "", cost.totalTokens),
        h("td", "", cost.requestCount)
      );
      return row;
    })));
  }
  return section;
}

function sessionsView() {
  const section = h("section");
  section.append(h("h2", "", "Sessions"));
  if (DATA.sessions.length === 0) {
    section.append(h("div", "empty", "No sessions recorded."));
    return section;
  }
  const rows = DATA.sessions.map((session) => {
    const row = h("tr");
    row.dataset.click = "session";
    row.addEventListener("click", () => {
      state.sessionFilter = session.id;
      state.view = "requests";
      render();
    });
    row.append(
      h("td", "", session.id),
      h("td", "", session.agent),
      statusPill(session.status),
      textRow(session.startedAt),
      textRow(session.endedAt, "-")
    );
    return row;
  });
  section.append(table(["Session", "Agent", "Status", "Started", "Ended"], rows));
  return section;
}

function requestDetailRow(request) {
  const row = h("tr", "detail");
  const cell = h("td");
  cell.colSpan = 8;
  const lines = [
    ["Session", request.sessionId],
    ["Project hash", request.projectHash],
    ["Input hash", request.inputHash],
    ["Output hash", request.outputHash],
    ["Decision", request.decisionId ?? "-"],
    ["Created", request.createdAt]
  ];
  for (const [label, value] of lines) {
    const line = h("div");
    line.append(h("b", "", label + ": "), h("span", "", value));
    cell.append(line);
  }
  row.append(cell);
  return row;
}

function requestsView() {
  const section = h("section");
  const title = h("h2", "", "Requests");
  section.append(title);
  if (state.sessionFilter !== "") {
    const clear = h("button", "action", "Show all requests");
    clear.addEventListener("click", () => {
      state.sessionFilter = "";
      render();
    });
    section.append(clear, h("span", "muted", " Filtered to " + state.sessionFilter));
  }
  const filtered = state.sessionFilter === ""
    ? DATA.requests
    : DATA.requests.filter((request) => request.sessionId === state.sessionFilter);
  if (filtered.length === 0) {
    section.append(h("div", "empty", "No requests recorded."));
    return section;
  }
  const rows = [];
  for (const request of filtered) {
    const row = h("tr");
    row.dataset.click = "request";
    row.addEventListener("click", () => {
      state.expandedRequest = state.expandedRequest === request.id ? "" : request.id;
      render();
    });
    row.append(
      h("td", "", request.id),
      h("td", "", request.agent),
      h("td", "", request.provider),
      h("td", "", request.model),
      h("td", "", request.tokensIn + " / " + request.tokensOut),
      h("td", "", "$" + Number(request.costUsd).toFixed(4)),
      h("td", "", Number(request.durationMs).toFixed(1) + "ms"),
      statusPill(request.status)
    );
    rows.push(row);
    if (state.expandedRequest === request.id) {
      rows.push(requestDetailRow(request));
    }
  }
  section.append(table(["ID", "Agent", "Provider", "Model", "Tokens", "Cost", "Duration", "Status"], rows));
  return section;
}

async function proposalAction(id, action) {
  const response = await fetch("/api/v1/proposals/" + encodeURIComponent(id) + "/" + action, {
    method: "POST"
  });
  if (!response.ok) {
    alert("Proposal action failed: " + (await response.text()));
    return;
  }
  window.location.reload();
}

function proposalsView() {
  const section = h("section");
  section.append(h("h2", "", "Proposals"));
  if (DATA.proposals.length === 0) {
    section.append(h("div", "empty", "No optimization proposals. Run harness optimize to generate them."));
    return section;
  }
  const rows = DATA.proposals.map((proposal) => {
    const row = h("tr");
    const actions = h("td");
    if (READ_ONLY) {
      actions.append(h("span", "muted", "Read only"));
    } else if (proposal.status === "pending") {
      const approve = h("button", "action", "Approve");
      approve.addEventListener("click", () => void proposalAction(proposal.id, "approve"));
      const reject = h("button", "action", "Reject");
      reject.addEventListener("click", () => void proposalAction(proposal.id, "reject"));
      actions.append(approve, " ", reject);
    } else if (proposal.status === "approved") {
      const apply = h("button", "action", "Apply");
      apply.addEventListener("click", () => void proposalAction(proposal.id, "apply"));
      actions.append(apply);
    } else {
      actions.append(h("span", "muted", "-"));
    }
    row.append(
      h("td", "", proposal.id),
      h("td", "", proposal.kind),
      statusPill(proposal.status),
      h("td", "", proposal.evidence),
      h("td", "", proposal.impact),
      textRow(proposal.createdAt),
      actions
    );
    return row;
  });
  section.append(table(["ID", "Kind", "Status", "Evidence", "Impact", "Created", "Actions"], rows));
  return section;
}

async function loadRawTools() {
  if (!DEBUG_ENABLED) {
    state.rawStatus = "disabled";
    return;
  }
  const response = await fetch("/api/v1/tools?raw=true");
  if (response.status === 403) {
    state.rawStatus = "locked";
    return;
  }
  if (!response.ok) {
    state.rawStatus = "error";
    return;
  }
  const payload = await response.json();
  state.rawTools = payload.tools ?? [];
  state.rawStatus = "loaded";
}

function toolsView() {
  const section = h("section");
  section.append(h("h2", "", "Tools"));
  if (DATA.tools.length === 0) {
    section.append(h("div", "empty", "No tool calls recorded."));
  } else {
    section.append(table(["Tool", "Count", "Cost", "Avg duration", "Errors", "Command hashes"], DATA.tools.map((tool) => {
      const row = h("tr");
      row.append(
        h("td", "", tool.tool),
        h("td", "", tool.count),
        h("td", "", "$" + Number(tool.totalCostUsd).toFixed(4)),
        h("td", "", Number(tool.averageDurationMs).toFixed(1) + "ms"),
        h("td", "", tool.errorCount),
        h("td", "", tool.commandHashes.join(", "))
      );
      return row;
    })));
  }
  const debugHeading = h("h2", "section-heading", "Raw commands");
  debugHeading.style.marginTop = "1.25rem";
  section.append(debugHeading);
  if (state.rawStatus === "loaded") {
    section.append(table(["Tool", "Command", "Status", "Duration", "Time"], state.rawTools.map((call) => {
      const row = h("tr");
      row.append(
        h("td", "", call.tool),
        h("td", "", call.command),
        statusPill(call.status),
        h("td", "", Number(call.durationMs).toFixed(1) + "ms"),
        textRow(call.createdAt)
      );
      return row;
    })));
  } else if (state.rawStatus === "locked") {
    section.append(h("div", "empty", "Debug mode is disabled. Start the dashboard with --debug to inspect raw commands."));
  } else if (state.rawStatus === "disabled" && DEBUG_ENABLED) {
    section.append(h("div", "empty", "Debug mode is on, but raw commands could not be loaded."));
  } else if (state.rawStatus === "disabled") {
    section.append(h("div", "empty", "Raw commands are disabled. Start the dashboard with --debug to inspect them."));
  } else {
    section.append(h("div", "empty", "Loading debug data..."));
  }
  return section;
}

function render() {
  app.replaceChildren();
  if (state.view === "sessions") {
    app.append(sessionsView());
  } else if (state.view === "requests") {
    app.append(requestsView());
  } else if (state.view === "proposals") {
    app.append(proposalsView());
  } else if (state.view === "tools") {
    app.append(toolsView());
  } else {
    app.append(overviewView());
  }
  for (const button of document.querySelectorAll("nav button")) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
}

for (const button of document.querySelectorAll("nav button")) {
  button.addEventListener("click", () => {
    state.view = button.dataset.view ?? "overview";
    render();
  });
}

render();
void loadRawTools().then(() => {
  if (state.view === "tools") {
    render();
  }
});
  </script>
</body>
</html>`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

async function loadRemoteDashboardData(options: RemoteDashboardOptions): Promise<DashboardData> {
  requireEncryptedRemoteUrl(options.serverUrl, "remote dashboard server")
  const headers: Record<string, string> = {
    accept: "application/json"
  }
  if (options.authToken !== undefined) {
    headers.authorization = `Bearer ${options.authToken}`
  }
  const base = options.serverUrl.replace(/\/$/, "")
  const [summary, sessions, requests, proposals, tools, costs] = await Promise.all([
    fetchJson<StatsSummary>(`${base}/api/v1/stats/summary`, headers),
    fetchJson<{ sessions: SessionRecord[] }>(`${base}/api/v1/sessions`, headers),
    fetchJson<{ requests: RequestRecord[] }>(`${base}/api/v1/requests`, headers),
    fetchJson<{ proposals: OptimizationProposal[] }>(`${base}/api/v1/proposals`, headers),
    fetchJson<{ tools: ToolStats[] }>(`${base}/api/v1/stats/tools-summary`, headers),
    fetchJson<{ costs: DashboardCost[] }>(`${base}/api/v1/stats/cost-summary`, headers)
  ])
  return {
    summary,
    sessions: sessions.sessions,
    requests: requests.requests,
    tools: tools.tools,
    costs: costs.costs,
    proposals: proposals.proposals
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    throw new Error(`Dashboard data fetch failed with status ${response.status}: ${url}`)
  }
  return await response.json() as T
}

function escapeScriptJson(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
