import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { getDispatchRunDetailById } from "../src/db/dispatch-queries";
import { insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 9a dispatch prepare worktree CLI", () => {
  test("prepares a claimed run into a task-level sibling worktree attempt", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo("git@example.com:mkdevforge/foreman.git");
    const created = JSON.parse(
      runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-9/dispatch-prepare-worktree", "--json"]).stdout
    );
    const runId = created.dispatch_run.id;
    expect(runForeman(repo, homeDir, ["dispatch", "claim", runId, "--tool", "codex"]).exitCode).toBe(0);

    const prepared = runForeman(repo, homeDir, ["dispatch", "prepare", runId.slice(0, 18), "--json"]);
    const parsed = JSON.parse(prepared.stdout);
    const expectedWorkspace = join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-9");

    expect(prepared.exitCode).toBe(0);
    expect(prepared.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.workspace).toEqual({
      repo_remote: "git@example.com:mkdevforge/foreman.git",
      repo_name: "foreman",
      workspace_path: expectedWorkspace,
      worktree_branch: "foreman/FOREMAN-9",
      created: true
    });
    expect(parsed.dispatch_run).toMatchObject({
      id: runId,
      repo_name: "foreman",
      status: "running"
    });
    expect(parsed.dispatch_run.attempts).toEqual([
      expect.objectContaining({
        attempt_number: 1,
        status: "preparing_workspace",
        tool: "codex",
        workspace_path: expectedWorkspace,
        worktree_branch: "foreman/FOREMAN-9",
        process_id: null,
        ended_at: null,
        error_message: null,
        session_id: null,
        session: null
      })
    ]);
    expect(parsed.dispatch_run.events.map((event: any) => event.type)).toEqual([
      "queued",
      "claimed",
      "attempt_prepared"
    ]);
    expect(JSON.parse(parsed.dispatch_run.events[2].data_json)).toMatchObject({
      status: "preparing_workspace",
      tool: "codex",
      workspace_path: expectedWorkspace,
      worktree_branch: "foreman/FOREMAN-9",
      repo_name: "foreman",
      workspace_created: true
    });
    expect(existsSync(join(expectedWorkspace, ".foreman", "tasks", "FOREMAN-9.yaml"))).toBe(true);
    expect(gitOutput(expectedWorkspace, ["branch", "--show-current"])).toBe("foreman/FOREMAN-9");

    const duplicate = runForeman(repo, homeDir, ["dispatch", "prepare", runId, "--json"]);
    const duplicateParsed = JSON.parse(duplicate.stderr);

    expect(duplicate.exitCode).toBe(2);
    expect(duplicateParsed.error.code).toBe("dispatch_run_not_preparable");

    const detail = getDispatchRun(homeDir, runId);
    expect(detail?.attempts).toHaveLength(1);
  });

  test("reuses the task worktree for another claimed run in the same task", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo("git@example.com:mkdevforge/foreman.git");
    const firstRunId = createAndClaim(repo, homeDir, "claude-code");
    const first = JSON.parse(runForeman(repo, homeDir, ["dispatch", "prepare", firstRunId, "--json"]).stdout);
    const secondRunId = createAndClaim(repo, homeDir, "codex");

    const second = JSON.parse(runForeman(repo, homeDir, ["dispatch", "prepare", secondRunId, "--json"]).stdout);

    expect(first.workspace.created).toBe(true);
    expect(second.workspace.created).toBe(false);
    expect(second.workspace.workspace_path).toBe(first.workspace.workspace_path);
    expect(second.dispatch_run.attempts[0]).toMatchObject({
      attempt_number: 1,
      tool: "codex",
      workspace_path: first.workspace.workspace_path
    });
  });

  test("requires an origin remote before preparing", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo(null);
    seedClaimedRun(homeDir, {
      id: "run_019fa000-0000-7000-8000-000000000001",
      repoName: null
    });

    const result = runForeman(repo, homeDir, [
      "dispatch",
      "prepare",
      "run_019fa000-0000-7000-8000-000000000001",
      "--json"
    ]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.error.code).toBe("missing_origin_remote");

    const detail = getDispatchRun(homeDir, "run_019fa000-0000-7000-8000-000000000001");
    expect(detail?.run.status).toBe("claimed");
    expect(detail?.attempts).toEqual([]);
  });

  test("rejects legacy claimed runs without repo_name", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo("git@example.com:mkdevforge/foreman.git");
    seedClaimedRun(homeDir, {
      id: "run_019fa000-0000-7000-8000-000000000002",
      repoName: null
    });

    const result = runForeman(repo, homeDir, [
      "dispatch",
      "prepare",
      "run_019fa000-0000-7000-8000-000000000002",
      "--json"
    ]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe("dispatch_run_not_preparable");
    expect(parsed.error.details.reason).toBe("missing_repo_name");
    expect(getDispatchRun(homeDir, "run_019fa000-0000-7000-8000-000000000002")?.attempts).toEqual([]);
  });

  test("rejects repo mismatches and workspace path conflicts before inserting attempts", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo("git@example.com:mkdevforge/foreman.git");
    const otherRepo = setupReadyRepo("git@example.com:mkdevforge/other.git");
    const runId = createAndClaim(repo, homeDir, "codex");

    const mismatch = runForeman(otherRepo, homeDir, ["dispatch", "prepare", runId, "--json"]);
    const mismatchParsed = JSON.parse(mismatch.stderr);

    expect(mismatch.exitCode).toBe(2);
    expect(mismatchParsed.error.code).toBe("dispatch_repo_mismatch");
    expect(getDispatchRun(homeDir, runId)?.attempts).toEqual([]);

    const workspacePath = join(dirname(repo), "foreman-worktrees", "foreman", "FOREMAN-9");
    mkdirSync(workspacePath, { recursive: true });
    const conflict = runForeman(repo, homeDir, ["dispatch", "prepare", runId, "--json"]);
    const conflictParsed = JSON.parse(conflict.stderr);

    expect(conflict.exitCode).toBe(2);
    expect(conflictParsed.error.code).toBe("dispatch_workspace_conflict");
    expect(getDispatchRun(homeDir, runId)?.run.status).toBe("claimed");
    expect(getDispatchRun(homeDir, runId)?.attempts).toEqual([]);
  });
});

