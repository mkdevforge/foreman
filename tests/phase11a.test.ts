import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { insertDispatchAttempt, insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";

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

describe("Phase 11a dispatch launch CLI", () => {
  test("launches a prepared Codex attempt once and records process metadata", async () => {
    const homeDir = createTempDir();
    const repo = setupLaunchRepo("git@example.com:mkdevforge/foreman.git");
    const fakeBin = createTempDir();
    const captureDir = createTempDir();
    const runId = "run_019fc000-0000-7000-8000-000000000001";
    const fakeCodex = writeFakeAgentBinary(fakeBin, "codex");
    seedRunningRun(homeDir, { runId, repo, tool: "codex" });

    const result = runForeman(repo, homeDir, ["dispatch", "launch", runId.slice(0, 18), "--json"], {
      PATH: `${fakeBin}:${systemPath}`,
      FOREMAN_FAKE_LAUNCH_CAPTURE: captureDir
    });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(parsed.dispatch_launch).toMatchObject({
      run_id: runId,
      attempt_id: "attempt_019fc000-0000-7000-8000-000000000001_1",
      tool: "codex",
      command: fakeCodex,
      args: ["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--color", "never", "-"],
      cwd: repo
    });
    expect(parsed.dispatch_launch.process_id).toBeGreaterThan(0);
    expect(parsed.dispatch_launch.prompt_chars).toBeGreaterThan(0);
    expect(parsed.dispatch_launch.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.dispatch_run.status).toBe("running");
    expect(parsed.dispatch_run.attempts[0]).toMatchObject({
      status: "launching_agent",
      process_id: parsed.dispatch_launch.process_id
    });
    expect(parsed.dispatch_run.events.map((event: any) => event.type)).toEqual([
      "attempt_prepared",
      "prompt_built",
      "agent_launched"
    ]);
    expect(JSON.parse(parsed.dispatch_run.events[1].data_json)).toMatchObject({
      status: "building_prompt",
      prompt_chars: parsed.dispatch_launch.prompt_chars,
      prompt_sha256: parsed.dispatch_launch.prompt_sha256
    });
    const launchEvent = JSON.parse(parsed.dispatch_run.events[2].data_json);
    expect(launchEvent).toMatchObject({
      status: "launching_agent",
      tool: "codex",
      command: fakeCodex,
      args: parsed.dispatch_launch.args,
      cwd: repo,
      process_id: parsed.dispatch_launch.process_id
    });
    expect(JSON.stringify(launchEvent)).not.toContain("Foreman Dispatch Prompt");

    const stdinPath = join(captureDir, "stdin");
    await waitForFile(stdinPath);
    expect(realpathSync(readFileSync(join(captureDir, "cwd"), "utf8").trim())).toBe(realpathSync(repo));
    expect(readFileSync(join(captureDir, "argv"), "utf8").trim().split("\n")).toEqual([
      fakeCodex,
      ...parsed.dispatch_launch.args
    ]);
    expect(readFileSync(join(captureDir, "run_id"), "utf8").trim()).toBe(runId);
    expect(readFileSync(join(captureDir, "attempt_id"), "utf8").trim()).toBe(
      parsed.dispatch_launch.attempt_id
    );
    const stdin = await waitForFileText(stdinPath, "# Foreman Dispatch Prompt");
    expect(stdin).toContain("# Foreman Dispatch Prompt");
    expect(stdin).toContain("- Task: FOREMAN-11 - Dispatch agent launch");
    expect(stdin).toContain("- Chunk: dispatch-launch-command - Dispatch launch command");

    const duplicate = runForeman(repo, homeDir, ["dispatch", "launch", runId, "--json"], {
      PATH: `${fakeBin}:${systemPath}`,
      FOREMAN_FAKE_LAUNCH_CAPTURE: captureDir
    });
    const duplicateParsed = JSON.parse(duplicate.stderr);

    expect(duplicate.exitCode).toBe(2);
    expect(duplicateParsed.error.code).toBe("dispatch_run_not_launchable");
    expect(duplicateParsed.error.details.reason).toBe("attempt_status_not_preparing_workspace");
    expect(JSON.parse(runForeman(repo, homeDir, ["dispatch", "show", runId, "--json"]).stdout).dispatch_run.events).toHaveLength(3);
  });

  test("launches Claude Code with the non-interactive command shape", async () => {
    const homeDir = createTempDir();
    const repo = setupLaunchRepo("git@example.com:mkdevforge/foreman.git");
    const fakeBin = createTempDir();
    const captureDir = createTempDir();
    const runId = "run_019fc000-0000-7000-8000-000000000002";
    const fakeClaude = writeFakeAgentBinary(fakeBin, "claude");
    seedRunningRun(homeDir, { runId, repo, tool: "claude-code" });

    const result = runForeman(repo, homeDir, ["dispatch", "launch", runId, "--json"], {
      PATH: `${fakeBin}:${systemPath}`,
      FOREMAN_FAKE_LAUNCH_CAPTURE: captureDir
    });
    const parsed = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed.dispatch_launch).toMatchObject({
      tool: "claude-code",
      command: fakeClaude,
      args: [
        "--print",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits"
      ],
      cwd: repo
    });

    await waitForFile(join(captureDir, "argv"));
    expect(readFileSync(join(captureDir, "argv"), "utf8").trim().split("\n")).toEqual([
      fakeClaude,
      ...parsed.dispatch_launch.args
    ]);
  });

  test("rejects unlaunchable runs before starting a process or mutating state", () => {
    const homeDir = createTempDir();
    const repo = setupLaunchRepo("git@example.com:mkdevforge/foreman.git");
    const fakeBin = createTempDir();
    const captureDir = createTempDir();
    const runId = "run_019fc000-0000-7000-8000-000000000003";
    seedRunningRun(homeDir, { runId, repo, tool: "codex", attemptStatus: "launching_agent", processId: 123 });

    const result = runForeman(repo, homeDir, ["dispatch", "launch", runId, "--json"], {
      PATH: systemPath,
      FOREMAN_FAKE_LAUNCH_CAPTURE: captureDir
    });
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.error.code).toBe("dispatch_run_not_launchable");
    expect(parsed.error.details.reason).toBe("attempt_status_not_preparing_workspace");
    expect(existsSync(join(captureDir, "stdin"))).toBe(false);
    expect(JSON.parse(runForeman(repo, homeDir, ["dispatch", "show", runId, "--json"]).stdout).dispatch_run.events).toHaveLength(1);
  });

  test("reports missing agent binaries without changing dispatch state", () => {
    const homeDir = createTempDir();
    const repo = setupLaunchRepo("git@example.com:mkdevforge/foreman.git");
    const runId = "run_019fc000-0000-7000-8000-000000000004";
    seedRunningRun(homeDir, { runId, repo, tool: "codex" });

    const result = runForeman(repo, homeDir, ["dispatch", "launch", runId, "--json"], {
      PATH: systemPath
    });
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.error.code).toBe("dispatch_run_not_launchable");
    expect(parsed.error.details.reason).toBe("codex_not_found");
    const shown = JSON.parse(runForeman(repo, homeDir, ["dispatch", "show", runId, "--json"]).stdout);
    expect(shown.dispatch_run.attempts[0].status).toBe("preparing_workspace");
    expect(shown.dispatch_run.events).toHaveLength(1);
  });
});

