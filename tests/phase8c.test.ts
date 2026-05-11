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
const runIdPattern = /^run_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const eventIdPattern = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 8c dispatch create CLI", () => {
  test("creates a queued dispatch run for a ready chunk without mutating YAML", () => {
    const homeDir = createTempDir();
    const repo = setupRepo({ ready: true });
    const beforeYaml = readFileSync(taskYamlPath(repo), "utf8");

    const created = runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-8/dispatch-create-command", "--json"]);
    const parsed = JSON.parse(created.stdout);
    const run = parsed.dispatch_run;

    expect(created.exitCode).toBe(0);
    expect(created.stderr).toBe("");
    expect(run.id).toMatch(runIdPattern);
    expect(run).toMatchObject({
      repo_name: "foreman",
      task_id: "FOREMAN-8",
      chunk_id: "dispatch-create-command",
      requested_stage: "implement",
      status: "queued",
      requested_by: null,
      source: "cli",
      finished_at: null,
      attempts: []
    });
    expect(run.events).toHaveLength(1);
    expect(run.events[0].id).toMatch(eventIdPattern);
    expect(run.events[0]).toMatchObject({
      run_id: run.id,
      attempt_id: null,
      type: "queued",
      message: "Queued dispatch run for FOREMAN-8/dispatch-create-command."
    });
    expect(JSON.parse(run.events[0].data_json)).toEqual({
      task_id: "FOREMAN-8",
      chunk_id: "dispatch-create-command",
      repo_name: "foreman",
      requested_stage: "implement",
      source: "cli"
    });
    expect(parsed.readiness.ready).toBe(true);
    expect(readFileSync(taskYamlPath(repo), "utf8")).toBe(beforeYaml);

    const shown = JSON.parse(runForeman(repo, homeDir, ["dispatch", "show", run.id, "--json"]).stdout);
    expect(shown.dispatch_run.id).toBe(run.id);

    const listed = JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--task", "FOREMAN-8", "--json"]).stdout);
    expect(listed.dispatch_runs.map((entry: any) => entry.id)).toEqual([run.id]);
  });

  test("records a requested stage override without changing the chunk stage", () => {
    const homeDir = createTempDir();
    const repo = setupRepo({ ready: true });

    const created = JSON.parse(
      runForeman(repo, homeDir, [
        "dispatch",
        "create",
        "FOREMAN-8/dispatch-create-command",
        "--stage",
        "review",
        "--json"
      ]).stdout
    );

    expect(created.dispatch_run.requested_stage).toBe("review");
    expect(readTaskYaml(repo).chunks[0].stage).toBe("implement");
  });

  test("rejects discovery as a requested dispatch stage", () => {
    const homeDir = createTempDir();
    const repo = setupRepo({ ready: true });

    const result = runForeman(repo, homeDir, [
      "dispatch",
      "create",
      "FOREMAN-8/dispatch-create-command",
      "--stage",
      "discovery",
      "--json"
    ]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.error.code).toBe("invalid_dispatch_stage");

    const list = JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--json"]).stdout);
    expect(list.dispatch_runs).toEqual([]);
  });

  test("refuses not-ready chunks before inserting dispatch rows", () => {
    const homeDir = createTempDir();
    const repo = setupRepo({ ready: false });

    const result = runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-8/dispatch-create-command", "--json"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.error.code).toBe("dispatch_not_ready");
    expect(parsed.error.details.readiness.ready).toBe(false);
    expect(parsed.error.details.readiness.blockers.map((blocker: any) => blocker.code)).toEqual([
      "stage_discovery",
      "missing_dispatch_metadata"
    ]);

    const list = JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--json"]).stdout);
    expect(list.dispatch_runs).toEqual([]);
  });
});

function setupRepo(options: { ready: boolean }): string {
  const repo = createGitRepo();
  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, "Create a queued dispatch run.\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-8", "--title", "Dispatch"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-8/dispatch-create-command",
      "--title",
      "Dispatch create",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);

  if (options.ready) {
    expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-8/dispatch-create-command", "implement"]).exitCode).toBe(
      0
    );
    setDispatch(repo, {
      status: "ready",
      risk_level: "low",
      approval_required: "none",
      allowed_actions: ["edit_source", "run_tests"],
      blocked_actions: ["launch_runner"]
    });
  }

  return repo;
}

function createGitRepo(): string {
  const dir = createTempDir();
  runGit(dir, ["init"]);
  runGit(dir, ["remote", "add", "origin", "git@example.com:mkdevforge/foreman.git"]);

  return dir;
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

function setDispatch(repo: string, dispatch: Record<string, any>): void {
  const task = readTaskYaml(repo);
  task.chunks[0].dispatch = dispatch;
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-8.yaml");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase8c-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
