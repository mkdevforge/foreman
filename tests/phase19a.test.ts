import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { cleanupDispatchRun } from "../src/dispatch/cleanup";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 19a dispatch cleanup CLI", () => {
  test("removes a merged succeeded dispatch worktree exactly once", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);

    writeFileSync(join(workspace, "app.txt"), "cleaned app\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Implement cleanup fixture"]);
    expect(runForeman(repo, homeDir, ["dispatch", "merge", runId]).exitCode).toBe(0);

    const result = runForeman(repo, homeDir, ["dispatch", "cleanup", runId.slice(0, 18), "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.cleanup).toMatchObject({
      run_id: runId,
      workspace_path: workspace,
      worktree_branch: "foreman/FOREMAN-19",
      changed: true,
      workspace_removed: true,
      branch_deleted: true,
      branch_delete_skipped_reason: null,
      force: false
    });
    expect(existsSync(workspace)).toBe(false);
    expect(branchExists(repo, "foreman/FOREMAN-19")).toBe(false);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleanup_started")).toHaveLength(1);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleaned_up")).toHaveLength(1);

    const again = JSON.parse(runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.cleanup).toMatchObject({
      workspace_removed: false,
      branch_deleted: false,
      branch_delete_skipped_reason: "already_cleaned",
      cleaned_at: null
    });
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleanup_started")).toHaveLength(1);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleaned_up")).toHaveLength(1);
  });

  test("recovers a missing cleanup audit event after the worktree was already removed", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);

    writeFileSync(join(workspace, "app.txt"), "recover cleanup app\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Prepare recoverable cleanup"]);
    expect(runForeman(repo, homeDir, ["dispatch", "merge", runId]).exitCode).toBe(0);

    const db = openForemanDatabase({ homeDir });
    try {
      expect(() =>
        cleanupDispatchRun(db, runId, {
          controlRepoRoot: repo,
          repoName: "foreman",
          beforeFinalEventWrite: () => {
            throw new Error("simulated final event write failure");
          }
        })
      ).toThrow("simulated final event write failure");
    } finally {
      db.close();
    }

    expect(existsSync(workspace)).toBe(false);
    expect(branchExists(repo, "foreman/FOREMAN-19")).toBe(false);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleanup_started")).toHaveLength(1);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleaned_up")).toHaveLength(0);

    const recovered = JSON.parse(runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--json"]).stdout);
    expect(recovered.changed).toBe(true);
    expect(recovered.cleanup).toMatchObject({
      run_id: runId,
      changed: false,
      workspace_removed: true,
      branch_deleted: true,
      branch_delete_skipped_reason: null,
      audit_recovered: true,
      audit_recovery_reason: "cleanup_event_missing_after_git_side_effect"
    });
    expect(existsSync(workspace)).toBe(false);
    expect(branchExists(repo, "foreman/FOREMAN-19")).toBe(false);

    const events = eventRows(homeDir, runId);
    expect(events.filter((event) => event.type === "cleanup_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "cleaned_up")).toHaveLength(1);
    expect(JSON.parse(events.find((event) => event.type === "cleaned_up")!.data_json)).toMatchObject({
      audit_recovered: true,
      audit_recovery_reason: "cleanup_event_missing_after_git_side_effect"
    });

    const again = JSON.parse(runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.cleanup.audit_recovered).toBe(false);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleaned_up")).toHaveLength(1);
  });

  test("rejects unmerged succeeded work unless cleanup is forced", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);

    writeFileSync(join(workspace, "app.txt"), "unmerged app\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Leave branch unmerged"]);

    const rejected = runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--json"]);
    const parsedRejected = JSON.parse(rejected.stderr);

    expect(rejected.exitCode).toBe(2);
    expect(parsedRejected.error.code).toBe("dispatch_run_not_cleanupable");
    expect(parsedRejected.error.details.reason).toBe("branch_not_merged");
    expect(existsSync(workspace)).toBe(true);
    expect(branchExists(repo, "foreman/FOREMAN-19")).toBe(true);
    expect(eventTypes(homeDir, runId)).not.toContain("cleaned_up");

    const forced = JSON.parse(runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--force", "--json"]).stdout);
    expect(forced.changed).toBe(true);
    expect(forced.cleanup).toMatchObject({
      workspace_removed: true,
      branch_deleted: false,
      branch_delete_skipped_reason: "branch_delete_unsafe",
      force: true
    });
    expect(existsSync(workspace)).toBe(false);
    expect(branchExists(repo, "foreman/FOREMAN-19")).toBe(true);
  });

  test("rejects dirty failed workspaces unless cleanup is forced", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimAndPrepare(repo, homeDir);
    const workspace = expectedWorkspace(repo);
    markDispatchTerminal(homeDir, runId, "failed");
    writeFileSync(join(workspace, "failed.txt"), "uncommitted failure output\n", "utf8");

    const rejected = runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--json"]);
    const parsedRejected = JSON.parse(rejected.stderr);

    expect(rejected.exitCode).toBe(2);
    expect(parsedRejected.error.code).toBe("dispatch_run_not_cleanupable");
    expect(parsedRejected.error.details.reason).toBe("workspace_dirty");
    expect(existsSync(workspace)).toBe(true);
    expect(eventTypes(homeDir, runId)).not.toContain("cleaned_up");

    const forced = JSON.parse(runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--force", "--json"]).stdout);
    expect(forced.changed).toBe(true);
    expect(forced.cleanup).toMatchObject({
      workspace_removed: true,
      force: true
    });
    expect(existsSync(workspace)).toBe(false);
    expect(eventTypes(homeDir, runId).filter((type) => type === "cleaned_up")).toHaveLength(1);
  });

  test("rejects non-terminal dispatch runs without removing their worktree", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimAndPrepare(repo, homeDir);
    const workspace = expectedWorkspace(repo);

    const result = runForeman(repo, homeDir, ["dispatch", "cleanup", runId, "--json"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe("dispatch_run_not_cleanupable");
    expect(parsed.error.details.reason).toBe("run_status_not_terminal");
    expect(existsSync(workspace)).toBe(true);
    expect(eventTypes(homeDir, runId)).not.toContain("cleaned_up");
  });
});

