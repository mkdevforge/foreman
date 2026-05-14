import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { insertDispatchAttempt, insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 10a dispatch prompt preview CLI", () => {
  test("renders deterministic prompt JSON and text without mutating dispatch state", () => {
    const homeDir = createTempDir();
    const repo = setupPromptRepo("git@example.com:mkdevforge/foreman.git");
    const runId = "run_019fb000-0000-7000-8000-000000000001";
    seedRunningRun(homeDir, { runId });
    const before = JSON.parse(runForeman(repo, homeDir, ["dispatch", "show", runId, "--json"]).stdout);

    const jsonResult = runForeman(repo, homeDir, ["dispatch", "prompt", runId.slice(0, 18), "--json"]);
    const parsed = JSON.parse(jsonResult.stdout);
    const prompt = parsed.dispatch_prompt.prompt;

    expect(jsonResult.exitCode).toBe(0);
    expect(jsonResult.stderr).toBe("");
    expect(parsed.dispatch_prompt).toMatchObject({
      run_id: runId,
      attempt_id: "attempt_019fb000-0000-7000-8000-000000000001_1",
      repo_name: "foreman",
      task_id: "FOREMAN-10",
      task_title: "Dispatch prompt contract",
      chunk_id: "dispatch-prompt-preview",
      chunk_title: "Dispatch prompt preview",
      requested_stage: "implement",
      chunk_stage: "implement",
      chunk_status: "doing",
      tool: "codex",
      workspace_path: "/tmp/foreman-worktrees/foreman/FOREMAN-10",
      worktree_branch: "foreman/FOREMAN-10"
    });
    expect(prompt).toContain("# Foreman Dispatch Prompt");
    expect(prompt).toContain("- Task: FOREMAN-10 - Dispatch prompt contract");
    expect(prompt).toContain("- Dispatch run: run_019fb000-0000-7000-8000-000000000001");
    expect(prompt).toContain("Build a deterministic launch prompt.");
    expect(prompt).toContain("- Status: ready");
    expect(prompt).toContain("- Risk level: medium");
    expect(prompt).toContain("- Allowed actions: edit_source, run_tests");
    expect(prompt).toContain("- d_019fb000-0000-7000-8000-000000000001: Keep prompt preview read-only.");
    expect(prompt).toContain("- q_019fb000-0000-7000-8000-000000000001: Which provider should launch?");
    expect(prompt).toContain("  Answer: Not in this slice.");
    expect(prompt).toContain("- q_019fb000-0000-7000-8000-000000000002: Should unresolved ambiguity be guessed?");
    expect(prompt).toContain("- If required context is missing or ambiguous, do not guess.");
    expect(prompt).toContain(
      "- Unless explicitly instructed otherwise, commit completed workspace changes to the worktree branch before reporting finished."
    );

    const textResult = runForeman(repo, homeDir, ["dispatch", "prompt", runId]);
    expect(textResult.stdout).toBe(prompt);
    expect(textResult.stderr).toBe("");

    const after = JSON.parse(runForeman(repo, homeDir, ["dispatch", "show", runId, "--json"]).stdout);
    expect(after).toEqual(before);
  });

  test("rejects runs that cannot produce a prompt without side effects", () => {
    const homeDir = createTempDir();
    const repo = setupPromptRepo("git@example.com:mkdevforge/foreman.git");

    seedRunningRun(homeDir, {
      runId: "run_019fb000-0000-7000-8000-000000000002",
      repoName: "other"
    });
    seedRunningRun(homeDir, {
      runId: "run_019fb000-0000-7000-8000-000000000003",
      status: "claimed"
    });
    seedRunningRun(homeDir, {
      runId: "run_019fb000-0000-7000-8000-000000000004",
      attemptCount: 0
    });
    seedRunningRun(homeDir, {
      runId: "run_019fb000-0000-7000-8000-000000000005",
      attemptCount: 2
    });
    seedRunningRun(homeDir, {
      runId: "run_019fb000-0000-7000-8000-000000000006",
      workspacePath: null
    });
    seedRunningRun(homeDir, {
      runId: "run_019fb000-0000-7000-8000-000000000007",
      chunkId: "missing-chunk"
    });

    expectJsonError(repo, homeDir, "run_019fb000-0000-7000-8000-000000000002", "dispatch_repo_mismatch");
    expectJsonError(repo, homeDir, "run_019fb000-0000-7000-8000-000000000003", "dispatch_prompt_unavailable", {
      reason: "status_not_running"
    });
    expectJsonError(repo, homeDir, "run_019fb000-0000-7000-8000-000000000004", "dispatch_prompt_unavailable", {
      reason: "missing_attempt"
    });
    expectJsonError(repo, homeDir, "run_019fb000-0000-7000-8000-000000000005", "dispatch_prompt_unavailable", {
      reason: "multiple_attempts"
    });
    expectJsonError(repo, homeDir, "run_019fb000-0000-7000-8000-000000000006", "dispatch_prompt_unavailable", {
      reason: "missing_workspace_path"
    });
    expectJsonError(repo, homeDir, "run_019fb000-0000-7000-8000-000000000007", "chunk_not_found");
  });
});