function createAndClaim(repo: string, homeDir: string, tool: "claude-code" | "codex"): string {
  const created = JSON.parse(
    runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-9/dispatch-prepare-worktree", "--json"]).stdout
  );

  expect(runForeman(repo, homeDir, ["dispatch", "claim", created.dispatch_run.id, "--tool", tool]).exitCode).toBe(0);
  return created.dispatch_run.id;
}

function setupReadyRepo(remote: string | null): string {
  const root = createTempDir();
  const repo = join(root, "control");
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "dev@example.com"]);
  runGit(repo, ["config", "user.name", "Dev"]);

  if (remote !== null) {
    runGit(repo, ["remote", "add", "origin", remote]);
  }

  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, "Prepare a claimed dispatch run.\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-9", "--title", "Dispatch prepare"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-9/dispatch-prepare-worktree",
      "--title",
      "Dispatch prepare worktree",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-9/dispatch-prepare-worktree", "implement"]).exitCode).toBe(
    0
  );

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

function seedClaimedRun(homeDir: string, input: { id: string; repoName: string | null }): void {
  const db = openForemanDatabase({ homeDir });

  try {
    insertDispatchRun(db, {
      id: input.id,
      repoName: input.repoName,
      taskId: "FOREMAN-9",
      chunkId: "dispatch-prepare-worktree",
      requestedStage: "implement",
      status: "claimed",
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-12T00:00:00.000Z",
      updatedAt: "2026-05-12T00:00:00.000Z"
    });
    insertDispatchEvent(db, {
      id: input.id.replace(/^run_/, "evt_"),
      runId: input.id,
      ts: "2026-05-12T00:00:01.000Z",
      type: "claimed",
      message: "Seeded claimed event.",
      dataJson: JSON.stringify({ previous_status: "queued", status: "claimed", tool: "codex" })
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
  return join(repo, ".foreman", "tasks", "FOREMAN-9.yaml");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase9a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
