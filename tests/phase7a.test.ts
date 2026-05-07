import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase7a-test-"));
  tempDirs.push(dir);
  return dir;
}

function createGitRepo(): string {
  const dir = createTempDir();
  const result = Bun.spawnSync({
    cmd: ["git", "init"],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(decodeOutput(result.stderr));
  }

  return dir;
}

function runForeman(cwd: string, argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}

function setupRepo(): string {
  const repo = createGitRepo();

  expect(runForeman(repo, ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, ["task", "add", "FOREMAN-7", "--title", "Dispatch readiness"]).exitCode).toBe(0);
  expect(runForeman(repo, ["chunk", "add", "FOREMAN-7/schema", "--title", "Schema"]).exitCode).toBe(0);

  return repo;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-7.yaml");
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function writeTaskYaml(repo: string, task: Record<string, any>): void {
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
}

function addDispatchReadinessMetadata(repo: string): void {
  const task = readTaskYaml(repo);
  const chunk = task.chunks[0];

  chunk.questions = [
    {
      id: "q-001",
      status: "open",
      body: "Which approval policy should this chunk use?",
      asked_at: "2026-05-07T18:00:00.000Z",
      answered_at: null,
      answer: null
    },
    {
      id: "q-002",
      status: "answered",
      body: "Can this chunk alter runner behavior?",
      asked_at: "2026-05-07T18:01:00.000Z",
      answered_at: "2026-05-07T18:02:00.000Z",
      answer: "No. This chunk only defines storage readiness metadata."
    }
  ];
  chunk.decisions = [
    {
      id: "d-001",
      body: "Keep committed metadata separate from local execution state.",
      decided_at: "2026-05-07T18:03:00.000Z"
    }
  ];
  chunk.dispatch = {
    status: "needs_context",
    risk_level: "medium",
    approval_required: "plan",
    allowed_actions: ["edit_source", "run_tests"],
    blocked_actions: ["launch_runner"],
    future_field: "preserved"
  };

  writeTaskYaml(repo, task);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 7a dispatch readiness YAML schema", () => {
  test("preserves valid question, decision, and dispatch metadata across existing mutations", () => {
    const repo = setupRepo();

    addDispatchReadinessMetadata(repo);
    expect(runForeman(repo, ["chunk", "status", "FOREMAN-7/schema", "doing"]).exitCode).toBe(0);
    expect(runForeman(repo, ["chunk", "stage", "FOREMAN-7/schema", "plan"]).exitCode).toBe(0);
    const task = readTaskYaml(repo);

    expect(task.chunks[0].questions).toEqual([
      {
        id: "q-001",
        status: "open",
        body: "Which approval policy should this chunk use?",
        asked_at: "2026-05-07T18:00:00.000Z",
        answered_at: null,
        answer: null
      },
      {
        id: "q-002",
        status: "answered",
        body: "Can this chunk alter runner behavior?",
        asked_at: "2026-05-07T18:01:00.000Z",
        answered_at: "2026-05-07T18:02:00.000Z",
        answer: "No. This chunk only defines storage readiness metadata."
      }
    ]);
    expect(task.chunks[0].decisions).toEqual([
      {
        id: "d-001",
        body: "Keep committed metadata separate from local execution state.",
        decided_at: "2026-05-07T18:03:00.000Z"
      }
    ]);
    expect(task.chunks[0].dispatch).toEqual({
      status: "needs_context",
      risk_level: "medium",
      approval_required: "plan",
      allowed_actions: ["edit_source", "run_tests"],
      blocked_actions: ["launch_runner"],
      future_field: "preserved"
    });
  });

  test("keeps readiness metadata out of the v0 task and chunk JSON surface", () => {
    const repo = setupRepo();

    addDispatchReadinessMetadata(repo);
    const taskShow = JSON.parse(runForeman(repo, ["task", "show", "FOREMAN-7", "--json"]).stdout);
    const chunkList = JSON.parse(runForeman(repo, ["chunk", "list", "FOREMAN-7", "--json"]).stdout);

    expect(taskShow.task.chunks[0]).not.toHaveProperty("questions");
    expect(taskShow.task.chunks[0]).not.toHaveProperty("decisions");
    expect(taskShow.task.chunks[0]).not.toHaveProperty("dispatch");
    expect(chunkList.chunks[0]).not.toHaveProperty("questions");
    expect(chunkList.chunks[0]).not.toHaveProperty("decisions");
    expect(chunkList.chunks[0]).not.toHaveProperty("dispatch");
  });

  test("rejects malformed question metadata", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].questions = [
      {
        id: "q-001",
        status: "answered",
        body: "What is the answer?",
        asked_at: "2026-05-07T18:00:00.000Z",
        answered_at: null,
        answer: null
      }
    ];
    writeTaskYaml(repo, task);

    const result = runForeman(repo, ["task", "show", "FOREMAN-7"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("answered questions must have answered_at and answer");
  });

  test("rejects malformed decision metadata", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].decisions = [
      {
        id: "d-001",
        body: "Use SQLite for local state.",
        decided_at: "not-a-date"
      }
    ];
    writeTaskYaml(repo, task);

    const result = runForeman(repo, ["task", "show", "FOREMAN-7"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("decided_at must be an ISO 8601 UTC timestamp");
  });

  test("rejects malformed dispatch readiness metadata", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.chunks[0].dispatch = {
      status: "running",
      risk_level: "medium",
      approval_required: "plan",
      allowed_actions: ["edit_source"],
      blocked_actions: []
    };
    writeTaskYaml(repo, task);

    const result = runForeman(repo, ["task", "show", "FOREMAN-7"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("status must be one of needs_context, ready, blocked");
  });
});
