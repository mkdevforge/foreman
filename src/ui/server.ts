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

interface UiRoute {
  methods: {
    GET?: () => UiEndpoint | Response;
    POST?: (body: Record<string, unknown>) => UiEndpoint | Response;
  };
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
const UI_INDEX_PATH = fileURLToPath(new URL("./index.html", import.meta.url));
const UI_APP_PATH = fileURLToPath(new URL("./app.js", import.meta.url));
const UI_CSS_PATH = fileURLToPath(new URL("./ui.css", import.meta.url));

const UI_STATIC_ROUTES = new Map<string, { path: string; contentType: string }>([
  ["/", { path: UI_INDEX_PATH, contentType: "text/html; charset=utf-8" }],
  ["/index.html", { path: UI_INDEX_PATH, contentType: "text/html; charset=utf-8" }],
  ["/app.js", { path: UI_APP_PATH, contentType: "text/javascript; charset=utf-8" }],
  ["/ui.css", { path: UI_CSS_PATH, contentType: "text/css; charset=utf-8" }]
]);

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

  const staticRoute = UI_STATIC_ROUTES.get(url.pathname);
  if (staticRoute !== undefined) {
    if (request.method !== "GET") {
      return methodNotAllowed(request.method, ["GET"]);
    }

    return serveStaticUiFile(staticRoute);
  }

  const route = resolveUiRoute(url);
  if (route === null) {
    return jsonError(404, "ui_route_not_found", `unknown Foreman UI endpoint '${url.pathname}'`, 2, {
      path: url.pathname
    });
  }

