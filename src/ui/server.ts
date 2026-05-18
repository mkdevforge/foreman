import { fileURLToPath } from "node:url";
import { CliError } from "../cli/errors";

type UiCommandRunner = (input: UiCommandRunnerInput) => UiCommandRunnerResult | Promise<UiCommandRunnerResult>;

export interface UiCommandRunnerInput {
  argv: string[];
  cwd: string;
}

export interface UiCommandRunnerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface StartForemanUiServerOptions {
  repoRoot: string;
  host?: string;
  port?: number;
  runner?: UiCommandRunner;
}

export interface ForemanUiServer {
  url: string;
  host: string;
  port: number;
  stop: () => Promise<void>;
}

interface UiEndpoint {
  argv: string[];
}

interface UiErrorPayload {
  schema_version: 1;
  error: {
    code: string;
    message: string;
    exit_code: number;
    details?: Record<string, unknown>;
  };
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const FOREMAN_BIN_PATH = fileURLToPath(new URL("../../foreman", import.meta.url));

export function parseUiPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new CliError(2, "invalid_ui_port", "invalid --port value; expected an integer from 0 to 65535");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(2, "invalid_ui_port", "invalid --port value; expected an integer from 0 to 65535");
  }

  return port;
}

export function parseUiHost(value: string | undefined): string {
  const host = value ?? DEFAULT_HOST;
  if (host.trim().length === 0) {
    throw new CliError(2, "invalid_ui_host", "invalid --host value; expected a non-empty host");
  }

  return host;
}

export function startForemanUiServer(options: StartForemanUiServerOptions): ForemanUiServer {
  const host = parseUiHost(options.host);
  const port = options.port ?? DEFAULT_PORT;
  const runner = options.runner ?? runForemanJsonCommand;

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (request) => handleUiRequest(request, { repoRoot: options.repoRoot, runner })
  });

  const serverHost = server.hostname ?? host;
  const serverPort = server.port ?? port;

  return {
    url: `http://${serverHost}:${serverPort}/`,
    host: serverHost,
    port: serverPort,
    stop: async () => {
      await server.stop(true);
    }
  };
}

async function handleUiRequest(
  request: Request,
  context: { repoRoot: string; runner: UiCommandRunner }
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return jsonError(405, "ui_method_not_allowed", "Foreman UI endpoints are read-only GET endpoints.", 2, {
      method: request.method
    });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(renderUiShell(), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }

  const endpoint = resolveUiEndpoint(url.pathname);
  if (endpoint === null) {
    return jsonError(404, "ui_route_not_found", `unknown Foreman UI endpoint '${url.pathname}'`, 2, {
      path: url.pathname
    });
  }

  const argv = [...endpoint.argv, "--json"];
  const result = await context.runner({ argv, cwd: context.repoRoot });
  if (result.exitCode !== 0) {
    return commandErrorResponse(argv, result);
  }

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return jsonResponse(parsed, 200);
  } catch {
    return jsonError(502, "ui_command_invalid_json", "Foreman command returned invalid JSON.", 1, {
      command: argv,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr)
    });
  }
}

function resolveUiEndpoint(pathname: string): UiEndpoint | null {
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }

  if (matches(parts, ["api", "tasks"])) {
    return { argv: ["task", "list"] };
  }

  if (matchesPrefix(parts, ["api", "tasks"], 3)) {
    return { argv: ["task", "show", parts[2]] };
  }

  if (matchesPrefix(parts, ["api", "chunks"], 3)) {
    return { argv: ["chunk", "list", parts[2]] };
  }

  if (matchesPrefix(parts, ["api", "readiness"], 4)) {
    return { argv: ["chunk", "ready", `${parts[2]}/${parts[3]}`] };
  }

  if ((parts.length === 3 || parts.length === 4) && matchesPrefix(parts, ["api", "reviews"], parts.length)) {
    const ref = parts.length === 3 ? parts[2] : `${parts[2]}/${parts[3]}`;
    return { argv: ["review", ref] };
  }

  if (matches(parts, ["api", "dispatch-runs"])) {
    return { argv: ["dispatch", "list"] };
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 3)) {
    return { argv: ["dispatch", "show", parts[2]] };
  }

  if (matches(parts, ["api", "sessions"])) {
    return { argv: ["session", "list"] };
  }

  if (matchesPrefix(parts, ["api", "sessions"], 3)) {
    return { argv: ["session", "show", parts[2]] };
  }

  if (matches(parts, ["api", "costs"])) {
    return { argv: ["session", "cost"] };
  }

  return null;
}

