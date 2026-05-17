import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { mergeDispatchRun } from "../src/dispatch/merge";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 18a dispatch merge CLI", () => {
  test("fast-forward merges a succeeded clean dispatch branch exactly once", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);

    writeFileSync(join(workspace, "app.txt"), "merged app\n", "utf8");
    writeFileSync(join(workspace, "feature.txt"), "new feature\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Implement dispatch merge fixture"]);
    const previousHead = gitOutput(repo, ["rev-parse", "HEAD"]);
    const branchHead = gitOutput(workspace, ["rev-parse", "HEAD"]);

    const result = runForeman(repo, homeDir, ["dispatch", "merge", runId.slice(0, 18), "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.merge).toMatchObject({
      run_id: runId,
      workspace_path: workspace,
      worktree_branch: "foreman/FOREMAN-18",
      previous_head: previousHead,
      new_head: branchHead,
      merged_sha: branchHead,
      changed: true,
      fast_forward: true
    });
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("merged app\n");
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("new feature\n");
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(branchHead);
    expect(eventTypes(homeDir, runId).filter((type) => type === "merge_started")).toHaveLength(1);
    expect(eventTypes(homeDir, runId).filter((type) => type === "merged")).toHaveLength(1);

    const again = JSON.parse(runForeman(repo, homeDir, ["dispatch", "merge", runId, "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.merge).toMatchObject({
      previous_head: branchHead,
      new_head: branchHead,
      changed: false,
      merged_at: null
    });
    expect(eventTypes(homeDir, runId).filter((type) => type === "merge_started")).toHaveLength(1);
    expect(eventTypes(homeDir, runId).filter((type) => type === "merged")).toHaveLength(1);
  });

  test("recovers a missing merge audit event after the Git fast-forward already happened", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);

    writeFileSync(join(workspace, "app.txt"), "recovered app\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Prepare recoverable merge"]);
    const branchHead = gitOutput(workspace, ["rev-parse", "HEAD"]);

    const db = openForemanDatabase({ homeDir });
    try {
      expect(() =>
        mergeDispatchRun(db, runId, {
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

    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(branchHead);
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("recovered app\n");
    expect(eventTypes(homeDir, runId).filter((type) => type === "merge_started")).toHaveLength(1);
    expect(eventTypes(homeDir, runId).filter((type) => type === "merged")).toHaveLength(0);

    const recovered = JSON.parse(runForeman(repo, homeDir, ["dispatch", "merge", runId, "--json"]).stdout);
    expect(recovered.changed).toBe(true);
    expect(recovered.merge).toMatchObject({
      run_id: runId,
      changed: false,
      fast_forward: true,
      audit_recovered: true,
      audit_recovery_reason: "merge_event_missing_after_git_side_effect"
    });
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(branchHead);

    const events = eventRows(homeDir, runId);
    expect(events.filter((event) => event.type === "merge_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "merged")).toHaveLength(1);
    expect(JSON.parse(events.find((event) => event.type === "merged")!.data_json)).toMatchObject({
      audit_recovered: true,
      audit_recovery_reason: "merge_event_missing_after_git_side_effect"
    });

    const again = JSON.parse(runForeman(repo, homeDir, ["dispatch", "merge", runId, "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.merge.audit_recovered).toBe(false);
    expect(eventTypes(homeDir, runId).filter((type) => type === "merged")).toHaveLength(1);
  });

  test("rejects dirty dispatch workspaces and dirty control repos without merging", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const dirtyWorkspaceRunId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);
    writeFileSync(join(workspace, "app.txt"), "uncommitted app\n", "utf8");

    const dirtyWorkspace = runForeman(repo, homeDir, ["dispatch", "merge", dirtyWorkspaceRunId, "--json"]);
    const parsedDirtyWorkspace = JSON.parse(dirtyWorkspace.stderr);

    expect(dirtyWorkspace.exitCode).toBe(2);
    expect(parsedDirtyWorkspace.error.code).toBe("dispatch_run_not_mergeable");
    expect(parsedDirtyWorkspace.error.details.reason).toBe("workspace_dirty");
    expect(readFileSync(join(repo, "app.txt"), "utf8")).toBe("initial app\n");
    expect(eventTypes(homeDir, dirtyWorkspaceRunId)).not.toContain("merged");

    runGit(workspace, ["checkout", "--", "app.txt"]);
    const dirtyControlRunId = createClaimPrepareAndSucceed(repo, homeDir);
    writeFileSync(join(expectedWorkspace(repo), "app.txt"), "committed app\n", "utf8");
    runGit(expectedWorkspace(repo), ["add", "."]);
    runGit(expectedWorkspace(repo), ["commit", "-m", "Prepare clean workspace branch"]);
    writeFileSync(join(repo, "local.txt"), "dirty control\n", "utf8");

    const dirtyControl = runForeman(repo, homeDir, ["dispatch", "merge", dirtyControlRunId, "--json"]);
    const parsedDirtyControl = JSON.parse(dirtyControl.stderr);

    expect(dirtyControl.exitCode).toBe(2);
    expect(parsedDirtyControl.error.code).toBe("dispatch_run_not_mergeable");
    expect(parsedDirtyControl.error.details.reason).toBe("control_repo_dirty");
    expect(existsSync(join(repo, "local.txt"))).toBe(true);
    expect(eventTypes(homeDir, dirtyControlRunId)).not.toContain("merged");
  });

  test("rejects non-succeeded and non-fast-forward runs without mutating control history", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runningRunId = createClaimAndPrepare(repo, homeDir);

    const running = runForeman(repo, homeDir, ["dispatch", "merge", runningRunId, "--json"]);
    const parsedRunning = JSON.parse(running.stderr);
    expect(running.exitCode).toBe(2);
    expect(parsedRunning.error.details.reason).toBe("run_status_not_succeeded");

    const divergedRunId = createClaimPrepareAndSucceed(repo, homeDir);
    const workspace = expectedWorkspace(repo);
    writeFileSync(join(workspace, "app.txt"), "workspace branch\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Change workspace branch"]);

    writeFileSync(join(repo, "control.txt"), "control branch\n", "utf8");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "Diverge control branch"]);
    const controlHead = gitOutput(repo, ["rev-parse", "HEAD"]);

    const diverged = runForeman(repo, homeDir, ["dispatch", "merge", divergedRunId, "--json"]);
    const parsedDiverged = JSON.parse(diverged.stderr);

    expect(diverged.exitCode).toBe(2);
    expect(parsedDiverged.error.code).toBe("dispatch_run_not_mergeable");
    expect(parsedDiverged.error.details.reason).toBe("non_fast_forward");
    expect(gitOutput(repo, ["rev-parse", "HEAD"])).toBe(controlHead);
    expect(eventTypes(homeDir, divergedRunId)).not.toContain("merged");
  });
});

