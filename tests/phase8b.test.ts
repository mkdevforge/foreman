import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openForemanDatabase } from "../src/db/client";
import { insertDispatchAttempt, insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

const runId = "run_019e1500-0000-7000-8000-000000000001";
const otherRunId = "run_019e1500-0000-7000-8000-000000000002";
const attemptId = "attempt_019e1500-0001-7000-8000-000000000001";
const sessionId = "018f5000-0000-7000-8000-000000000501";
const baseTs = "2026-05-11T00:00:00.000Z";

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 8b dispatch query CLI", () => {
  test("lists dispatch runs with attempts, events, and linked session data", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    seedDispatchData(homeDir);

    const result = runForeman(cwd, homeDir, ["dispatch", "list", "--task", "FOREMAN-8", "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.dispatch_runs.map((run: any) => run.id)).toEqual([runId]);
    expect(parsed.dispatch_runs[0]).toMatchObject({
      id: runId,
      task_id: "FOREMAN-8",
      chunk_id: "dispatch-query-surface",
      requested_stage: "implement",
      status: "running",
      requested_by: "local-user",
      source: "cli"
    });
    expect(parsed.dispatch_runs[0].attempts).toHaveLength(1);
    expect(parsed.dispatch_runs[0].attempts[0]).toMatchObject({
      id: attemptId,
      run_id: runId,
      attempt_number: 1,
      status: "streaming_turn",
      tool: "codex",
      session_id: sessionId,
      session: {
        id: sessionId,
        source: "codex",
        usage: { cost_usd: 0.42 },
        summary: { summary_md: "Implemented the query surface." },
        linked_chunks: [{ task_id: "FOREMAN-8", chunk_id: "dispatch-query-surface", stage: "implement" }]
      }
    });
    expect(parsed.dispatch_runs[0].events.map((event: any) => event.type)).toEqual(["queued", "attempt_started"]);

    const statusFiltered = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "list", "--status", "queued", "--json"]).stdout
    );
    expect(statusFiltered.dispatch_runs.map((run: any) => run.id)).toEqual([otherRunId]);

    const text = runForeman(cwd, homeDir, ["dispatch", "list", "--chunk", "missing"]);
    expect(text.stdout).toBe("No dispatch runs found.\n");
  });

  test("shows dispatch run detail and reports missing or ambiguous runs", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    seedDispatchData(homeDir);

    const shown = runForeman(cwd, homeDir, ["dispatch", "show", runId, "--json"]);
    const parsed = JSON.parse(shown.stdout);

    expect(shown.exitCode).toBe(0);
    expect(parsed.dispatch_run.id).toBe(runId);
    expect(parsed.dispatch_run.attempts[0].session.id).toBe(sessionId);
    expect(parsed.dispatch_run.events).toEqual([
      expect.objectContaining({ type: "queued", attempt_id: null, data_json: "{}" }),
      expect.objectContaining({ type: "attempt_started", attempt_id: attemptId, data_json: "{\"tool\":\"codex\"}" })
    ]);

    const text = runForeman(cwd, homeDir, ["dispatch", "show", runId]);
    expect(text.stdout).toContain(`Dispatch Run ${runId}\n`);
    expect(text.stdout).toContain("Attempts:\n");
    expect(text.stdout).toContain(`Session: ${sessionId}  codex`);
    expect(text.stdout).toContain("Events:\n");

    const ambiguous = JSON.parse(runForeman(cwd, homeDir, ["dispatch", "show", "run_019e1500", "--json"]).stderr);
    expect(ambiguous.error.code).toBe("ambiguous_dispatch_run_prefix");

    const missing = JSON.parse(runForeman(cwd, homeDir, ["dispatch", "show", "run_missing", "--json"]).stderr);
    expect(missing.error.code).toBe("dispatch_run_not_found");
  });
});

function seedDispatchData(homeDir: string): void {
  const db = openForemanDatabase({ homeDir });

  try {
    seedSession(db);
    expect(
      insertDispatchRun(db, {
        id: runId,
        taskId: "FOREMAN-8",
        chunkId: "dispatch-query-surface",
        requestedStage: "implement",
        status: "running",
        requestedBy: "local-user",
        source: "cli",
        createdAt: baseTs,
        updatedAt: "2026-05-11T00:02:00.000Z"
      })
    ).toBe(1);
    expect(
      insertDispatchAttempt(db, {
        id: attemptId,
        runId,
        attemptNumber: 1,
        status: "streaming_turn",
        tool: "codex",
        workspacePath: "/tmp/foreman-worktrees/FOREMAN-8-dispatch-query-surface",
        worktreeBranch: "foreman/FOREMAN-8-dispatch-query-surface",
        processId: 12345,
        startedAt: "2026-05-11T00:01:00.000Z",
        sessionId
      })
    ).toBe(1);
    expect(
      insertDispatchEvent(db, {
        id: "evt_019e1500-0002-7000-8000-000000000001",
        runId,
        ts: "2026-05-11T00:00:01.000Z",
        type: "queued",
        message: "Dispatch run queued.",
        dataJson: "{}"
      })
    ).toBe(1);
    expect(
      insertDispatchEvent(db, {
        id: "evt_019e1500-0003-7000-8000-000000000001",
        runId,
        attemptId,
        ts: "2026-05-11T00:01:01.000Z",
        type: "attempt_started",
        message: "Attempt started.",
        dataJson: "{\"tool\":\"codex\"}"
      })
    ).toBe(1);
    expect(
      insertDispatchRun(db, {
        id: otherRunId,
        taskId: "FOREMAN-9",
        chunkId: "other",
        requestedStage: "plan",
        status: "queued",
        requestedBy: null,
        source: "cli",
        createdAt: "2026-05-11T00:03:00.000Z",
        updatedAt: "2026-05-11T00:03:00.000Z"
      })
    ).toBe(1);
  } finally {
    db.close();
  }
}

function seedSession(db: Database): void {
  runSql(
    db,
    `INSERT INTO sessions (
      id,
      source,
      source_session_id,
      started_at,
      ended_at,
      project_path,
      repo_remote,
      model,
      machine,
      user_email,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      "codex",
      "codex-session-501",
      "2026-05-11T00:01:30.000Z",
      "2026-05-11T00:05:00.000Z",
      "/tmp/foreman",
      "git@github.com:mkdevforge/foreman.git",
      "gpt-5.4-mini",
      "devbox",
      "dev@example.com",
      "2026-05-11T00:05:01.000Z"
    ]
  );
  runSql(
    db,
    `INSERT INTO usage (
      session_id,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_creation_tokens,
      cost_usd
    ) VALUES (?, 100, 50, 0, 0, 0.42)`,
    [sessionId]
  );
  runSql(db, "INSERT INTO summaries (session_id, summary_md, model_used, generated_at) VALUES (?, ?, ?, ?)", [
    sessionId,
    "Implemented the query surface.",
    "summary-model",
    "2026-05-11T00:05:02.000Z"
  ]);
  runSql(
    db,
    `INSERT INTO session_chunks (
      session_id,
      task_id,
      chunk_id,
      stage,
      linked_at,
      linked_by
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, "FOREMAN-8", "dispatch-query-surface", "implement", "2026-05-11T00:05:03.000Z", "hook"]
  );
}

function runForeman(cwd: string, homeDir: string, argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
    env: { ...process.env, HOME: homeDir },
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase8b-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
