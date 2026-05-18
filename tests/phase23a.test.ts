import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("Phase 23a UI write bridge", () => {
  test("maps allowlisted POST endpoints to JSON CLI write commands", async () => {
    const repoRoot = createTempDir();
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(repoRoot, async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1, argv: input.argv });
    });

    await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/status", jsonPost({ status: "review" }));
    await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/stage", jsonPost({ stage: "implement" }));
    await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/notes", jsonPost({ body: "Ready for review." }));
    await fetchJson(server, "/api/questions/FOREMAN-23/ui-write-bridge", jsonPost({ body: "Which UI control owns this?" }));
    await fetchJson(
      server,
      "/api/questions/FOREMAN-23/ui-write-bridge/q_019e384e-bee7-77fc-943e-524ac04daca7/answer",
      jsonPost({ answer: "Use the task detail view." })
    );
    await fetchJson(server, "/api/decisions/FOREMAN-23/ui-write-bridge", jsonPost({ body: "Keep the bridge CLI-backed." }));

    expect(calls).toEqual([
      {
        argv: ["chunk", "status", "FOREMAN-23/ui-write-bridge", "review", "--json"],
        cwd: repoRoot
      },
      {
        argv: ["chunk", "stage", "FOREMAN-23/ui-write-bridge", "implement", "--json"],
        cwd: repoRoot
      },
      {
        argv: ["chunk", "note", "FOREMAN-23/ui-write-bridge", "Ready for review.", "--json"],
        cwd: repoRoot
      },
      {
        argv: ["question", "add", "FOREMAN-23/ui-write-bridge", "Which UI control owns this?", "--json"],
        cwd: repoRoot
      },
      {
        argv: [
          "question",
          "answer",
          "FOREMAN-23/ui-write-bridge",
          "q_019e384e-bee7-77fc-943e-524ac04daca7",
          "Use the task detail view.",
          "--json"
        ],
        cwd: repoRoot
      },
      {
        argv: ["decision", "add", "FOREMAN-23/ui-write-bridge", "Keep the bridge CLI-backed.", "--json"],
        cwd: repoRoot
      }
    ]);
  });

  test("rejects invalid write request bodies before running commands", async () => {
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(createTempDir(), async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1 });
    });

    const malformed = await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });
    const missingField = await fetchJson(server, "/api/questions/FOREMAN-23/ui-write-bridge", jsonPost({ text: "Missing field." }));
    const emptyField = await fetchJson(server, "/api/decisions/FOREMAN-23/ui-write-bridge", jsonPost({ body: "   " }));
    const arrayBody = await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/stage", jsonPost(["implement"]));

    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("ui_invalid_request_body");
    expect(missingField.status).toBe(400);
    expect(missingField.body.error.details.field).toBe("body");
    expect(emptyField.status).toBe(400);
    expect(emptyField.body.error.details.field).toBe("body");
    expect(arrayBody.status).toBe(400);
    expect(arrayBody.body.error.code).toBe("ui_invalid_request_body");
    expect(calls).toEqual([]);
  });

  test("keeps method handling explicit for read and write routes", async () => {
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(createTempDir(), async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1 });
    });

    const readOnlyPost = await fetchJson(server, "/api/tasks", jsonPost({}));
    const writeOnlyGet = await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/status");

    expect(readOnlyPost.status).toBe(405);
    expect(readOnlyPost.body.error).toMatchObject({
      code: "ui_method_not_allowed",
      details: { method: "POST", allowed_methods: ["GET"] }
    });
    expect(writeOnlyGet.status).toBe(405);
    expect(writeOnlyGet.body.error).toMatchObject({
      code: "ui_method_not_allowed",
      details: { method: "GET", allowed_methods: ["POST"] }
    });
    expect(calls).toEqual([]);
  });

  test("rejects cross-origin and non-JSON write requests before running commands", async () => {
    const repoRoot = createTempDir();
    const calls: UiCommandRunnerInput[] = [];
    const server = startTestServer(repoRoot, async (input) => {
      calls.push(input);
      return jsonResult({ schema_version: 1, ok: true });
    });

    const sameOrigin = await fetchJson(
      server,
      "/api/chunks/FOREMAN-23/ui-write-bridge/status",
      jsonPost({ status: "review" }, { origin: new URL(server.url).origin, "sec-fetch-site": "same-origin" })
    );
    const crossOrigin = await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/stage", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: "https://example.invalid",
        "sec-fetch-site": "cross-site"
      },
      body: JSON.stringify({ stage: "implement" })
    });
    const nonJson = await fetchJson(
      server,
      "/api/chunks/FOREMAN-23/ui-write-bridge/notes",
      {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: new URL(server.url).origin,
          "sec-fetch-site": "same-origin"
        },
        body: JSON.stringify({ body: "Note." })
      }
    );

    expect(sameOrigin.status).toBe(200);
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error).toMatchObject({
      code: "ui_cross_origin_request",
      details: { origin: "https://example.invalid", expected_origin: new URL(server.url).origin }
    });
    expect(nonJson.status).toBe(415);
    expect(nonJson.body.error).toMatchObject({
      code: "ui_unsupported_media_type",
      details: { content_type: "text/plain" }
    });
    expect(calls).toEqual([
      {
        argv: ["chunk", "status", "FOREMAN-23/ui-write-bridge", "review", "--json"],
        cwd: repoRoot
      }
    ]);
  });

  test("maps write command failures and invalid JSON responses", async () => {
    const server = startTestServer(createTempDir(), async (input) => {
      if (input.argv[1] === "status") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: JSON.stringify({
            schema_version: 1,
            error: { code: "invalid_chunk_status", message: "bad status", exit_code: 2 }
          })
        };
      }

      return { exitCode: 0, stdout: "not-json", stderr: "" };
    });

    const failed = await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/status", jsonPost({ status: "bad" }));
    const invalidJson = await fetchJson(server, "/api/chunks/FOREMAN-23/ui-write-bridge/notes", jsonPost({ body: "Note." }));

    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatchObject({
      code: "ui_command_failed",
      exit_code: 2,
      details: {
        command: ["chunk", "status", "FOREMAN-23/ui-write-bridge", "bad", "--json"],
        stderr_json: {
          schema_version: 1,
          error: { code: "invalid_chunk_status" }
        },
        stderr: null
      }
    });
    expect(invalidJson.status).toBe(502);
    expect(invalidJson.body.error).toMatchObject({
      code: "ui_command_invalid_json",
      exit_code: 1,
      details: { command: ["chunk", "note", "FOREMAN-23/ui-write-bridge", "Note.", "--json"] }
    });
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

function jsonPost(value: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(value)
  };
}

async function fetchJson(server: ForemanUiServer, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, server.url), init);
  return { status: response.status, body: await response.json() };
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase23a-"));
  tempDirs.push(dir);
  return dir;
}
