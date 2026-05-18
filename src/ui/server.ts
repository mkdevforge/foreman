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
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { min-height: 100vh; display: grid; grid-template-columns: 240px minmax(0, 1fr); }
    nav { border-right: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); padding: 16px; }
    section { padding: 20px; }
    h1 { margin: 0 0 18px; font-size: 20px; line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: 16px; line-height: 1.3; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    li { padding: 8px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, Canvas); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .panel { border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 8px; padding: 14px; min-height: 80px; }
    @media (max-width: 720px) { main { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); } }
  </style>
</head>
<body>
  <main>
    <nav>
      <h1>Foreman</h1>
      <ul>
        <li>Tasks</li>
        <li>Dispatch</li>
        <li>Sessions</li>
        <li>Costs</li>
      </ul>
    </nav>
    <section>
      <h2>Overview</h2>
      <div class="grid">
        <div class="panel" id="tasks">Tasks</div>
        <div class="panel" id="dispatch">Dispatch runs</div>
        <div class="panel" id="sessions">Sessions</div>
        <div class="panel" id="costs">Costs</div>
      </div>
    </section>
  </main>
</body>
</html>
`;
}
