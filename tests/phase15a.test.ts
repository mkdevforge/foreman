import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { getDispatchRunDetailById } from "../src/db/dispatch-queries";
import { insertDispatchAttempt, insertDispatchRun } from "../src/db/dispatch-writes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 15a dispatch workspace inspection CLI", () => {
  test("inspects a prepared workspace and prints tracked diff modes", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimAndPrepare(repo, homeDir);
    const expectedWorkspace = join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-17");

    writeFileSync(join(expectedWorkspace, "app.txt"), "changed app\n", "utf8");
    writeFileSync(join(expectedWorkspace, "notes.txt"), "untracked note\n", "utf8");

    const inspected = runForeman(repo, homeDir, ["dispatch", "workspace", runId.slice(0, 18), "--json"]);
    const parsed = JSON.parse(inspected.stdout);

    expect(inspected.exitCode).toBe(0);
    expect(inspected.stderr).toBe("");
    expect(parsed.dispatch_run.id).toBe(runId);
    expect(parsed.workspace).toMatchObject({
      run_id: runId,
      workspace_path: expectedWorkspace,
      expected_branch: "foreman/FOREMAN-17",
      git_root: expectedWorkspace,
      branch: "foreman/FOREMAN-17",
      branch_matches: true,
      dirty: true,
      upstream: null,
      ahead: null,
      behind: null
    });
    expect(parsed.workspace.changed_files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "app.txt", index_status: " ", worktree_status: "M" }),
        expect.objectContaining({ path: "notes.txt", index_status: "?", worktree_status: "?" })
      ])
    );
    expect(parsed.workspace.untracked_files).toEqual(["notes.txt"]);
    expect(parsed.workspace.recent_commits[0]).toMatchObject({
      short_hash: expect.any(String),
      subject: "Initial Foreman task"
    });

    const full = runForeman(repo, homeDir, ["dispatch", "diff", runId, "--json"]);
    const fullParsed = JSON.parse(full.stdout);
    expect(full.exitCode).toBe(0);
    expect(fullParsed.diff.mode).toBe("full");
    expect(fullParsed.diff.text).toContain("-initial app");
    expect(fullParsed.diff.text).toContain("+changed app");

    const stat = runForeman(repo, homeDir, ["dispatch", "diff", runId, "--stat"]);
    expect(stat.exitCode).toBe(0);
    expect(stat.stdout).toContain("app.txt");

    const nameOnly = runForeman(repo, homeDir, ["dispatch", "diff", runId, "--name-only", "--json"]);
    const nameOnlyParsed = JSON.parse(nameOnly.stdout);
    expect(nameOnlyParsed.diff).toEqual({ mode: "name_only", text: "app.txt\n" });
  });

  test("reports unsupported attempt states as inspectable command errors without DB mutation", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    seedRun(homeDir, "run_019f7000-0000-7000-8000-000000000001", []);
    seedRun(homeDir, "run_019f7000-0000-7000-8000-000000000002", [
      { id: "attempt_019f7000-0000-7000-8000-000000000002", workspacePath: null, worktreeBranch: "foreman/FOREMAN-17" }
    ]);
    seedRun(homeDir, "run_019f7000-0000-7000-8000-000000000003", [
      { id: "attempt_019f7000-0000-7000-8000-000000000003", workspacePath: "/tmp/a", worktreeBranch: "foreman/FOREMAN-17" },
      { id: "attempt_019f7000-0000-7000-8000-000000000004", workspacePath: "/tmp/b", worktreeBranch: "foreman/FOREMAN-17" }
    ]);

    expectWorkspaceError(repo, homeDir, "run_019f7000-0000-7000-8000-000000000001", "missing_attempt");
    expectWorkspaceError(repo, homeDir, "run_019f7000-0000-7000-8000-000000000002", "missing_workspace_path");
    expectWorkspaceError(repo, homeDir, "run_019f7000-0000-7000-8000-000000000003", "multiple_attempts");

    expect(getDispatchRun(homeDir, "run_019f7000-0000-7000-8000-000000000001")?.run.status).toBe("running");
    expect(getDispatchRun(homeDir, "run_019f7000-0000-7000-8000-000000000002")?.attempts[0].workspace_path).toBeNull();
  });

  test("rejects branch mismatches and invalid diff mode combinations", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const runId = createClaimAndPrepare(repo, homeDir);
    const workspacePath = join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-17");

    runGit(workspacePath, ["checkout", "-b", "other"]);
    const mismatch = runForeman(repo, homeDir, ["dispatch", "workspace", runId, "--json"]);
    const parsedMismatch = JSON.parse(mismatch.stderr);

    expect(mismatch.exitCode).toBe(2);
    expect(mismatch.stdout).toBe("");
    expect(parsedMismatch.error.code).toBe("dispatch_workspace_uninspectable");
    expect(parsedMismatch.error.details.reason).toBe("branch_mismatch");
    expect(parsedMismatch.error.details.expected_branch).toBe("foreman/FOREMAN-17");
    expect(parsedMismatch.error.details.actual_branch).toBe("other");

    const invalid = runForeman(repo, homeDir, ["dispatch", "diff", runId, "--stat", "--name-only", "--json"]);
    const parsedInvalid = JSON.parse(invalid.stderr);
    expect(invalid.exitCode).toBe(2);
    expect(parsedInvalid.error.code).toBe("invalid_dispatch_diff_options");
  });
});

