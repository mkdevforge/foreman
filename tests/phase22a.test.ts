import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runForemanCli } from "../src/cli/runtime";
import { startForemanUiServer, type ForemanUiServer, type UiCommandRunnerInput } from "../src/ui/server";

const tempDirs: string[] = [];
const servers: ForemanUiServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }

  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 22a read-only UI server", () => {
  test("ui help exposes host and port options without starting a server", () => {
    const result = runCli(["ui", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: foreman ui");
    expect(result.stdout).toContain("--host <host>");
    expect(result.stdout).toContain("--port <port>");
    expect(result.stderr).toBe("");
  });

  test("serves the local UI shell and proxies read-only task listing", async () => {
    const repoRoot = createTempDir();
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(repoRoot, async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1, tasks: [{ id: "FOREMAN-22" }] });
    });

    expect(server.port).toBeGreaterThan(0);

    const shell = await fetchText(server, "/");
    expect(shell.status).toBe(200);
    expect(shell.contentType).toContain("text/html");
    expect(shell.text).toContain("<title>Foreman</title>");
    expect(shell.text).toContain("Work Backlog");
    expect(shell.text).toContain('data-endpoint="/api/tasks"');
    expect(shell.text).toContain("loadForemanData");

    const response = await fetchJson(server, "/api/tasks");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ schema_version: 1, tasks: [{ id: "FOREMAN-22" }] });
    expect(calls).toEqual([{ argv: ["task", "list", "--json"], cwd: repoRoot }]);
  });

  test("maps specific endpoints to internal allowlisted CLI commands", async () => {
    const repoRoot = createTempDir();
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(repoRoot, async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1, ok: true });
    });

    await fetchJson(server, "/api/tasks/FOREMAN-22");
    await fetchJson(server, "/api/chunks/FOREMAN-22");
    await fetchJson(server, "/api/readiness/FOREMAN-22/ui-readonly-server");
    await fetchJson(server, "/api/reviews/FOREMAN-22");
    await fetchJson(server, "/api/reviews/FOREMAN-22/ui-readonly-server");
    await fetchJson(server, "/api/dispatch-runs");
    await fetchJson(server, "/api/dispatch-runs/run_abc");
    await fetchJson(server, "/api/sessions");
    await fetchJson(server, "/api/sessions/session_abc");
    await fetchJson(server, "/api/costs");

    expect(calls.map((call) => call.argv)).toEqual([
      ["task", "show", "FOREMAN-22", "--json"],
      ["chunk", "list", "FOREMAN-22", "--json"],
      ["chunk", "ready", "FOREMAN-22/ui-readonly-server", "--json"],
      ["review", "FOREMAN-22", "--json"],
      ["review", "FOREMAN-22/ui-readonly-server", "--json"],
      ["dispatch", "list", "--json"],
      ["dispatch", "show", "run_abc", "--json"],
      ["session", "list", "--json"],
      ["session", "show", "session_abc", "--json"],
      ["session", "cost", "--json"]
    ]);
  });

  test("rejects non-GET and unknown endpoints without running a CLI command", async () => {
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(createTempDir(), async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1 });
    });

    const method = await fetchJson(server, "/api/tasks", { method: "POST" });
    const unknown = await fetchJson(server, "/api/commands");
    const malformedPath = await fetchJson(server, "/api/tasks/%E0%A4%A");

    expect(method.status).toBe(405);
    expect(method.body.error.code).toBe("ui_method_not_allowed");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("ui_route_not_found");
    expect(malformedPath.status).toBe(404);
    expect(malformedPath.body.error.code).toBe("ui_route_not_found");
    expect(calls).toEqual([]);
  });

  test("maps CLI JSON errors and plain stderr failures into stable endpoint errors", async () => {
    const server = startTestServer(createTempDir(), async (input) => {
      if (input.argv[0] === "task") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: JSON.stringify({
            schema_version: 1,
            error: { code: "task_not_found", message: "missing", exit_code: 1 }
          })
        };
      }

      return { exitCode: 1, stdout: "", stderr: "database locked\n" };
    });

    const missing = await fetchJson(server, "/api/tasks/MISSING");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({
      code: "ui_command_failed",
      exit_code: 1,
      details: {
        command: ["task", "show", "MISSING", "--json"],
        stderr_json: {
          schema_version: 1,
          error: { code: "task_not_found" }
        },
        stderr: null
      }
    });

    const failed = await fetchJson(server, "/api/sessions");
    expect(failed.status).toBe(500);
    expect(failed.body.error).toMatchObject({
      code: "ui_command_failed",
      exit_code: 1,
      details: {
        command: ["session", "list", "--json"],
        stderr_json: null,
        stderr: "database locked\n"
      }
    });
  });

  test("reports invalid command JSON and supports clean shutdown", async () => {
    const server = startTestServer(createTempDir(), async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }));
    const invalid = await fetchJson(server, "/api/tasks");

    expect(invalid.status).toBe(502);
    expect(invalid.body.error).toMatchObject({
      code: "ui_command_invalid_json",
      exit_code: 1,
      details: { command: ["task", "list", "--json"] }
    });

    await server.stop();
    servers.pop();
  });
});

function startTestServer(
  repoRoot: string,
  runner: (input: UiCommandRunnerInput) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>
): ForemanUiServer {
  const server = startForemanUiServer({ repoRoot, host: "127.0.0.1", port: 0, runner });
  servers.push(server);
  return server;
}

function jsonResult(value: unknown) {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: ""
  };
}

async function fetchJson(server: ForemanUiServer, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, server.url), init);
  return { status: response.status, body: await response.json() };
}

async function fetchText(
  server: ForemanUiServer,
  path: string
): Promise<{ status: number; text: string; contentType: string }> {
  const response = await fetch(new URL(path, server.url));
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get("content-type") ?? ""
  };
}

function runCli(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const result = runForemanCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  });

  return { ...result, stdout, stderr };
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase22a-"));
  tempDirs.push(dir);
  return dir;
}