function createClaimPrepareAndSucceed(repo: string, homeDir: string): string {
  const runId = createClaimAndPrepare(repo, homeDir);
  markDispatchSucceeded(homeDir, runId);
  return runId;
}

function createClaimAndPrepare(repo: string, homeDir: string): string {
  const created = JSON.parse(
    runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-18/dispatch-merge-command", "--json"]).stdout
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
  writeFileSync(specPath, "Merge reviewed dispatch work.\n", "utf8");
  writeFileSync(join(repo, "app.txt"), "initial app\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-18", "--title", "Dispatch merge"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-18/dispatch-merge-command",
      "--title",
      "Dispatch merge command",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-18/dispatch-merge-command", "implement"]).exitCode).toBe(0);

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

function markDispatchSucceeded(homeDir: string, runId: string): void {
  const db = openForemanDatabase({ homeDir });

  try {
    runSql(db, "UPDATE dispatch_runs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?", [
      "succeeded",
      "2026-05-15T01:00:00.000Z",
      "2026-05-15T01:00:00.000Z",
      runId
    ]);
    runSql(db, "UPDATE dispatch_attempts SET status = ?, ended_at = ? WHERE run_id = ?", [
      "succeeded",
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

function expectedWorkspace(repo: string): string {
  return join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-18");
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

function gitOutput(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(decodeOutput(result.stderr));
  }

  return decodeOutput(result.stdout).trim();
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-18.yaml");
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase18a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