function createClaimAndPrepare(repo: string, homeDir: string): string {
  const created = JSON.parse(
    runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-17/dispatch-workspace-inspection", "--json"]).stdout
  );
  expect(runForeman(repo, homeDir, ["dispatch", "claim", created.dispatch_run.id, "--tool", "codex"]).exitCode).toBe(0);
  expect(runForeman(repo, homeDir, ["dispatch", "prepare", created.dispatch_run.id, "--json"]).exitCode).toBe(0);
  return created.dispatch_run.id;
}

function expectWorkspaceError(repo: string, homeDir: string, runId: string, reason: string): void {
  const result = runForeman(repo, homeDir, ["dispatch", "workspace", runId, "--json"]);
  const parsed = JSON.parse(result.stderr);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(parsed.error.code).toBe("dispatch_workspace_uninspectable");
  expect(parsed.error.details.reason).toBe(reason);
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
  writeFileSync(specPath, "Inspect dispatch workspaces.\n", "utf8");
  writeFileSync(join(repo, "app.txt"), "initial app\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-17", "--title", "Dispatch workspace inspection"]).exitCode
  ).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-17/dispatch-workspace-inspection",
      "--title",
      "Dispatch workspace inspection",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(
    runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-17/dispatch-workspace-inspection", "implement"]).exitCode
  ).toBe(0);

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

function seedRun(
  homeDir: string,
  runId: string,
  attempts: { id: string; workspacePath: string | null; worktreeBranch: string | null }[]
): void {
  const db = openForemanDatabase({ homeDir });

  try {
    insertDispatchRun(db, {
      id: runId,
      repoName: "foreman",
      taskId: "FOREMAN-17",
      chunkId: "dispatch-workspace-inspection",
      requestedStage: "implement",
      status: "running",
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z"
    });

    attempts.forEach((attempt, index) => {
      insertDispatchAttempt(db, {
        id: attempt.id,
        runId,
        attemptNumber: index + 1,
        status: "preparing_workspace",
        tool: "codex",
        workspacePath: attempt.workspacePath,
        worktreeBranch: attempt.worktreeBranch,
        startedAt: "2026-05-15T00:00:01.000Z"
      });
    });
  } finally {
    db.close();
  }
}

function getDispatchRun(homeDir: string, runId: string) {
  const db = openForemanDatabase({ homeDir });

  try {
    return getDispatchRunDetailById(db, runId);
  } finally {
    db.close();
  }
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
  return join(repo, ".foreman", "tasks", "FOREMAN-17.yaml");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase15a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
