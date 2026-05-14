import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const systemPath = "/usr/bin:/bin";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 14a dispatch start CLI", () => {
  test("creates, claims, prepares, and launches a ready chunk", async () => {
    const homeDir = createTempDir();
    const repo = setupStartRepo({ ready: true });
    const fakeBin = createTempDir();
    const captureDir = createTempDir();
    const fakeCodex = writeFakeAgentBinary(fakeBin, "codex");

    const result = runForeman(
      repo,
      homeDir,
      ["dispatch", "start", "FOREMAN-16/dispatch-start-command", "--tool", "codex", "--stage", "review", "--json"],
      {
        PATH: `${fakeBin}:${systemPath}`,
        FOREMAN_FAKE_LAUNCH_CAPTURE: captureDir
      }
    );
    const parsed = JSON.parse(result.stdout);
    const run = parsed.dispatch_run;
    const expectedWorkspace = join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-16");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(run).toMatchObject({
      repo_name: "foreman",
      task_id: "FOREMAN-16",
      chunk_id: "dispatch-start-command",
      requested_stage: "review",
      status: "running"
    });
    expect(run.events.map((event: any) => event.type)).toEqual([
      "queued",
      "claimed",
      "attempt_prepared",
      "prompt_built",
      "agent_launched"
    ]);
    expect(run.attempts[0]).toMatchObject({
      status: "launching_agent",
      tool: "codex",
      workspace_path: expectedWorkspace,
      worktree_branch: "foreman/FOREMAN-16",
      session_id: null
    });
    expect(parsed.readiness.ready).toBe(true);
    expect(parsed.workspace).toEqual({
      repo_remote: "git@example.com:mkdevforge/foreman.git",
      repo_name: "foreman",
      workspace_path: expectedWorkspace,
      worktree_branch: "foreman/FOREMAN-16",
      created: true
    });
    expect(parsed.dispatch_launch).toMatchObject({
      run_id: run.id,
      attempt_id: run.attempts[0].id,
      tool: "codex",
      command: fakeCodex,
      args: ["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--color", "never", "-"],
      cwd: expectedWorkspace
    });
    expect(parsed.steps.map((step: any) => step.name)).toEqual([
      "created",
      "claimed",
      "prepared",
      "prompt_built",
      "launched"
    ]);
    expect(parsed.steps[2].detail).toMatchObject({
      workspace_path: expectedWorkspace,
      worktree_branch: "foreman/FOREMAN-16",
      workspace_created: true
    });
    expect(parsed.steps[3].detail.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);

    const stdinPath = join(captureDir, "stdin");
    await waitForFile(stdinPath);
    expect(realpathSync(readFileSync(join(captureDir, "cwd"), "utf8").trim())).toBe(realpathSync(expectedWorkspace));
    expect(readFileSync(join(captureDir, "argv"), "utf8").trim().split("\n")).toEqual([
      fakeCodex,
      ...parsed.dispatch_launch.args
    ]);
    expect(readFileSync(join(captureDir, "run_id"), "utf8").trim()).toBe(run.id);
    expect(readFileSync(join(captureDir, "attempt_id"), "utf8").trim()).toBe(run.attempts[0].id);
    expect(await waitForFileText(stdinPath, "# Foreman Dispatch Prompt")).toContain(
      "- Chunk: dispatch-start-command - Dispatch start command"
    );
  });

  test("refuses not-ready chunks and invalid dispatch stages before inserting rows", () => {
    const homeDir = createTempDir();
    const repo = setupStartRepo({ ready: false });

    const notReady = runForeman(repo, homeDir, [
      "dispatch",
      "start",
      "FOREMAN-16/dispatch-start-command",
      "--tool",
      "codex",
      "--json"
    ]);
    const notReadyParsed = JSON.parse(notReady.stderr);

    expect(notReady.exitCode).toBe(2);
    expect(notReadyParsed.error.code).toBe("dispatch_not_ready");
    expect(notReadyParsed.error.details.readiness.ready).toBe(false);
    expect(JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--json"]).stdout).dispatch_runs).toEqual([]);

    const invalidStage = runForeman(repo, homeDir, [
      "dispatch",
      "start",
      "FOREMAN-16/dispatch-start-command",
      "--tool",
      "codex",
      "--stage",
      "discovery",
      "--json"
    ]);
    const invalidStageParsed = JSON.parse(invalidStage.stderr);

    expect(invalidStage.exitCode).toBe(2);
    expect(invalidStageParsed.error.code).toBe("invalid_dispatch_stage");
    expect(JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--json"]).stdout).dispatch_runs).toEqual([]);
  });

  test("preserves created state when launch prerequisites fail", () => {
    const homeDir = createTempDir();
    const repo = setupStartRepo({ ready: true });

    const result = runForeman(
      repo,
      homeDir,
      ["dispatch", "start", "FOREMAN-16/dispatch-start-command", "--tool", "codex", "--json"],
      { PATH: systemPath }
    );
    const parsed = JSON.parse(result.stderr);
    const runs = JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--json"]).stdout).dispatch_runs;

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe("dispatch_run_not_launchable");
    expect(parsed.error.details.reason).toBe("codex_not_found");
    expect(parsed.error.details.steps.map((step: any) => step.name)).toEqual(["created", "claimed", "prepared"]);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    expect(runs[0].attempts[0]).toMatchObject({
      status: "preparing_workspace",
      process_id: null,
      session_id: null
    });
    expect(runs[0].events.map((event: any) => event.type)).toEqual(["queued", "claimed", "attempt_prepared"]);
  });

  test("reports completed steps when worktree preparation fails", () => {
    const homeDir = createTempDir();
    const repo = setupStartRepo({ ready: true });
    const conflictPath = join(dirname(realpathSync(repo)), "foreman-worktrees", "foreman", "FOREMAN-16");
    mkdirSync(conflictPath, { recursive: true });

    const result = runForeman(
      repo,
      homeDir,
      ["dispatch", "start", "FOREMAN-16/dispatch-start-command", "--tool", "codex", "--json"],
      { PATH: systemPath }
    );
    const parsed = JSON.parse(result.stderr);
    const runs = JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--json"]).stdout).dispatch_runs;

    expect(result.exitCode).toBe(2);
    expect(parsed.error.code).toBe("dispatch_workspace_conflict");
    expect(parsed.error.details.steps.map((step: any) => step.name)).toEqual(["created", "claimed"]);
    expect(parsed.error.details.dispatch_run.status).toBe("claimed");
    expect(parsed.error.details.dispatch_run.attempts).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("claimed");
    expect(runs[0].events.map((event: any) => event.type)).toEqual(["queued", "claimed"]);
  });
});