function expectJsonError(
  repo: string,
  homeDir: string,
  runId: string,
  code: string,
  details?: Record<string, unknown>
): void {
  const result = runForeman(repo, homeDir, ["dispatch", "prompt", runId, "--json"]);
  const parsed = JSON.parse(result.stderr);

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(parsed.error.code).toBe(code);

  if (details !== undefined) {
    expect(parsed.error.details).toMatchObject(details);
  }
}

function setupPromptRepo(remote: string): string {
  const repo = createGitRepo(remote);
  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, "Build a deterministic launch prompt.\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "task",
      "add",
      "FOREMAN-10",
      "--title",
      "Dispatch prompt contract",
      "--description",
      "Preview prompts before launch."
    ]).exitCode
  ).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-10/dispatch-prompt-preview",
      "--title",
      "Dispatch prompt preview",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "status", "FOREMAN-10/dispatch-prompt-preview", "doing"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-10/dispatch-prompt-preview", "implement"]).exitCode).toBe(0);

  const task = readTaskYaml(repo);
  task.chunks[0].dispatch = {
    status: "ready",
    risk_level: "medium",
    approval_required: "none",
    allowed_actions: ["edit_source", "run_tests"],
    blocked_actions: ["launch_runner"]
  };
  task.chunks[0].decisions = [
    {
      id: "d_019fb000-0000-7000-8000-000000000001",
      body: "Keep prompt preview read-only.",
      decided_at: "2026-05-12T01:00:00.000Z"
    }
  ];
  task.chunks[0].questions = [
    {
      id: "q_019fb000-0000-7000-8000-000000000001",
      status: "answered",
      body: "Which provider should launch?",
      asked_at: "2026-05-12T01:00:00.000Z",
      answered_at: "2026-05-12T01:01:00.000Z",
      answer: "Not in this slice."
    },
    {
      id: "q_019fb000-0000-7000-8000-000000000002",
      status: "open",
      body: "Should unresolved ambiguity be guessed?",
      asked_at: "2026-05-12T01:02:00.000Z",
      answered_at: null,
      answer: null
    }
  ];
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");

  return repo;
}

function seedRunningRun(
  homeDir: string,
  input: {
    runId: string;
    repoName?: string | null;
    status?: string;
    chunkId?: string;
    attemptCount?: number;
    workspacePath?: string | null;
  }
): void {
  const db = openForemanDatabase({ homeDir });
  const attemptCount = input.attemptCount ?? 1;

  try {
    insertDispatchRun(db, {
      id: input.runId,
      repoName: input.repoName ?? "foreman",
      taskId: "FOREMAN-10",
      chunkId: input.chunkId ?? "dispatch-prompt-preview",
      requestedStage: "implement",
      status: input.status ?? "running",
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-12T01:00:00.000Z",
      updatedAt: "2026-05-12T01:00:00.000Z"
    });
    insertDispatchEvent(db, {
      id: input.runId.replace(/^run_/, "evt_"),
      runId: input.runId,
      ts: "2026-05-12T01:00:01.000Z",
      type: "attempt_prepared",
      message: "Seeded prepared event.",
      dataJson: "{}"
    });

    for (let index = 0; index < attemptCount; index += 1) {
      insertDispatchAttempt(db, {
        id: `attempt_${input.runId.slice("run_".length)}_${index + 1}`,
        runId: input.runId,
        attemptNumber: index + 1,
        status: "preparing_workspace",
        tool: "codex",
        workspacePath:
          "workspacePath" in input ? input.workspacePath : "/tmp/foreman-worktrees/foreman/FOREMAN-10",
        worktreeBranch: "foreman/FOREMAN-10",
        startedAt: "2026-05-12T01:00:02.000Z"
      });
    }
  } finally {
    db.close();
  }
}

function createGitRepo(remote: string): string {
  const dir = createTempDir();
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init"]);
  runGit(dir, ["remote", "add", "origin", remote]);
  return dir;
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
  return join(repo, ".foreman", "tasks", "FOREMAN-10.yaml");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase10a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
