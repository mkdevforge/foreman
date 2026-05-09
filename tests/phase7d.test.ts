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
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase7d-test-"));
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

function setupRepo(spec = "Implement the readiness gate.\n"): string {
  const repo = createGitRepo();
  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, spec, "utf8");

  expect(runForeman(repo, ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, ["task", "add", "FOREMAN-7", "--title", "Dispatch readiness"]).exitCode).toBe(0);
  expect(
    runForeman(repo, ["chunk", "add", "FOREMAN-7/readiness", "--title", "Readiness", "--spec-file", specPath])
      .exitCode
  ).toBe(0);

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

function setDispatch(repo: string, dispatch: Record<string, any>): void {
  const task = readTaskYaml(repo);
  task.chunks[0].dispatch = dispatch;
  writeTaskYaml(repo, task);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 7d readiness CLI", () => {
  test("reports a ready chunk without mutating YAML", () => {
    const repo = setupRepo();

    expect(runForeman(repo, ["chunk", "stage", "FOREMAN-7/readiness", "plan"]).exitCode).toBe(0);
    setDispatch(repo, {
      status: "ready",
      risk_level: "low",
      approval_required: "none",
      allowed_actions: ["edit_source", "run_tests"],
      blocked_actions: []
    });
    const before = readFileSync(taskYamlPath(repo), "utf8");
    const text = runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness"]);
    const json = JSON.parse(runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness", "--json"]).stdout);
    const after = readFileSync(taskYamlPath(repo), "utf8");

    expect(text.exitCode).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("Chunk FOREMAN-7/readiness is ready for dispatch.");
    expect(text.stdout).toContain("Blockers:\n  none");
    expect(json).toMatchObject({
      schema_version: 1,
      task_id: "FOREMAN-7",
      chunk_id: "readiness",
      ready: true,
      blockers: [],
      warnings: [],
      dispatch: {
        status: "ready",
        risk_level: "low",
        approval_required: "none",
        allowed_actions: ["edit_source", "run_tests"],
        blocked_actions: []
      }
    });
    expect(json.chunk).not.toHaveProperty("dispatch");
    expect(after).toBe(before);
  });

  test("reports actionable blockers with exit 0 for not-ready chunks", () => {
    const repo = setupRepo("   \n");
    const task = readTaskYaml(repo);

    task.chunks[0].questions = [
      {
        id: questionId,
        status: "open",
        body: "Which approval owns this?",
        asked_at: "2026-05-07T18:00:00.000Z",
        answered_at: null,
        answer: null
      }
    ];
    task.chunks[0].dispatch = {
      status: "needs_context",
      risk_level: "medium",
      approval_required: "plan",
      allowed_actions: ["edit_source"],
      blocked_actions: []
    };
    writeTaskYaml(repo, task);

    const result = runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness", "--json"]);
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.ready).toBe(false);
    expect(parsed.blockers.map((blocker: any) => blocker.code)).toEqual([
      "empty_spec",
      "stage_discovery",
      "open_questions",
      "dispatch_needs_context",
      "missing_required_decision"
    ]);
    expect(parsed.blockers[2].question_ids).toEqual([questionId]);
    expect(parsed.blockers[4].required_by).toEqual(["approval_required:plan", "risk_level:medium"]);
  });

  test("requires accepted decisions only for approval or risk policies", () => {
    const repo = setupRepo();

    expect(runForeman(repo, ["chunk", "stage", "FOREMAN-7/readiness", "implement"]).exitCode).toBe(0);
    setDispatch(repo, {
      status: "ready",
      risk_level: "medium",
      approval_required: "none",
      allowed_actions: ["edit_source"],
      blocked_actions: []
    });

    const blocked = JSON.parse(runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness", "--json"]).stdout);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.map((blocker: any) => blocker.code)).toContain("missing_required_decision");

    const task = readTaskYaml(repo);
    task.chunks[0].decisions = [
      {
        id: decisionId,
        body: "Medium-risk dispatch is approved.",
        decided_at: "2026-05-07T18:03:00.000Z"
      }
    ];
    writeTaskYaml(repo, task);

    const ready = JSON.parse(runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness", "--json"]).stdout);
    expect(ready.ready).toBe(true);
    expect(ready.blockers).toEqual([]);
  });

  test("reports terminal status and blocked dispatch as blockers", () => {
    const repo = setupRepo();

    expect(runForeman(repo, ["chunk", "stage", "FOREMAN-7/readiness", "review"]).exitCode).toBe(0);
    expect(runForeman(repo, ["chunk", "status", "FOREMAN-7/readiness", "done"]).exitCode).toBe(0);
    setDispatch(repo, {
      status: "blocked",
      risk_level: "low",
      approval_required: "none",
      allowed_actions: ["run_tests"],
      blocked_actions: ["edit_source"]
    });

    const parsed = JSON.parse(runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness", "--json"]).stdout);

    expect(parsed.ready).toBe(false);
    expect(parsed.blockers.map((blocker: any) => blocker.code)).toEqual(["chunk_status_done", "dispatch_blocked"]);
  });

  test("fails clearly for missing chunks and malformed readiness metadata", () => {
    const repo = setupRepo();
    const missing = runForeman(repo, ["chunk", "ready", "FOREMAN-7/missing"]);
    const task = readTaskYaml(repo);

    task.chunks[0].dispatch = {
      status: "ready",
      risk_level: "extreme",
      approval_required: "none",
      allowed_actions: [],
      blocked_actions: []
    };
    writeTaskYaml(repo, task);

    const malformed = runForeman(repo, ["chunk", "ready", "FOREMAN-7/readiness"]);

    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("chunk 'FOREMAN-7/missing' was not found");
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr).toContain("risk_level must be one of low, medium, high");
  });
});
