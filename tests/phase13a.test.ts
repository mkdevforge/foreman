import { afterEach, describe, expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openForemanDatabase } from "../src/db/client";
import { getDispatchRunDetailById } from "../src/db/dispatch-queries";
import { insertDispatchAttempt, insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";
import { finishDispatchRun } from "../src/dispatch/finish";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 13a dispatch finish CLI", () => {
  test("finishes a session-attached running attempt exactly once", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    const runId = "run_019fe000-0000-7000-8000-000000000001";
    seedRunningRun(homeDir, { runId, sessionId: "018fe000-0000-7000-8000-000000000001" });

    const finished = runForeman(cwd, homeDir, ["dispatch", "finish", runId.slice(0, 18), "--status", "succeeded", "--json"]);
    const parsed = JSON.parse(finished.stdout);

    expect(finished.exitCode).toBe(0);
    expect(finished.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.dispatch_run).toMatchObject({
      id: runId,
      status: "succeeded",
      finished_at: parsed.dispatch_run.updated_at
    });
    expect(parsed.dispatch_run.attempts[0]).toMatchObject({
      status: "succeeded",
      session_id: "018fe000-0000-7000-8000-000000000001",
      ended_at: parsed.dispatch_run.finished_at,
      error_message: null
    });
    expect(parsed.dispatch_run.events.map((event: any) => event.type)).toEqual(["agent_launched", "succeeded"]);
    expect(JSON.parse(parsed.dispatch_run.events[1].data_json)).toEqual({
      previous_run_status: "running",
      previous_attempt_status: "launching_agent",
      status: "succeeded",
      session_id: "018fe000-0000-7000-8000-000000000001",
      message: null
    });

    const again = JSON.parse(runForeman(cwd, homeDir, ["dispatch", "finish", runId, "--status", "succeeded", "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.dispatch_run.events.map((event: any) => event.type)).toEqual(["agent_launched", "succeeded"]);
  });

  test("finishes failed attempts with an error message", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    const runId = "run_019fe000-0000-7000-8000-000000000002";
    seedRunningRun(homeDir, { runId, sessionId: "018fe000-0000-7000-8000-000000000002" });

    const failed = runForeman(cwd, homeDir, [
      "dispatch",
      "finish",
      runId,
      "--status",
      "failed",
      "--message",
      "Tests failed",
      "--json"
    ]);
    const parsed = JSON.parse(failed.stdout);

    expect(failed.exitCode).toBe(0);
    expect(parsed.changed).toBe(true);
    expect(parsed.dispatch_run.status).toBe("failed");
    expect(parsed.dispatch_run.attempts[0]).toMatchObject({
      status: "failed",
      error_message: "Tests failed"
    });
    expect(JSON.parse(parsed.dispatch_run.events[1].data_json)).toMatchObject({
      status: "failed",
      message: "Tests failed"
    });
  });

  test("rejects unfinished shapes without mutating rows", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    const missingSessionRunId = "run_019fe000-0000-7000-8000-000000000003";
    const multipleAttemptsRunId = "run_019fe000-0000-7000-8000-000000000004";
    const alreadySucceededRunId = "run_019fe000-0000-7000-8000-000000000005";
    const terminalMismatchRunId = "run_019fe000-0000-7000-8000-000000000007";
    seedRunningRun(homeDir, { runId: missingSessionRunId, sessionId: null });
    seedRunningRun(homeDir, {
      runId: multipleAttemptsRunId,
      sessionId: "018fe000-0000-7000-8000-000000000004",
      attempts: 2
    });
    seedRunningRun(homeDir, {
      runId: alreadySucceededRunId,
      runStatus: "succeeded",
      attemptStatus: "succeeded",
      sessionId: "018fe000-0000-7000-8000-000000000005"
    });
    seedRunningRun(homeDir, {
      runId: terminalMismatchRunId,
      runStatus: "succeeded",
      attemptStatus: "failed",
      sessionId: "018fe000-0000-7000-8000-000000000007"
    });

    const missingSession = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "finish", missingSessionRunId, "--status", "succeeded", "--json"]).stderr
    );
    const multipleAttempts = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "finish", multipleAttemptsRunId, "--status", "succeeded", "--json"]).stderr
    );
    const alreadyDifferent = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "finish", alreadySucceededRunId, "--status", "failed", "--json"]).stderr
    );
    const invalidStatus = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "finish", missingSessionRunId, "--status", "done", "--json"]).stderr
    );
    const terminalMismatch = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "finish", terminalMismatchRunId, "--status", "succeeded", "--json"]).stderr
    );

    expect(missingSession.error.code).toBe("dispatch_run_not_finishable");
    expect(missingSession.error.details.reason).toBe("missing_session");
    expect(multipleAttempts.error.details.reason).toBe("multiple_attempts");
    expect(alreadyDifferent.error.details.reason).toBe("already_finished_with_different_status");
    expect(invalidStatus.error.code).toBe("invalid_dispatch_finish_status");
    expect(terminalMismatch.error.details.reason).toBe("terminal_state_mismatch");

    const shown = JSON.parse(runForeman(cwd, homeDir, ["dispatch", "show", missingSessionRunId, "--json"]).stdout);
    expect(shown.dispatch_run.status).toBe("running");
    expect(shown.dispatch_run.events.map((event: any) => event.type)).toEqual(["agent_launched"]);
  });

  test("does not append a terminal event when the launching status is lost before update", () => {
    const homeDir = createTempDir();
    const runId = "run_019fe000-0000-7000-8000-000000000006";
    const attemptId = attemptIdFor(runId, 1);
    seedRunningRun(homeDir, { runId, sessionId: "018fe000-0000-7000-8000-000000000006" });
    const db = openForemanDatabase({ homeDir });

    try {
      const result = finishDispatchRun(db, runId, {
        status: "succeeded",
        idGenerator: () => "019fe000-0000-7000-8000-000000000006",
        now: () => {
          db.prepare("UPDATE dispatch_attempts SET status = ? WHERE id = ?").run("failed", attemptId);
          return "2026-05-12T20:00:00.000Z";
        }
      });

      expect(result.kind).toBe("not_finishable");
      if (result.kind === "not_finishable") {
        expect(result.reason).toBe("status_changed");
      }

      const detail = getDispatchRunDetailById(db, runId);
      expect(detail?.run.status).toBe("running");
      expect(detail?.attempts[0].status).toBe("launching_agent");
      expect(detail?.events.map((event) => event.type)).toEqual(["agent_launched"]);
    } finally {
      db.close();
    }
  });
});