function createClaimPrepareAndSucceed(repo: string, homeDir: string): string {
  const runId = createClaimAndPrepare(repo, homeDir);
  markDispatchTerminal(homeDir, runId, "succeeded");
  return runId;
}

function createClaimAndPrepare(repo: string, homeDir: string): string {
  const created = JSON.parse(
    runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-19/dispatch-cleanup-command", "--json"]).stdout
  );
  expect(runForeman(repo, homeDir, ["dispatch", "claim", created.dispatch_run.id, "--tool", "codex"]).exitCode).toBe(0);
  expect(runForeman(repo, homeDir, ["dispatch", "prepare", created.dispatch_run.id, "--json"]).exitCode).toBe(0);
  return created.dispatch_run.id;
}

function setupReadyRepo(): string {
  const root = createTempDir();
  const repo = join(root, "control");
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "dev@example.com"]);
  runGit(repo, ["config", "user.name", "Dev"]);
  runGit(repo, ["remote", "add", "origin", "git@example.com:mkdevforge/foreman.git"]);

  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, "Clean up terminal dispatch workspaces.\n", "utf8");
  writeFileSync(join(repo, "app.txt"), "initial app\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-19", "--title", "Dispatch cleanup"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-19/dispatch-cleanup-command",
      "--title",
      "Dispatch cleanup command",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-19/dispatch-cleanup-command", "implement"]).exitCode).toBe(0);

  const task = readTaskYaml(repo);
  task.chunks[0].dispatch = {
    status: "ready",
    risk_level: "low",
    approval_required: "none",
    allowed_actions: ["edit_source", "run_tests", "create_worktree"],
    blocked_actions: ["launch_runner"]
  };
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Initial Foreman task"]);

  return repo;
}

function markDispatchTerminal(homeDir: string, runId: string, status: "succeeded" | "failed"): void {
  const db = openForemanDatabase({ homeDir });

  try {
    runSql(db, "UPDATE dispatch_runs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?", [
      status,
      "2026-05-15T01:00:00.000Z",
      "2026-05-15T01:00:00.000Z",
      runId
    ]);
    runSql(db, "UPDATE dispatch_attempts SET status = ?, ended_at = ? WHERE run_id = ?", [
      status,
      "2026-05-15T01:00:00.000Z",
      runId
    ]);
  } finally {
    db.close();
  }
}

function eventTypes(homeDir: string, runId: string): string[] {
  return eventRows(homeDir, runId).map((row) => row.type);
}

function eventRows(homeDir: string, runId: string): { type: string; data_json: string }[] {
  const db = openForemanDatabase({ homeDir });

  try {
    return db
      .query<{ type: string; data_json: string }, [string]>(
        "SELECT type, data_json FROM dispatch_events WHERE run_id = ? ORDER BY ts ASC, id ASC"
      )
      .all(runId);
  } finally {
    db.close();
  }
}

function branchExists(cwd: string, branch: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  return result.exitCode === 0;
}

function expectedWorkspace(repo: string): string {
  return join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-19");
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
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(decodeOutput(result.stderr));
  }
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-19.yaml");
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase19a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
