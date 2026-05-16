import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openForemanDatabase } from "../src/db/client";
import { getDispatchRunDetailById } from "../src/db/dispatch-queries";
import { insertDispatchAttempt, insertDispatchRun } from "../src/db/dispatch-writes";
import { reconcileDispatchRun } from "../src/dispatch/reconcile";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 20a dispatch reconcile CLI", () => {
  test("marks a stale claimed run failed exactly once", () => {
    const homeDir = createTempDir();
    const repo = createGitRepo();
    const runId = "run_019ff000-0000-7000-8000-000000000001";
    seedDispatchRun(homeDir, {
      runId,
      status: "claimed",
      updatedAt: "2000-01-01T00:00:00.000Z"
    });

    const result = runForeman(repo, homeDir, ["dispatch", "reconcile", runId.slice(0, 18), "--older-than", "1m", "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.dispatch_run).toMatchObject({
      id: runId,
      status: "failed",
      finished_at: parsed.dispatch_run.updated_at
    });
    expect(parsed.reconciliation).toMatchObject({
      run_id: runId,
      attempt_id: null,
      previous_run_status: "claimed",
      previous_attempt_status: null,
      status: "failed",
      attempt_status: null,
      reason: "stale_claimed_without_attempts",
      changed: true,
      process_id: null,
      stale_after_ms: 60 * 1000
    });
    expect(parsed.dispatch_run.events.map((event: any) => event.type)).toEqual(["reconciled_failed"]);
    expect(JSON.parse(parsed.dispatch_run.events[0].data_json)).toMatchObject({
      previous_run_status: "claimed",
      previous_attempt_status: null,
      reason: "stale_claimed_without_attempts",
      changed: true
    });

    const again = JSON.parse(runForeman(repo, homeDir, ["dispatch", "reconcile", runId, "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.reconciliation.reason).toBe("already_terminal");
    expect(again.dispatch_run.events.map((event: any) => event.type)).toEqual(["reconciled_failed"]);
  });

  test("reconciles stale prepared and dead launched attempts", () => {
    const homeDir = createTempDir();
    const preparingRunId = "run_019ff000-0000-7000-8000-000000000002";
    const launchedRunId = "run_019ff000-0000-7000-8000-000000000003";
    seedDispatchRun(homeDir, {
      runId: preparingRunId,
      status: "running",
      updatedAt: "2026-05-12T10:00:00.000Z",
      attemptStatus: "preparing_workspace",
      processId: null
    });
    seedDispatchRun(homeDir, {
      runId: launchedRunId,
      status: "running",
      updatedAt: "2026-05-12T10:00:00.000Z",
      attemptStatus: "launching_agent",
      processId: 12345
    });

    const db = openForemanDatabase({ homeDir });
    try {
      const prepared = reconcileDispatchRun(db, preparingRunId, {
        repoName: "foreman",
        olderThanMs: 24 * 60 * 60 * 1000,
        now: () => "2026-05-14T10:00:00.000Z",
        idGenerator: () => "019ff000-0000-7000-8000-000000000002"
      });
      const launched = reconcileDispatchRun(db, launchedRunId, {
        repoName: "foreman",
        olderThanMs: 24 * 60 * 60 * 1000,
        now: () => "2026-05-14T10:00:00.000Z",
        idGenerator: () => "019ff000-0000-7000-8000-000000000003",
        processExists: () => false
      });

      expect(prepared.kind).toBe("reconciled");
      expect(launched.kind).toBe("reconciled");
      if (prepared.kind === "reconciled") {
        expect(prepared.reconciliation.reason).toBe("stale_preparing_workspace");
      }
      if (launched.kind === "reconciled") {
        expect(launched.reconciliation).toMatchObject({
          reason: "launch_process_dead",
          process_id: 12345
        });
      }

      const preparedDetail = getDispatchRunDetailById(db, preparingRunId);
      const launchedDetail = getDispatchRunDetailById(db, launchedRunId);
      expect(preparedDetail?.run.status).toBe("failed");
      expect(preparedDetail?.attempts[0]).toMatchObject({
        status: "failed",
        error_message: "Dispatch reconcile marked stale run failed: stale_preparing_workspace"
      });
      expect(launchedDetail?.run.status).toBe("failed");
      expect(launchedDetail?.attempts[0]).toMatchObject({
        status: "failed",
        error_message: "Dispatch reconcile marked stale run failed: launch_process_dead"
      });
    } finally {
      db.close();
    }
  });

  test("skips live, session-attached, and not-yet-stale attempts without mutation", () => {
    const homeDir = createTempDir();
    const liveRunId = "run_019ff000-0000-7000-8000-000000000004";
    const attachedRunId = "run_019ff000-0000-7000-8000-000000000005";
    const recentRunId = "run_019ff000-0000-7000-8000-000000000006";
    const sessionId = "018ff000-0000-7000-8000-000000000005";
    seedSession(homeDir, sessionId);
    seedDispatchRun(homeDir, {
      runId: liveRunId,
      status: "running",
      updatedAt: "2026-05-12T10:00:00.000Z",
      attemptStatus: "launching_agent",
      processId: 23456
    });
    seedDispatchRun(homeDir, {
      runId: attachedRunId,
      status: "running",
      updatedAt: "2026-05-12T10:00:00.000Z",
      attemptStatus: "launching_agent",
      processId: 34567,
      sessionId
    });
    seedDispatchRun(homeDir, {
      runId: recentRunId,
      status: "running",
      updatedAt: "2026-05-14T09:59:30.000Z",
      attemptStatus: "preparing_workspace",
      processId: null
    });

    const db = openForemanDatabase({ homeDir });
    try {
      const live = reconcileDispatchRun(db, liveRunId, {
        repoName: "foreman",
        olderThanMs: 24 * 60 * 60 * 1000,
        now: () => "2026-05-14T10:00:00.000Z",
        processExists: () => true
      });
      const attached = reconcileDispatchRun(db, attachedRunId, {
        repoName: "foreman",
        olderThanMs: 24 * 60 * 60 * 1000,
        now: () => "2026-05-14T10:00:00.000Z",
        processExists: () => false
      });
      const recent = reconcileDispatchRun(db, recentRunId, {
        repoName: "foreman",
        olderThanMs: 60 * 1000,
        now: () => "2026-05-14T10:00:00.000Z"
      });

      expect(live.kind).toBe("skipped");
      expect(attached.kind).toBe("skipped");
      expect(recent.kind).toBe("skipped");
      if (live.kind === "skipped") {
        expect(live.reconciliation.reason).toBe("process_alive");
      }
      if (attached.kind === "skipped") {
        expect(attached.reconciliation.reason).toBe("session_attached");
      }
      if (recent.kind === "skipped") {
        expect(recent.reconciliation.reason).toBe("not_stale");
      }
      expect(getDispatchRunDetailById(db, liveRunId)?.run.status).toBe("running");
      expect(getDispatchRunDetailById(db, attachedRunId)?.run.status).toBe("running");
      expect(getDispatchRunDetailById(db, recentRunId)?.run.status).toBe("running");
    } finally {
      db.close();
    }
  });

  test("--all reconciles current repo candidates and reports repo mismatches", () => {
    const homeDir = createTempDir();
    const repo = createGitRepo();
    const matchingRunId = "run_019ff000-0000-7000-8000-000000000007";
    const otherRepoRunId = "run_019ff000-0000-7000-8000-000000000008";
    seedDispatchRun(homeDir, {
      runId: matchingRunId,
      status: "claimed",
      updatedAt: "2000-01-01T00:00:00.000Z"
    });
    seedDispatchRun(homeDir, {
      runId: otherRepoRunId,
      repoName: "other-repo",
      status: "claimed",
      updatedAt: "2000-01-01T00:00:00.000Z"
    });

    const result = runForeman(repo, homeDir, ["dispatch", "reconcile", "--all", "--older-than", "1m", "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.reconciliations.map((entry: any) => entry.dispatch_run.id)).toEqual([otherRepoRunId, matchingRunId]);
    expect(parsed.reconciliations[0]).toMatchObject({
      kind: "repo_mismatch",
      changed: false,
      expected_repo_name: "other-repo",
      actual_repo_name: "foreman"
    });
    expect(parsed.reconciliations[1]).toMatchObject({
      kind: "reconciled",
      changed: true,
      reason: "stale_claimed_without_attempts"
    });

    const db = openForemanDatabase({ homeDir });
    try {
      expect(getDispatchRunDetailById(db, matchingRunId)?.run.status).toBe("failed");
      expect(getDispatchRunDetailById(db, otherRepoRunId)?.run.status).toBe("claimed");
    } finally {
      db.close();
    }
  });

  test("rejects invalid reconcile arguments", () => {
    const homeDir = createTempDir();
    const repo = createGitRepo();
    const runId = "run_019ff000-0000-7000-8000-000000000009";
    seedDispatchRun(homeDir, {
      runId,
      repoName: "other-repo",
      status: "claimed",
      updatedAt: "2000-01-01T00:00:00.000Z"
    });

    const missingTarget = JSON.parse(runForeman(repo, homeDir, ["dispatch", "reconcile", "--json"]).stderr);
    const bothTargets = JSON.parse(runForeman(repo, homeDir, ["dispatch", "reconcile", runId, "--all", "--json"]).stderr);
    const badDuration = JSON.parse(
      runForeman(repo, homeDir, ["dispatch", "reconcile", runId, "--older-than", "0s", "--json"]).stderr
    );
    const repoMismatch = JSON.parse(runForeman(repo, homeDir, ["dispatch", "reconcile", runId, "--json"]).stderr);

    expect(missingTarget.error.code).toBe("invalid_dispatch_reconcile_target");
    expect(bothTargets.error.code).toBe("invalid_dispatch_reconcile_target");
    expect(badDuration.error.code).toBe("invalid_dispatch_older_than");
    expect(repoMismatch.error.code).toBe("dispatch_repo_mismatch");
  });
});

function seedDispatchRun(
  homeDir: string,
  input: {
    runId: string;
    repoName?: string | null;
    status: string;
    updatedAt: string;
    attemptStatus?: string;
    processId?: number | null;
    sessionId?: string | null;
  }
): void {
  const db = openForemanDatabase({ homeDir });

  try {
    insertDispatchRun(db, {
      id: input.runId,
      repoName: input.repoName === undefined ? "foreman" : input.repoName,
      taskId: "FOREMAN-20",
      chunkId: "dispatch-reconcile-command",
      requestedStage: "implement",
      status: input.status,
      requestedBy: null,
      source: "cli",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: input.updatedAt,
      finishedAt: isTerminalStatus(input.status) ? input.updatedAt : null
    });

    if (input.attemptStatus !== undefined) {
      insertDispatchAttempt(db, {
        id: attemptIdFor(input.runId),
        runId: input.runId,
        attemptNumber: 1,
        status: input.attemptStatus,
        tool: "codex",
        workspacePath: "/tmp/foreman-worktrees/FOREMAN-20",
        worktreeBranch: "foreman/FOREMAN-20",
        processId: input.processId ?? null,
        startedAt: input.updatedAt,
        sessionId: input.sessionId ?? null
      });
    }
  } finally {
    db.close();
  }
}

function seedSession(homeDir: string, sessionId: string): void {
  const db = openForemanDatabase({ homeDir });

  try {
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
        "2026-05-12T10:00:00.000Z",
        "2026-05-12T10:05:00.000Z",
        "/tmp/foreman",
        "git@example.com:mkdevforge/foreman.git",
        "gpt-5.4-mini",
        "devbox",
        "dev@example.com",
        "2026-05-12T10:05:01.000Z"
      ]
    );
  } finally {
    db.close();
  }
}

function createGitRepo(): string {
  const repo = join(createTempDir(), "control");
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "dev@example.com"]);
  runGit(repo, ["config", "user.name", "Dev"]);
  runGit(repo, ["remote", "add", "origin", "git@example.com:mkdevforge/foreman.git"]);
  return repo;
}

function attemptIdFor(runId: string): string {
  return `attempt_${runId.slice("run_".length)}`;
}

function isTerminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
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

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["/usr/bin/git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  expect(result.exitCode, decodeOutput(result.stderr)).toBe(0);
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase20a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: Uint8Array | null): string {
  return output === null ? "" : decoder.decode(output);
}