function seedRunningRun(
  homeDir: string,
  input: {
    runId: string;
    runStatus?: string;
    attemptStatus?: string;
    sessionId: string | null;
    attempts?: number;
  }
): void {
  const db = openForemanDatabase({ homeDir });
  const attempts = input.attempts ?? 1;

  try {
    if (input.sessionId !== null) {
      seedSession(db, input.sessionId);
    }

    insertDispatchRun(db, {
      id: input.runId,
      repoName: "foreman",
      taskId: "FOREMAN-13",
      chunkId: "dispatch-finish-command",
      requestedStage: "review",
      status: input.runStatus ?? "running",
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-12T19:00:00.000Z",
      updatedAt: "2026-05-12T19:01:00.000Z",
      finishedAt: isTerminal(input.runStatus) ? "2026-05-12T19:02:00.000Z" : null
    });

    for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
      insertDispatchAttempt(db, {
        id: attemptIdFor(input.runId, attemptNumber),
        runId: input.runId,
        attemptNumber,
        status: input.attemptStatus ?? "launching_agent",
        tool: "codex",
        workspacePath: "/tmp/foreman-worktrees/FOREMAN-13",
        worktreeBranch: "foreman/FOREMAN-13",
        processId: 123,
        startedAt: "2026-05-12T19:01:00.000Z",
        endedAt: isTerminal(input.attemptStatus) ? "2026-05-12T19:02:00.000Z" : null,
        sessionId: input.sessionId
      });
    }

    insertDispatchEvent(db, {
      id: input.runId.replace(/^run_/, "evt_"),
      runId: input.runId,
      attemptId: attemptIdFor(input.runId, 1),
      ts: "2026-05-12T19:01:00.000Z",
      type: "agent_launched",
      message: "Seeded launch event.",
      dataJson: "{}"
    });
  } finally {
    db.close();
  }
}

function seedSession(db: ReturnType<typeof openForemanDatabase>, sessionId: string): void {
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
      sessionId,
      "2026-05-12T19:01:00.000Z",
      "2026-05-12T19:05:00.000Z",
      "/tmp/foreman",
      "git@example.com:mkdevforge/foreman.git",
      "gpt-5.4-mini",
      "devbox",
      "dev@example.com",
      "2026-05-12T19:05:01.000Z"
    ]
  );
}

function attemptIdFor(runId: string, attemptNumber: number): string {
  return `attempt_${runId.slice("run_".length)}_${attemptNumber}`;
}

function isTerminal(status: string | undefined): boolean {
  return status === "succeeded" || status === "failed";
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

function runSql(db: ReturnType<typeof openForemanDatabase>, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase13a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