function matches(parts: string[], expected: string[]): boolean {
  return parts.length === expected.length && expected.every((part, index) => parts[index] === part);
}

function matchesPrefix(parts: string[], expectedPrefix: string[], expectedLength: number): boolean {
  return parts.length === expectedLength && expectedPrefix.every((part, index) => parts[index] === part);
}

function runForemanJsonCommand(input: UiCommandRunnerInput): UiCommandRunnerResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, FOREMAN_BIN_PATH, ...input.argv],
    cwd: input.cwd,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
}

function commandErrorResponse(argv: string[], result: UiCommandRunnerResult): Response {
  const parsedStderr = parseJson(result.stderr);
  const parsedErrorCode = readParsedErrorCode(parsedStderr);
  const exitCode = result.exitCode ?? 1;
  const status = parsedErrorCode?.endsWith("_not_found") ? 404 : exitCode === 2 ? 400 : 500;

  return jsonError(status, "ui_command_failed", "Foreman command failed.", exitCode, {
    command: argv,
    stderr_json: parsedStderr,
    stderr: parsedStderr === null ? truncate(result.stderr) : null
  });
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(`${JSON.stringify(value, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function jsonError(
  status: number,
  code: string,
  message: string,
  exitCode: number,
  details?: Record<string, unknown>
): Response {
  const payload: UiErrorPayload = {
    schema_version: 1,
    error: {
      code,
      message,
      exit_code: exitCode,
      ...(details === undefined ? {} : { details })
    }
  };

  return jsonResponse(payload, status);
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readParsedErrorCode(value: unknown | null): string | null {
  if (value === null || typeof value !== "object" || !("error" in value)) {
    return null;
  }

  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function truncate(value: string, maxLength = 4096): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : new TextDecoder().decode(output);
}

function renderUiShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Foreman</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: Canvas;
      color: CanvasText;
      --border: color-mix(in srgb, CanvasText 14%, Canvas);
      --muted: color-mix(in srgb, CanvasText 62%, Canvas);
      --surface: color-mix(in srgb, CanvasText 3%, Canvas);
      --surface-strong: color-mix(in srgb, CanvasText 7%, Canvas);
      --accent: #2563eb;
      --green: #15803d;
      --amber: #a16207;
      --red: #b91c1c;
    }

    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; background: Canvas; color: CanvasText; }
    button, input, select, textarea { font: inherit; }
    a { color: inherit; text-decoration: none; }

    .app { min-height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, Canvas 92%, CanvasText);
    }
    .brand { display: grid; gap: 2px; min-width: 0; }
    .brand-label { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.2; text-transform: uppercase; letter-spacing: 0; }
    h1 { margin: 0; font-size: 21px; line-height: 1.2; letter-spacing: 0; }
    .load-state {
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 5px 10px;
      color: var(--muted);
      background: var(--surface);
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .load-state.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 32%, Canvas); }
    .load-state.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 36%, Canvas); }
    .layout { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 0; }
    .rail {
      border-right: 1px solid var(--border);
      padding: 18px 16px;
      background: var(--surface);
      overflow: auto;
    }
    .rail-title { margin: 0 0 10px; color: var(--muted); font-size: 12px; line-height: 1.2; text-transform: uppercase; letter-spacing: 0; }
    .rail-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .rail-list li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 32px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas);
      color: var(--muted);
      font-size: 13px;
    }
    .rail-list strong { color: CanvasText; font-weight: 650; }
    .content { min-width: 0; padding: 18px 20px 32px; overflow: auto; }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric, .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
    }
    .metric { min-height: 88px; padding: 13px 14px; display: grid; align-content: space-between; gap: 8px; }
    .metric-label { color: var(--muted); font-size: 12px; line-height: 1.2; }
    .metric-value { font-size: 27px; line-height: 1; font-weight: 720; letter-spacing: 0; }
    .metric-note { color: var(--muted); font-size: 12px; line-height: 1.3; min-height: 16px; }
    .work-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(340px, 0.8fr); gap: 14px; align-items: start; }
    .stack { display: grid; gap: 14px; }
    .panel { min-width: 0; overflow: hidden; }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, CanvasText 4%, Canvas);
    }
    h2 { margin: 0; font-size: 15px; line-height: 1.3; letter-spacing: 0; }
    .panel-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .rows { display: grid; }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      padding: 12px 14px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas);
    }
    .row:last-child { border-bottom: 0; }
    .row-title {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 7px;
      min-width: 0;
      font-size: 14px;
      line-height: 1.35;
      font-weight: 660;
    }
    .row-id { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
    .row-copy { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .meta-line { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
    .chips { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; align-content: start; max-width: 220px; }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      background: color-mix(in srgb, Canvas 88%, CanvasText);
      color: var(--muted);
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .chip.done { color: var(--green); border-color: color-mix(in srgb, var(--green) 32%, Canvas); }
    .chip.active { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 36%, Canvas); }
    .chip.blocked, .chip.failed { color: var(--red); border-color: color-mix(in srgb, var(--red) 34%, Canvas); }
    .chip.warn { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 36%, Canvas); }
    .empty, .error {
      padding: 18px 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .error { color: var(--red); background: color-mix(in srgb, var(--red) 6%, Canvas); }
    .table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .table th, .table td { padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas); text-align: left; vertical-align: top; }
    .table th { color: var(--muted); font-size: 12px; font-weight: 620; background: color-mix(in srgb, CanvasText 4%, Canvas); }
    .table tr:last-child td { border-bottom: 0; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }

    @media (max-width: 920px) {
      .layout { grid-template-columns: 1fr; }
      .rail { border-right: 0; border-bottom: 1px solid var(--border); }
      .work-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 620px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .content { padding: 14px 12px 24px; }
      .rail { padding: 12px; }
      .row { grid-template-columns: 1fr; }
      .chips { justify-content: flex-start; max-width: none; }
      .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <p class="brand-label">Foreman</p>
        <h1>Work Backlog</h1>
      </div>
      <div class="load-state" id="load-state">Loading</div>
    </header>

    <div class="layout">
      <aside class="rail" aria-label="Summary">
        <p class="rail-title">Current State</p>
        <ul class="rail-list">
          <li><span>Tasks</span><strong id="rail-tasks">0</strong></li>
          <li><span>Open chunks</span><strong id="rail-open-chunks">0</strong></li>
          <li><span>Dispatch runs</span><strong id="rail-dispatch">0</strong></li>
          <li><span>Sessions</span><strong id="rail-sessions">0</strong></li>
          <li><span>Estimated cost</span><strong id="rail-cost">$0.00</strong></li>
        </ul>
      </aside>

      <main class="content">
        <section class="metric-grid" aria-label="Overview metrics">
          <article class="metric">
            <div class="metric-label">Tasks</div>
            <div class="metric-value" id="metric-tasks">0</div>
            <div class="metric-note" id="metric-tasks-note"></div>
          </article>
          <article class="metric">
            <div class="metric-label">Open Chunks</div>
            <div class="metric-value" id="metric-open-chunks">0</div>
            <div class="metric-note" id="metric-open-note"></div>
          </article>
          <article class="metric">
            <div class="metric-label">Dispatch Runs</div>
            <div class="metric-value" id="metric-dispatch">0</div>
            <div class="metric-note" id="metric-dispatch-note"></div>
          </article>
          <article class="metric">
            <div class="metric-label">Sessions</div>
            <div class="metric-value" id="metric-sessions">0</div>
            <div class="metric-note" id="metric-sessions-note"></div>
          </article>
          <article class="metric">
            <div class="metric-label">Cost</div>
            <div class="metric-value" id="metric-cost">$0.00</div>
            <div class="metric-note" id="metric-cost-note"></div>
          </article>
        </section>

        <section class="work-grid">
          <div class="stack">
            <section class="panel" data-endpoint="/api/tasks">
              <div class="panel-head">
                <h2>Tasks</h2>
                <span class="panel-meta" id="tasks-meta">0 tasks</span>
              </div>
              <div class="rows" id="task-rows"><div class="empty">Loading</div></div>
            </section>

            <section class="panel" data-endpoint="/api/dispatch-runs">
              <div class="panel-head">
                <h2>Dispatch Runs</h2>
                <span class="panel-meta" id="dispatch-meta">0 runs</span>
              </div>
              <div class="rows" id="dispatch-rows"><div class="empty">Loading</div></div>
            </section>
          </div>

          <div class="stack">
            <section class="panel" data-endpoint="/api/sessions">
              <div class="panel-head">
                <h2>Recent Sessions</h2>
                <span class="panel-meta" id="sessions-meta">0 sessions</span>
              </div>
              <div class="rows" id="session-rows"><div class="empty">Loading</div></div>
            </section>

            <section class="panel" data-endpoint="/api/costs">
              <div class="panel-head">
                <h2>Cost Groups</h2>
                <span class="panel-meta" id="cost-meta">$0.00</span>
              </div>
              <div id="cost-rows"><div class="empty">Loading</div></div>
            </section>
          </div>
        </section>
      </main>
    </div>
  </div>

  <script type="module">
    const endpoints = {
      tasks: "/api/tasks",
      dispatchRuns: "/api/dispatch-runs",
      sessions: "/api/sessions",
      costs: "/api/costs"
    };

    const state = {
      data: {},
      errors: {}
    };

    loadForemanData();

    async function loadForemanData() {
      const entries = await Promise.allSettled(
        Object.entries(endpoints).map(async ([key, path]) => [key, await fetchJson(path)])
      );

      state.data = {};
      state.errors = {};

      for (const entry of entries) {
        if (entry.status === "fulfilled") {
          const [key, value] = entry.value;
          state.data[key] = value;
        } else {
          const key = entry.reason && entry.reason.key ? entry.reason.key : "unknown";
          state.errors[key] = entry.reason;
        }
      }

      render();
    }

    async function fetchJson(path) {
      let response;
      let body;
      try {
        response = await fetch(path, { headers: { accept: "application/json" } });
        body = await response.json();
      } catch (error) {
        error.key = endpointKey(path);
        throw error;
      }

      if (!response.ok || body.error) {
        const error = new Error(readErrorMessage(body) || "Request failed");
        error.key = endpointKey(path);
        error.status = response.status;
        error.body = body;
        throw error;
      }

      return body;
    }

    function endpointKey(path) {
      return Object.entries(endpoints).find(([, value]) => value === path)?.[0] || "unknown";
    }

    function render() {
      const tasks = array(state.data.tasks?.tasks);
      const chunks = tasks.flatMap((task) => array(task.chunks).map((chunk) => ({ ...chunk, task })));
      const openChunks = chunks.filter((chunk) => chunk.status !== "done");
      const dispatchRuns = array(state.data.dispatchRuns?.dispatch_runs ?? state.data.dispatchRuns?.runs);
      const sessions = array(state.data.sessions?.sessions);
      const cost = state.data.costs?.cost || {};
      const totalCost = Number(cost.overall?.total_cost_usd || 0);
      const failures = Object.keys(state.errors);

      setText("rail-tasks", String(tasks.length));
      setText("rail-open-chunks", String(openChunks.length));
      setText("rail-dispatch", String(dispatchRuns.length));
      setText("rail-sessions", String(sessions.length));
      setText("rail-cost", money(totalCost));

      setText("metric-tasks", String(tasks.length));
      setText("metric-tasks-note", countByStatus(tasks));
      setText("metric-open-chunks", String(openChunks.length));
      setText("metric-open-note", chunks.length + " total chunks");
      setText("metric-dispatch", String(dispatchRuns.length));
      setText("metric-dispatch-note", dispatchRuns.length === 0 ? "No active runs" : countByStatus(dispatchRuns));
      setText("metric-sessions", String(sessions.length));
      setText("metric-sessions-note", sessions.length === 0 ? "No captured sessions" : latestTime(sessions[0]));
      setText("metric-cost", money(totalCost));
      setText("metric-cost-note", (cost.overall?.session_count || 0) + " costed sessions");

      setText("tasks-meta", tasks.length + " tasks");
      setText("dispatch-meta", dispatchRuns.length + " runs");
      setText("sessions-meta", sessions.length + " sessions");
      setText("cost-meta", money(totalCost));

      setHtml("task-rows", renderTasks(tasks));
      setHtml("dispatch-rows", renderDispatchRuns(dispatchRuns));
      setHtml("session-rows", renderSessions(sessions));
      setHtml("cost-rows", renderCosts(cost));

      const loadState = document.getElementById("load-state");
      if (failures.length === 0) {
        loadState.textContent = "Loaded";
        loadState.className = "load-state ok";
      } else {
        loadState.textContent = "Partial";
        loadState.className = "load-state warn";
      }

      renderSectionErrors();
    }

    function renderTasks(tasks) {
      if (state.errors.tasks) {
        return renderError(state.errors.tasks);
      }

      if (tasks.length === 0) {
        return '<div class="empty">No tasks found</div>';
      }

      return tasks.map((task) => {
        const chunks = array(task.chunks);
        const doneChunks = chunks.filter((chunk) => chunk.status === "done").length;
        const activeChunk = chunks.find((chunk) => chunk.status !== "done");
        const description = task.description || task.source_ref || "";
        return '<article class="row">' +
          '<div>' +
            '<div class="row-title"><span class="row-id">' + esc(task.id) + '</span><span>' + esc(task.title || "Untitled task") + '</span></div>' +
            '<p class="row-copy">' + esc(description) + '</p>' +
            '<div class="meta-line">' +
              chip(task.status || "unknown", task.status) +
              (activeChunk ? chip(activeChunk.id, activeChunk.stage || activeChunk.status) : chip("all chunks done", "done")) +
            '</div>' +
          '</div>' +
          '<div class="chips">' + chip(doneChunks + "/" + chunks.length + " chunks", doneChunks === chunks.length ? "done" : "active") + '</div>' +
        '</article>';
      }).join("");
    }

    function renderDispatchRuns(dispatchRuns) {
      if (state.errors.dispatchRuns) {
        return renderError(state.errors.dispatchRuns);
      }

      if (dispatchRuns.length === 0) {
        return '<div class="empty">No dispatch runs</div>';
      }

      return dispatchRuns.slice(0, 12).map((run) => {
        const title = [run.task_id, run.chunk_id].filter(Boolean).join("/") || run.id || "Dispatch run";
        return '<article class="row">' +
          '<div>' +
            '<div class="row-title"><span class="row-id">' + esc(shortId(run.id)) + '</span><span>' + esc(title) + '</span></div>' +
            '<p class="row-copy">' + esc(run.created_at || run.updated_at || "") + '</p>' +
          '</div>' +
          '<div class="chips">' + chip(run.status || "unknown", run.status) + chip(run.tool || "tool unset", "active") + '</div>' +
        '</article>';
      }).join("");
    }

    function renderSessions(sessions) {
      if (state.errors.sessions) {
        return renderError(state.errors.sessions);
      }

      if (sessions.length === 0) {
        return '<div class="empty">No sessions captured</div>';
      }

      return sessions.slice(0, 8).map((session) => {
        const linked = array(session.linked_chunks).map((link) => link.task_id + "/" + link.chunk_id).join(", ");
        const title = session.source + (session.model ? " · " + session.model : "");
        return '<article class="row">' +
          '<div>' +
            '<div class="row-title"><span class="row-id">' + esc(shortId(session.id)) + '</span><span>' + esc(title) + '</span></div>' +
            '<p class="row-copy">' + esc(linked || session.project_path || "Unlinked") + '</p>' +
          '</div>' +
          '<div class="chips">' + chip(formatCost(session.usage?.cost_usd), "active") + chip(formatDate(session.ended_at || session.started_at), "done") + '</div>' +
        '</article>';
      }).join("");
    }

    function renderCosts(cost) {
      if (state.errors.costs) {
        return renderError(state.errors.costs);
      }

      const groups = array(cost.groups);
      if (groups.length === 0) {
        return '<div class="empty">No cost rows</div>';
      }

      return '<table class="table"><thead><tr><th>Group</th><th>Sessions</th><th>Cost</th></tr></thead><tbody>' +
        groups.map((group) => {
          const label = group.source || group.model || group.project_path || group.task_id || "overall";
          return '<tr><td>' + esc(label) + '</td><td>' + esc(group.session_count || 0) + '</td><td class="mono">' + esc(money(Number(group.total_cost_usd || 0))) + '</td></tr>';
        }).join("") +
      '</tbody></table>';
    }

    function renderSectionErrors() {
      for (const key of Object.keys(state.errors)) {
        if (key === "unknown") {
          continue;
        }
        const target = document.querySelector('[data-endpoint="' + endpoints[key] + '"] .rows, [data-endpoint="' + endpoints[key] + '"] #cost-rows');
        if (target) {
          target.innerHTML = renderError(state.errors[key]);
        }
      }
    }

    function renderError(error) {
      return '<div class="error">' + esc(readErrorMessage(error.body) || error.message || "Unable to load data") + '</div>';
    }

    function chip(label, value) {
      const normalized = String(value || label || "").toLowerCase();
      const tone = normalized.includes("done") || normalized.includes("succeeded") ? " done" :
        normalized.includes("fail") || normalized.includes("blocked") ? " failed" :
        normalized.includes("todo") || normalized.includes("plan") || normalized.includes("review") ? " warn" :
        " active";
      return '<span class="chip' + tone + '">' + esc(label || "unknown") + '</span>';
    }

    function countByStatus(items) {
      const counts = items.reduce((acc, item) => {
        const key = item.status || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      return Object.entries(counts).map(([key, value]) => value + " " + key).join(", ");
    }

    function readErrorMessage(body) {
      return body && body.error && body.error.message ? body.error.message : "";
    }

    function latestTime(session) {
      return session ? "Latest " + formatDate(session.ended_at || session.started_at) : "";
    }

    function array(value) {
      return Array.isArray(value) ? value : [];
    }

    function setText(id, value) {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = value;
      }
    }

    function setHtml(id, value) {
      const element = document.getElementById(id);
      if (element) {
        element.innerHTML = value;
      }
    }

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[char]);
    }

    function shortId(value) {
      const text = String(value || "");
      return text.length > 12 ? text.slice(0, 12) : text;
    }

    function formatDate(value) {
      if (!value) {
        return "";
      }
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function formatCost(value) {
      return money(Number(value || 0));
    }

    function money(value) {
      return "$" + value.toFixed(value > 0 && value < 0.01 ? 4 : 2);
    }
  </script>
</body>
</html>
`;
}
