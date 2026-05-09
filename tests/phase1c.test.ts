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
const questionId = "q_019f0000-0000-7000-8000-000000000001";
const decisionId = "d_019f0000-0000-7000-8000-000000000001";

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
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
  expect(runForeman(repo, ["task", "add", "FOREMAN-1", "--title", "Extensible YAML"]).exitCode).toBe(0);
  expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store"]).exitCode).toBe(0);

  return repo;
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function writeTaskYaml(repo: string, task: Record<string, any>): void {
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-1.yaml");
}

function addFutureMetadata(repo: string): void {
  const task = readTaskYaml(repo);

  task.risk_level = "medium";
  task.approval_required = "plan";
  task.dispatch = {
    status: "ready",
    last_run_id: null,
    attempts: [{ id: "run-1", status: "blocked_on_question" }]
  };
  task.chunks[0].questions = [
    {
      id: questionId,
      status: "open",
      body: "Which auth boundary owns token refresh?",
      asked_at: "2026-05-06T00:00:00.000Z",
      answered_at: null,
      answer: null
    }
  ];
  task.chunks[0].decisions = [
    {
      id: decisionId,
      body: "Keep refresh handling in the API boundary.",
      decided_at: "2026-05-06T00:00:00.000Z"
    }
  ];
  task.chunks[0].run_attempts = [{ id: "attempt-1", status: "failed", cost_usd: 0.12 }];

  writeTaskYaml(repo, task);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("foreman YAML extensibility guardrail", () => {
  test("updating task status preserves unknown task-level fields", () => {
    const repo = setupRepo();

    addFutureMetadata(repo);
    const result = runForeman(repo, ["task", "status", "FOREMAN-1", "doing"]);
    const task = readTaskYaml(repo);

    expect(result.exitCode).toBe(0);
    expect(task.status).toBe("doing");
    expect(task.risk_level).toBe("medium");
    expect(task.approval_required).toBe("plan");
    expect(task.dispatch).toEqual({
      status: "ready",
      last_run_id: null,
      attempts: [{ id: "run-1", status: "blocked_on_question" }]
    });
  });

  test("adding a chunk preserves task-level fields and unknown fields on existing chunks", () => {
    const repo = setupRepo();

    addFutureMetadata(repo);
    const result = runForeman(repo, ["chunk", "add", "FOREMAN-1/next-chunk", "--title", "Next chunk"]);
    const task = readTaskYaml(repo);

    expect(result.exitCode).toBe(0);
    expect(task.chunks).toHaveLength(2);
    expect(task.dispatch.status).toBe("ready");
    expect(task.chunks[0].questions[0].id).toBe(questionId);
    expect(task.chunks[0].decisions[0].id).toBe(decisionId);
    expect(task.chunks[0].run_attempts[0].id).toBe("attempt-1");
    expect(task.chunks[1]).not.toHaveProperty("questions");
    expect(task.chunks[1]).not.toHaveProperty("dispatch");
  });

  test("task text and JSON output expose only the v0 task shape", () => {
    const repo = setupRepo();

    addFutureMetadata(repo);
    const showText = runForeman(repo, ["task", "show", "FOREMAN-1"]);
    const showJson = JSON.parse(runForeman(repo, ["task", "show", "FOREMAN-1", "--json"]).stdout);
    const listJson = JSON.parse(runForeman(repo, ["task", "list", "--json"]).stdout);

    expect(showText.exitCode).toBe(0);
    expect(showText.stdout).toContain("Task FOREMAN-1");
    expect(showText.stdout).not.toContain("risk_level");
    expect(showText.stdout).not.toContain("blocked_on_question");

    expect(showJson.task).not.toHaveProperty("risk_level");
    expect(showJson.task).not.toHaveProperty("approval_required");
    expect(showJson.task).not.toHaveProperty("dispatch");
    expect(showJson.task.chunks[0]).not.toHaveProperty("questions");
    expect(showJson.task.chunks[0]).not.toHaveProperty("decisions");
    expect(showJson.task.chunks[0]).not.toHaveProperty("run_attempts");

    expect(listJson.tasks[0]).not.toHaveProperty("risk_level");
    expect(listJson.tasks[0]).not.toHaveProperty("dispatch");
    expect(listJson.tasks[0].chunks[0]).not.toHaveProperty("questions");
  });

  test("chunk JSON output exposes only the v0 chunk shape", () => {
    const repo = setupRepo();

    addFutureMetadata(repo);
    const chunkList = JSON.parse(runForeman(repo, ["chunk", "list", "FOREMAN-1", "--json"]).stdout);
    const chunkStatus = JSON.parse(
      runForeman(repo, ["chunk", "status", "FOREMAN-1/yaml-store", "review", "--json"]).stdout
    );

    expect(chunkList.chunks[0]).not.toHaveProperty("questions");
    expect(chunkList.chunks[0]).not.toHaveProperty("decisions");
    expect(chunkList.chunks[0]).not.toHaveProperty("run_attempts");
    expect(chunkStatus.chunk).not.toHaveProperty("questions");
    expect(chunkStatus.chunk).not.toHaveProperty("decisions");
    expect(chunkStatus.chunk).not.toHaveProperty("run_attempts");
    expect(readTaskYaml(repo).chunks[0].questions[0].id).toBe(questionId);
  });

  test("invalid known fields still fail validation when unknown fields are present", () => {
    const repo = setupRepo();
    const task = readTaskYaml(repo);

    task.dispatch = { status: "ready" };
    task.status = "mystery";
    writeTaskYaml(repo, task);
    const result = runForeman(repo, ["task", "show", "FOREMAN-1"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid status 'mystery'");
  });

  test("semantic YAML round-trip retains representative future metadata fields", () => {
    const repo = setupRepo();

    addFutureMetadata(repo);
    expect(runForeman(repo, ["task", "status", "FOREMAN-1", "review"]).exitCode).toBe(0);
    expect(runForeman(repo, ["chunk", "add", "FOREMAN-1/follow-up", "--title", "Follow up"]).exitCode).toBe(0);
    const task = readTaskYaml(repo);

    expect(task.risk_level).toBe("medium");
    expect(task.approval_required).toBe("plan");
    expect(task.dispatch.attempts[0].id).toBe("run-1");
    expect(task.chunks[0].questions[0].id).toBe(questionId);
    expect(task.chunks[0].decisions[0].id).toBe(decisionId);
    expect(task.chunks[0].run_attempts[0].id).toBe("attempt-1");
  });
});