  const endpoint = await resolveUiEndpoint(request, url, route);
  if (endpoint instanceof Response) {
    return endpoint;
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

async function resolveUiEndpoint(request: Request, url: URL, route: UiRoute): Promise<UiEndpoint | Response> {
  if (request.method === "GET" && route.methods.GET !== undefined) {
    return route.methods.GET();
  }

  if (request.method === "POST" && route.methods.POST !== undefined) {
    const unsafeWrite = validateUiWriteRequest(request, url);
    if (unsafeWrite !== null) {
      return unsafeWrite;
    }

    const body = await readUiJsonBody(request);
    if (body instanceof Response) {
      return body;
    }

    return route.methods.POST(body);
  }

  return methodNotAllowed(request.method, Object.keys(route.methods).sort());
}

function resolveUiRoute(url: URL): UiRoute | null {
  const pathname = url.pathname;
  let parts: string[];
  try {
    parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }

  if (matches(parts, ["api", "tasks"])) {
    return getRoute(["task", "list"]);
  }

  if (matchesPrefix(parts, ["api", "tasks"], 3)) {
    return getRoute(["task", "show", parts[2]]);
  }

  if (matchesPrefix(parts, ["api", "chunks"], 3)) {
    return getRoute(["chunk", "list", parts[2]]);
  }

  if (matchesPrefix(parts, ["api", "chunks"], 5) && parts[4] === "status") {
    return postRoute((body) =>
      stringFieldCommand(body, "status", (status) => ["chunk", "status", `${parts[2]}/${parts[3]}`, status.trim()])
    );
  }

  if (matchesPrefix(parts, ["api", "chunks"], 5) && parts[4] === "stage") {
    return postRoute((body) =>
      stringFieldCommand(body, "stage", (stage) => ["chunk", "stage", `${parts[2]}/${parts[3]}`, stage.trim()])
    );
  }

  if (matchesPrefix(parts, ["api", "chunks"], 5) && parts[4] === "notes") {
    return postRoute((body) =>
      stringFieldCommand(body, "body", (noteBody) => ["chunk", "note", `${parts[2]}/${parts[3]}`, noteBody])
    );
  }

  if (matchesPrefix(parts, ["api", "chunks"], 6) && parts[4] === "dispatch" && parts[5] === "start") {
    return postRoute((body) => dispatchStartCommand(parts[2], parts[3], body));
  }

  if (matchesPrefix(parts, ["api", "readiness"], 4)) {
    return getRoute(["chunk", "ready", `${parts[2]}/${parts[3]}`]);
  }

  if (matchesPrefix(parts, ["api", "questions"], 4)) {
    return {
      methods: {
        GET: () => ({ argv: ["question", "list", `${parts[2]}/${parts[3]}`] }),
        POST: (body) => stringFieldCommand(body, "body", (questionBody) => ["question", "add", `${parts[2]}/${parts[3]}`, questionBody])
      }
    };
  }

  if (matchesPrefix(parts, ["api", "questions"], 6) && parts[5] === "answer") {
    return postRoute((body) =>
      stringFieldCommand(body, "answer", (answer) => ["question", "answer", `${parts[2]}/${parts[3]}`, parts[4], answer])
    );
  }

  if (matchesPrefix(parts, ["api", "decisions"], 4)) {
    return {
      methods: {
        GET: () => ({ argv: ["decision", "list", `${parts[2]}/${parts[3]}`] }),
        POST: (body) => stringFieldCommand(body, "body", (decisionBody) => ["decision", "add", `${parts[2]}/${parts[3]}`, decisionBody])
      }
    };
  }

  if ((parts.length === 3 || parts.length === 4) && matchesPrefix(parts, ["api", "reviews"], parts.length)) {
    const ref = parts.length === 3 ? parts[2] : `${parts[2]}/${parts[3]}`;
    return getRoute(["review", ref]);
  }

  if (matches(parts, ["api", "dispatch-runs"])) {
    return getRoute(["dispatch", "list"]);
  }

  if (matches(parts, ["api", "dispatch-runs", "reconcile"])) {
    return postRoute(dispatchReconcileAllCommand);
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "workspace") {
    return getRoute(["dispatch", "workspace", parts[2]]);
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "diff") {
    return { methods: { GET: () => dispatchDiffCommand(parts[2], url.searchParams) } };
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "cancel") {
    return postRoute(() => ({ argv: ["dispatch", "cancel", parts[2]] }));
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "finish") {
    return postRoute((body) => dispatchFinishCommand(parts[2], body));
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "reconcile") {
    return postRoute((body) => dispatchReconcileCommand(parts[2], body));
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "merge") {
    return postRoute(() => ({ argv: ["dispatch", "merge", parts[2]] }));
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 4) && parts[3] === "cleanup") {
    return postRoute((body) => dispatchCleanupCommand(parts[2], body));
  }

  if (matchesPrefix(parts, ["api", "dispatch-runs"], 3)) {
    return getRoute(["dispatch", "show", parts[2]]);
  }

  if (matches(parts, ["api", "sessions"])) {
    return getRoute(["session", "list"]);
  }

  if (matchesPrefix(parts, ["api", "sessions"], 3)) {
    return getRoute(["session", "show", parts[2]]);
  }

  if (matches(parts, ["api", "costs"])) {
    return getRoute(["session", "cost"]);
  }

  return null;
}

function getRoute(argv: string[]): UiRoute {
  return { methods: { GET: () => ({ argv }) } };
}

function postRoute(builder: (body: Record<string, unknown>) => UiEndpoint | Response): UiRoute {
  return { methods: { POST: builder } };
}

function stringFieldCommand(
  body: Record<string, unknown>,
  field: string,
  buildArgv: (value: string) => string[]
): UiEndpoint | Response {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return jsonError(400, "ui_invalid_request_body", `request body must include a non-empty string '${field}' field`, 2, {
      field
    });
  }

  return { argv: buildArgv(value) };
}

function dispatchStartCommand(taskId: string, chunkId: string, body: Record<string, unknown>): UiEndpoint | Response {
  const tool = requiredStringField(body, "tool");
  if (tool instanceof Response) {
    return tool;
  }
  const stage = optionalStringField(body, "stage");
  if (stage instanceof Response) {
    return stage;
  }

  const argv = ["dispatch", "start", `${taskId}/${chunkId}`, "--tool", tool];
  if (stage !== null) {
    argv.push("--stage", stage);
  }
  return { argv };
}

function dispatchFinishCommand(runId: string, body: Record<string, unknown>): UiEndpoint | Response {
  const status = requiredStringField(body, "status");
  if (status instanceof Response) {
    return status;
  }
  const message = optionalStringField(body, "message");
  if (message instanceof Response) {
    return message;
  }
  const allowMissingSession = optionalBooleanField(body, "allow_missing_session");
  if (allowMissingSession instanceof Response) {
    return allowMissingSession;
  }

  const argv = ["dispatch", "finish", runId, "--status", status];
  if (message !== null) {
    argv.push("--message", message);
  }
  if (allowMissingSession) {
    argv.push("--allow-missing-session");
  }
  return { argv };
}

