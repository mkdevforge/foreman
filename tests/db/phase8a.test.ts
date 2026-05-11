import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openForemanDatabase } from "../../src/db/client";
import {
  getDispatchRunById,
  listDispatchAttemptsForRun,
  listDispatchEventsForRun,
  listDispatchRuns
} from "../../src/db/dispatch-queries";
import {
  insertDispatchAttempt,
  insertDispatchEvent,
  insertDispatchRun,
  updateDispatchAttemptStatus,
  updateDispatchRunStatus
} from "../../src/db/dispatch-writes";

const tempDirs: string[] = [];
const baseTs = "2026-05-11T00:00:00.000Z";

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-dispatch-db-test-"));
  tempDirs.push(dir);
  return dir;
}

function openTempDatabase(): Database {
  return openForemanDatabase({ databasePath: join(createTempDir(), "foreman.db") });
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function tableCount(db: Database, table: string): number {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();

  expect(row).not.toBeNull();
  return row!.count;
}

function seedSession(db: Database, id = "session-1"): string {
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
      id,
      "codex",
      `${id}-source`,
      baseTs,
      "2026-05-11T00:05:00.000Z",
      "/tmp/foreman-project",
      "git@example.com:mkdevforge/foreman.git",
      "gpt-5.4-mini",
      "dev-machine",
      "dev@example.com",
      baseTs
    ]
  );

  return id;
}