function setupStartRepo(options: { ready: boolean }): string {
  const root = createTempDir();
  const repo = join(root, "control");
  mkdirSync(repo, { recursive: true });
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "dev@example.com"]);
  runGit(repo, ["config", "user.name", "Dev"]);
  runGit(repo, ["remote", "add", "origin", "git@example.com:mkdevforge/foreman.git"]);

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "task",
      "add",
      "FOREMAN-16",
      "--title",
      "Dispatch start",
      "--description",
      "Start dispatch in one command."
    ]).exitCode
  ).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-16/dispatch-start-command",
      "--title",
      "Dispatch start command"
    ]).exitCode
  ).toBe(0);

  const task = readTaskYaml(repo);
  task.chunks[0].spec = "Create, claim, prepare, and launch the selected local agent.";
  if (options.ready) {
    task.chunks[0].stage = "implement";
    task.chunks[0].status = "doing";
    task.chunks[0].dispatch = {
      status: "ready",
      risk_level: "low",
      approval_required: "none",
      allowed_actions: ["edit_source", "run_tests", "create_worktree", "launch_runner"],
      blocked_actions: ["cleanup_worktree"]
    };
  }
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "Initial Foreman task"]);

  return repo;
}

function writeFakeAgentBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      "#!/usr/bin/env sh",
      "set -eu",
      ": \"${FOREMAN_FAKE_LAUNCH_CAPTURE:?}\"",
      "mkdir -p \"$FOREMAN_FAKE_LAUNCH_CAPTURE\"",
      "printf '%s\\n' \"$PWD\" > \"$FOREMAN_FAKE_LAUNCH_CAPTURE/cwd\"",
      "printf '%s\\n' \"$0\" \"$@\" > \"$FOREMAN_FAKE_LAUNCH_CAPTURE/argv\"",
      "printf '%s\\n' \"${FOREMAN_DISPATCH_RUN_ID:-}\" > \"$FOREMAN_FAKE_LAUNCH_CAPTURE/run_id\"",
      "printf '%s\\n' \"${FOREMAN_DISPATCH_ATTEMPT_ID:-}\" > \"$FOREMAN_FAKE_LAUNCH_CAPTURE/attempt_id\"",
      "cat > \"$FOREMAN_FAKE_LAUNCH_CAPTURE/stdin\""
    ].join("\n"),
    "utf8"
  );
  chmodSync(path, 0o755);
  return path;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await Bun.sleep(20);
  }

  throw new Error(`timed out waiting for ${path}`);
}

async function waitForFileText(path: string, expected: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.includes(expected)) {
        return text;
      }
    }
    await Bun.sleep(20);
  }

  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-16.yaml");
}

function runForeman(cwd: string, homeDir: string, argv: string[], env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
    env: { ...process.env, ...env, HOME: env.HOME ?? homeDir },
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

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase14a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