function dispatchReconcileCommand(runId: string, body: Record<string, unknown>): UiEndpoint | Response {
  const olderThan = optionalStringField(body, "older_than");
  if (olderThan instanceof Response) {
    return olderThan;
  }

  const argv = ["dispatch", "reconcile", runId];
  if (olderThan !== null) {
    argv.push("--older-than", olderThan);
  }
  return { argv };
}

function dispatchReconcileAllCommand(body: Record<string, unknown>): UiEndpoint | Response {
  const olderThan = optionalStringField(body, "older_than");
  if (olderThan instanceof Response) {
    return olderThan;
  }

  const argv = ["dispatch", "reconcile", "--all"];
  if (olderThan !== null) {
    argv.push("--older-than", olderThan);
  }
  return { argv };
}

function dispatchCleanupCommand(runId: string, body: Record<string, unknown>): UiEndpoint | Response {
  const force = optionalBooleanField(body, "force");
  if (force instanceof Response) {
    return force;
  }

  const argv = ["dispatch", "cleanup", runId];
  if (force) {
    argv.push("--force");
  }
  return { argv };
}

function dispatchDiffCommand(runId: string, params: URLSearchParams): UiEndpoint | Response {
  const mode = params.get("mode") ?? "full";
  if (mode !== "full" && mode !== "stat" && mode !== "name-only") {
    return jsonError(400, "ui_invalid_dispatch_diff_mode", "invalid dispatch diff mode.", 2, {
      mode,
      expected_modes: ["full", "stat", "name-only"]
    });
  }

  const argv = ["dispatch", "diff", runId];
  if (mode === "stat") {
    argv.push("--stat");
  }
  if (mode === "name-only") {
    argv.push("--name-only");
  }
  return { argv };
}

function requiredStringField(body: Record<string, unknown>, field: string): string | Response {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return jsonError(400, "ui_invalid_request_body", `request body must include a non-empty string '${field}' field`, 2, {
      field
    });
  }

  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, field: string): string | null | Response {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return jsonError(400, "ui_invalid_request_body", `request body field '${field}' must be a string when provided`, 2, {
      field
    });
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalBooleanField(body: Record<string, unknown>, field: string): boolean | Response {
  const value = body[field];
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    return jsonError(400, "ui_invalid_request_body", `request body field '${field}' must be a boolean when provided`, 2, {
      field
    });
  }

  return value;
}

function validateUiWriteRequest(request: Request, url: URL): Response | null {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return jsonError(403, "ui_cross_origin_request", "Foreman UI write endpoints require same-origin requests.", 2, {
      origin,
      expected_origin: url.origin
    });
  }

  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite !== undefined && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    return jsonError(403, "ui_cross_origin_request", "Foreman UI write endpoints require same-origin requests.", 2, {
      sec_fetch_site: secFetchSite,
      expected_sec_fetch_site: ["same-origin", "none"]
    });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return jsonError(415, "ui_unsupported_media_type", "Foreman UI write endpoints require application/json request bodies.", 2, {
      content_type: contentType
    });
  }

  return null;
}

async function readUiJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > 65536) {
    return jsonError(413, "ui_request_body_too_large", "request body is too large.", 2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError(400, "ui_invalid_request_body", "request body must be a JSON object.", 2);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError(400, "ui_invalid_request_body", "request body must be a JSON object.", 2);
  }

  return parsed as Record<string, unknown>;
}

function methodNotAllowed(method: string, allowedMethods: string[]): Response {
  return jsonError(405, "ui_method_not_allowed", "Foreman UI endpoint does not allow this method.", 2, {
    method,
    allowed_methods: allowedMethods
  });
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

async function serveStaticUiFile(route: { path: string; contentType: string }): Promise<Response> {
  const file = Bun.file(route.path);
  if (!(await file.exists())) {
    return jsonError(500, "ui_asset_missing", "Foreman UI asset is missing.", 1, {
      path: route.path
    });
  }

  return new Response(file, {
    headers: { "content-type": route.contentType }
  });
}