function insertRun(db: Database, id = "run_019e1500-0000-7000-8000-000000000001"): string {
  expect(
    insertDispatchRun(db, {
      id,
      taskId: "FOREMAN-8",
      chunkId: "sqlite-dispatch-schema",
      requestedStage: "implement",
      status: "queued",
      requestedBy: "dev@example.com",
      source: "cli",
      createdAt: baseTs,
      updatedAt: baseTs
    })
  ).toBe(1);

  return id;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 8a dispatch persistence foundation", () => {
  test("writes and queries dispatch runs, attempts, and nullable run-level events", () => {
    const db = openTempDatabase();

    try {
      const sessionId = seedSession(db);
      const runId = insertRun(db);

      expect(
        insertDispatchAttempt(db, {
          id: "attempt_019e1500-0001-7000-8000-000000000001",
          runId,
          attemptNumber: 1,
          status: "streaming_turn",
          tool: "codex",
          workspacePath: "/tmp/foreman-worktrees/FOREMAN-8-sqlite-dispatch-schema",
          worktreeBranch: "foreman/FOREMAN-8-sqlite-dispatch-schema",
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
          attemptId: "attempt_019e1500-0001-7000-8000-000000000001",
          ts: "2026-05-11T00:01:01.000Z",
          type: "attempt_started",
          message: "Attempt started.",
          dataJson: "{\"tool\":\"codex\"}"
        })
      ).toBe(1);

      expect(getDispatchRunById(db, runId)).toMatchObject({
        id: runId,
        task_id: "FOREMAN-8",
        chunk_id: "sqlite-dispatch-schema",
        requested_stage: "implement",
        status: "queued",
        requested_by: "dev@example.com",
        source: "cli",
        created_at: baseTs,
        updated_at: baseTs,
        finished_at: null
      });
      expect(listDispatchRuns(db, { taskId: "FOREMAN-8", chunkId: "sqlite-dispatch-schema" }).map((run) => run.id)).toEqual([
        runId
      ]);
      expect(listDispatchAttemptsForRun(db, runId)).toEqual([
        {
          id: "attempt_019e1500-0001-7000-8000-000000000001",
          run_id: runId,
          attempt_number: 1,
          status: "streaming_turn",
          tool: "codex",
          workspace_path: "/tmp/foreman-worktrees/FOREMAN-8-sqlite-dispatch-schema",
          worktree_branch: "foreman/FOREMAN-8-sqlite-dispatch-schema",
          process_id: 12345,
          started_at: "2026-05-11T00:01:00.000Z",
          ended_at: null,
          error_message: null,
          session_id: sessionId
        }
      ]);
      expect(listDispatchEventsForRun(db, runId)).toEqual([
        {
          id: "evt_019e1500-0002-7000-8000-000000000001",
          run_id: runId,
          attempt_id: null,
          ts: "2026-05-11T00:00:01.000Z",
          type: "queued",
          message: "Dispatch run queued.",
          data_json: "{}"
        },
        {
          id: "evt_019e1500-0003-7000-8000-000000000001",
          run_id: runId,
          attempt_id: "attempt_019e1500-0001-7000-8000-000000000001",
          ts: "2026-05-11T00:01:01.000Z",
          type: "attempt_started",
          message: "Attempt started.",
          data_json: "{\"tool\":\"codex\"}"
        }
      ]);
    } finally {
      db.close();
    }
  });

  test("updates run and attempt terminal state without duplicating rows", () => {
    const db = openTempDatabase();

    try {
      const runId = insertRun(db);
      expect(
        insertDispatchAttempt(db, {
          id: "attempt_019e1500-0001-7000-8000-000000000001",
          runId,
          attemptNumber: 1,
          status: "streaming_turn",
          tool: "claude-code",
          startedAt: "2026-05-11T00:01:00.000Z"
        })
      ).toBe(1);

      expect(
        updateDispatchAttemptStatus(db, {
          id: "attempt_019e1500-0001-7000-8000-000000000001",
          status: "succeeded",
          endedAt: "2026-05-11T00:02:00.000Z"
        })
      ).toBe(1);
      expect(
        updateDispatchRunStatus(db, {
          id: runId,
          status: "succeeded",
          updatedAt: "2026-05-11T00:02:01.000Z",
          finishedAt: "2026-05-11T00:02:01.000Z"
        })
      ).toBe(1);

      expect(getDispatchRunById(db, runId)).toMatchObject({
        status: "succeeded",
        updated_at: "2026-05-11T00:02:01.000Z",
        finished_at: "2026-05-11T00:02:01.000Z"
      });
      expect(listDispatchAttemptsForRun(db, runId)[0]).toMatchObject({
        status: "succeeded",
        ended_at: "2026-05-11T00:02:00.000Z",
        error_message: null
      });
    } finally {
      db.close();
    }
  });

  test("enforces run attempt uniqueness and foreign key behavior", () => {
    const db = openTempDatabase();

    try {
      const sessionId = seedSession(db);
      const runId = insertRun(db);
      expect(
        insertDispatchAttempt(db, {
          id: "attempt_019e1500-0001-7000-8000-000000000001",
          runId,
          attemptNumber: 1,
          status: "streaming_turn",
          tool: "codex",
          sessionId
        })
      ).toBe(1);
      expect(() =>
        insertDispatchAttempt(db, {
          id: "attempt_019e1500-0001-7000-8000-000000000002",
          runId,
          attemptNumber: 1,
          status: "streaming_turn",
          tool: "codex"
        })
      ).toThrow("UNIQUE constraint failed");
      expect(() =>
        insertDispatchEvent(db, {
          id: "evt_019e1500-0002-7000-8000-000000000001",
          runId: "missing-run",
          ts: baseTs,
          type: "queued",
          message: "Invalid event.",
          dataJson: "{}"
        })
      ).toThrow("FOREIGN KEY constraint failed");

      runSql(db, "DELETE FROM sessions WHERE id = ?", [sessionId]);
      expect(listDispatchAttemptsForRun(db, runId)[0].session_id).toBeNull();

      expect(
        insertDispatchEvent(db, {
          id: "evt_019e1500-0003-7000-8000-000000000001",
          runId,
          attemptId: "attempt_019e1500-0001-7000-8000-000000000001",
          ts: "2026-05-11T00:01:00.000Z",
          type: "attempt_started",
          message: "Attempt started.",
          dataJson: "{}"
        })
      ).toBe(1);
      runSql(db, "DELETE FROM dispatch_attempts WHERE id = ?", ["attempt_019e1500-0001-7000-8000-000000000001"]);
      expect(listDispatchEventsForRun(db, runId)[0].attempt_id).toBeNull();

      runSql(db, "DELETE FROM dispatch_runs WHERE id = ?", [runId]);
      expect(tableCount(db, "dispatch_runs")).toBe(0);
      expect(tableCount(db, "dispatch_attempts")).toBe(0);
      expect(tableCount(db, "dispatch_events")).toBe(0);
    } finally {
      db.close();
    }
  });
});
