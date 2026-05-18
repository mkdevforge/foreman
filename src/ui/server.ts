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

  if (request.method !== "GET") {
    return jsonError(405, "ui_method_not_allowed", "Foreman UI endpoints are read-only GET endpoints.", 2, {
      method: request.method
    });
  }

  const staticRoute = UI_STATIC_ROUTES.get(url.pathname);
  if (staticRoute !== undefined) {
    return serveStaticUiFile(staticRoute);
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