function setupLaunchRepo(remote: string): string {
  const repo = createGitRepo(remote);

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "task",
      "add",
      "FOREMAN-11",
      "--title",
      "Dispatch agent launch",
      "--description",
      "Launch prepared dispatch attempts."
    ]).exitCode
  ).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-11/dispatch-launch-command",
      "--title",
      "Dispatch launch command"
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "status", "FOREMAN-11/dispatch-launch-command", "doing"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-11/dispatch-launch-command", "implement"]).exitCode).toBe(0);

  const task = parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
  task.chunks[0].spec = "Start the selected local agent from the prepared workspace.";
  task.chunks[0].dispatch = {
    status: "ready",
    risk_level: "medium",
    approval_required: "none",
    allowed_actions: ["edit_source", "run_tests", "launch_runner"],
    blocked_actions: ["cleanup_worktree"]
  };
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");

  return repo;
}

function seedRunningRun(
  homeDir: string,
  input: {
    runId: string;
    repo: string;
    tool: "codex" | "claude-code";
    attemptStatus?: string;
    processId?: number | null;
  }
): void {
  const db = openForemanDatabase({ homeDir });

  try {
    insertDispatchRun(db, {
      id: input.runId,
      repoName: "foreman",
      taskId: "FOREMAN-11",
      chunkId: "dispatch-launch-command",
      requestedStage: "implement",
      status: "running",
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-12T01:35:00.000Z",
      updatedAt: "2026-05-12T01:35:00.000Z"
    });
    insertDispatchAttempt(db, {
      id: `attempt_${input.runId.slice("run_".length)}_1`,
      runId: input.runId,
      attemptNumber: 1,
      status: input.attemptStatus ?? "preparing_workspace",
      tool: input.tool,
      workspacePath: input.repo,
      worktreeBranch: "foreman/FOREMAN-11",
      processId: input.processId ?? null,
      startedAt: "2026-05-12T01:35:01.000Z"
    });
    insertDispatchEvent(db, {
      id: input.runId.replace(/^run_/, "evt_"),
      runId: input.runId,
      attemptId: `attempt_${input.runId.slice("run_".length)}_1`,
      ts: "2026-05-12T01:35:01.000Z",
      type: "attempt_prepared",
      message: "Seeded prepared event.",
      dataJson: "{}"
    });
  } finally {
    db.close();
  }
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

function createGitRepo(remote: string): string {
  const dir = createTempDir();
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init"]);
  runGit(dir, ["remote", "add", "origin", remote]);
  return dir;
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

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-11.yaml");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase11a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
