import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { insertDispatchAttempt, insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const systemPath = "/usr/bin:/bin";
const tempDirs: string[] = [];

describe("Phase 6a automated acceptance hardening", () => {
  test("every JSON-capable command returns a schema_version 1 JSON envelope", async () => {
    const homeDir = createTempDir();
    const repo = createGitRepo(join(createTempDir(), "control"), "git@example.com:mkdevforge/foreman.git");
    const specPath = join(repo, "spec.md");
    writeFileSync(specPath, "Build the API surface.\n", "utf8");

    expectJsonCommand(repo, homeDir, ["init"], ["repo_root", "foreman_dir", "tasks_dir"]);
    expectJsonCommand(repo, homeDir, ["install", "--tool", "codex"], ["installed_tools", "codex_hooks_path"]);
    expectJsonCommand(repo, homeDir, ["task", "add", "FOREMAN-1", "--title", "Task"], ["task"]);
    expectJsonCommand(repo, homeDir, ["chunk", "add", "FOREMAN-1/api", "--title", "API", "--spec-file", specPath], [
      "task_id",
      "chunk"
    ]);
    expectJsonCommand(repo, homeDir, ["task", "status", "FOREMAN-1", "doing"], ["task"]);
    expectJsonCommand(repo, homeDir, ["chunk", "status", "FOREMAN-1/api", "doing"], ["task_id", "chunk"]);
    expectJsonCommand(repo, homeDir, ["chunk", "stage", "FOREMAN-1/api", "implement"], ["task_id", "chunk"]);
    expectJsonCommand(repo, homeDir, ["chunk", "note", "FOREMAN-1/api", "Looks good."], [
      "task_id",
      "chunk",
      "note"
    ]);
    const questionAdd = expectJsonCommand(repo, homeDir, ["question", "add", "FOREMAN-1/api", "Which boundary owns this?"], [
      "task_id",
      "chunk_id",
      "question",
      "chunk"
    ]);
    expectJsonCommand(repo, homeDir, ["question", "list", "FOREMAN-1/api"], ["task_id", "chunk_id", "questions"]);
    expectJsonCommand(repo, homeDir, ["question", "answer", "FOREMAN-1/api", questionAdd.question.id, "The API boundary."], [
      "task_id",
      "chunk_id",
      "question",
      "chunk"
    ]);
    expectJsonCommand(repo, homeDir, ["decision", "add", "FOREMAN-1/api", "Use the API boundary."], [
      "task_id",
      "chunk_id",
      "decision",
      "chunk"
    ]);
    expectJsonCommand(repo, homeDir, ["decision", "list", "FOREMAN-1/api"], ["task_id", "chunk_id", "decisions"]);
    setDispatchReadiness(repo, "FOREMAN-1");
    commitAll(repo);
    expectJsonCommand(repo, homeDir, ["chunk", "ready", "FOREMAN-1/api"], [
      "task_id",
      "chunk_id",
      "ready",
      "blockers",
      "warnings",
      "dispatch",
      "chunk"
    ]);
    expectJsonCommand(repo, homeDir, ["task", "list"], ["tasks"]);
    expectJsonCommand(repo, homeDir, ["task", "show", "FOREMAN-1"], ["task"]);
    expectJsonCommand(repo, homeDir, ["chunk", "list", "FOREMAN-1"], ["task_id", "chunks"]);
    expectJsonCommand(repo, homeDir, ["work", "FOREMAN-1/api", "--stage", "review"], ["active"]);
    expectJsonCommand(repo, homeDir, ["status"], ["active", "stale", "stale_after_hours", "invalid"]);
    expectJsonCommand(repo, homeDir, ["stop"], ["active", "cleared"]);
    const createdDispatchRun = expectJsonCommand(repo, homeDir, ["dispatch", "create", "FOREMAN-1/api"], [
      "dispatch_run",
      "readiness"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "cancel", createdDispatchRun.dispatch_run.id], [
      "dispatch_run",
      "changed"
    ]);
    const claimedDispatchRun = expectJsonCommand(repo, homeDir, ["dispatch", "create", "FOREMAN-1/api"], [
      "dispatch_run",
      "readiness"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "claim", claimedDispatchRun.dispatch_run.id, "--tool", "codex"], [
      "dispatch_run",
      "changed"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "prepare", claimedDispatchRun.dispatch_run.id], [
      "dispatch_run",
      "workspace",
      "changed"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "prompt", claimedDispatchRun.dispatch_run.id], ["dispatch_prompt"]);
    const fakeBin = createTempDir();
    const launchCapture = createTempDir();
    writeFakeAgentBinary(fakeBin, "codex");
    const launchedDispatchRun = expectJsonCommand(
      repo,
      homeDir,
      ["dispatch", "launch", claimedDispatchRun.dispatch_run.id],
      ["dispatch_run", "dispatch_launch"],
      {
        PATH: `${fakeBin}:${systemPath}`,
        FOREMAN_FAKE_LAUNCH_CAPTURE: launchCapture
      }
    );
    await waitForFile(join(launchCapture, "stdin"));
    const startCapture = createTempDir();
    expectJsonCommand(
      repo,
      homeDir,
      ["dispatch", "start", "FOREMAN-1/api", "--tool", "codex"],
      ["dispatch_run", "readiness", "workspace", "dispatch_launch", "steps"],
      {
        PATH: `${fakeBin}:${systemPath}`,
        FOREMAN_FAKE_LAUNCH_CAPTURE: startCapture
      }
    );
    await waitForFile(join(startCapture, "stdin"));

    seedAcceptanceSessions(homeDir, repo);
    attachAcceptanceDispatchSession(
      homeDir,
      launchedDispatchRun.dispatch_launch.attempt_id,
      "018f6000-0000-7000-8000-000000000001"
    );
    expectJsonCommand(repo, homeDir, ["dispatch", "workspace", claimedDispatchRun.dispatch_run.id], [
      "dispatch_run",
      "workspace"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "diff", claimedDispatchRun.dispatch_run.id, "--name-only"], [
      "dispatch_run",
      "workspace",
      "diff"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "finish", claimedDispatchRun.dispatch_run.id, "--status", "succeeded"], [
      "dispatch_run",
      "changed"
    ]);
    seedAcceptanceDispatchRuns(homeDir);

    expectJsonCommand(repo, homeDir, ["session", "list"], ["sessions"]);
    expectJsonCommand(repo, homeDir, ["session", "show", "018f6000-0000-7000-8000-000000000001", "--full"], [
      "session"
    ]);
    expectJsonCommand(repo, homeDir, ["session", "last"], ["session"]);
    expectJsonCommand(repo, homeDir, ["session", "cost", "--by", "source"], ["cost"]);
    expectJsonCommand(repo, homeDir, ["review", "FOREMAN-1/api", "--full"], ["review"]);
    expectJsonCommand(repo, homeDir, ["review", "FOREMAN-1"], ["review"]);
    expectJsonCommand(repo, homeDir, ["catalog", "--since", "2w"], ["catalog"]);
    expectJsonCommand(repo, homeDir, ["catalog", "--link", "018f6000-0000-7000-8000-000000000002", "FOREMAN-1/api"], [
      "catalog"
    ]);
    expectJsonCommand(repo, homeDir, ["catalog", "--unlink", "018f6000-0000-7000-8000-000000000002", "FOREMAN-1/api"], [
      "catalog"
    ]);
    expectJsonCommand(repo, homeDir, ["dispatch", "list"], ["dispatch_runs"]);
    expectJsonCommand(repo, homeDir, ["dispatch", "show", "run_019f6000-0000-7000-8000-000000000001"], [
      "dispatch_run"
    ]);
  });

  test("corrupt user database exits 1 with a JSON error envelope", () => {
    const homeDir = createTempDir();
    const repo = createGitRepo(createTempDir());
    const dbPath = join(homeDir, ".foreman", "foreman.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "not a sqlite database", "utf8");

    const result = runForeman(repo, homeDir, ["session", "list", "--json"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.error.exit_code).toBe(1);
    expect(parsed.error.code).toBe("internal_error");
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });
});

function expectJsonCommand(
  cwd: string,
  homeDir: string,
  argv: string[],
  requiredKeys: string[],
  env: Record<string, string | undefined> = {}
): any {
  const result = runForeman(cwd, homeDir, [...argv, "--json"], env);
  let parsed: any;

  expect(result.exitCode, `${argv.join(" ")} exit code`).toBe(0);
  expect(result.stderr, `${argv.join(" ")} stderr`).toBe("");
  expect(() => {
    parsed = JSON.parse(result.stdout);
  }, `${argv.join(" ")} stdout should be JSON`).not.toThrow();
  expect(parsed.schema_version, `${argv.join(" ")} schema version`).toBe(1);

  for (const key of requiredKeys) {
    expect(parsed, `${argv.join(" ")} missing key ${key}`).toHaveProperty(key);
  }

  return parsed;
}

function setDispatchReadiness(repo: string, taskId: string): void {
  const path = join(repo, ".foreman", "tasks", `${taskId}.yaml`);
  const task = parse(readFileSync(path, "utf8")) as Record<string, any>;
  task.chunks[0].dispatch = {
    status: "ready",
    risk_level: "low",
    approval_required: "none",
    allowed_actions: ["edit_source", "run_tests"],
    blocked_actions: ["launch_runner"]
  };
  writeFileSync(path, stringify(task), "utf8");
}

function seedAcceptanceSessions(homeDir: string, projectPath: string): void {
  const db = openForemanDatabase({ homeDir });

  try {
    seedSession(db, {
      id: "018f6000-0000-7000-8000-000000000001",
      source: "codex",
      startedAt: "2026-05-06T10:00:00.000Z",
      projectPath,
      repoRemote: "git@example.com:mkdevforge/foreman.git",
      costUsd: 0.12,
      summary: "Linked API session.",
      linked: true
    });
    seedSession(db, {
      id: "018f6000-0000-7000-8000-000000000002",
      source: "claude-code",
      startedAt: "2026-05-06T09:00:00.000Z",
      projectPath,
      repoRemote: "git@example.com:mkdevforge/foreman.git",
      costUsd: 0.08,
      summary: "Unattached API session.",
      linked: false
    });
  } finally {
    db.close();
  }
}

function seedAcceptanceDispatchRuns(homeDir: string): void {
  const db = openForemanDatabase({ homeDir });

  try {
    expect(
      insertDispatchRun(db, {
        id: "run_019f6000-0000-7000-8000-000000000001",
        taskId: "FOREMAN-1",
        chunkId: "api",
        requestedStage: "review",
        status: "running",
        requestedBy: "local-user",
        source: "cli",
        createdAt: "2026-05-06T10:05:00.000Z",
        updatedAt: "2026-05-06T10:06:00.000Z"
      })
    ).toBe(1);
    expect(
      insertDispatchAttempt(db, {
        id: "attempt_019f6000-0000-7000-8000-000000000001",
        runId: "run_019f6000-0000-7000-8000-000000000001",
        attemptNumber: 1,
        status: "streaming_turn",
        tool: "codex",
        sessionId: "018f6000-0000-7000-8000-000000000001"
      })
    ).toBe(1);
    expect(
      insertDispatchEvent(db, {
        id: "evt_019f6000-0000-7000-8000-000000000001",
        runId: "run_019f6000-0000-7000-8000-000000000001",
        attemptId: "attempt_019f6000-0000-7000-8000-000000000001",
        ts: "2026-05-06T10:06:00.000Z",
        type: "attempt_started",
        message: "Attempt started.",
        dataJson: "{\"tool\":\"codex\"}"
      })
    ).toBe(1);
  } finally {
    db.close();
  }
}

function attachAcceptanceDispatchSession(homeDir: string, attemptId: string, sessionId: string): void {
  const db = openForemanDatabase({ homeDir });

  try {
    runSql(db, "UPDATE dispatch_attempts SET session_id = ? WHERE id = ?", [sessionId, attemptId]);
  } finally {
    db.close();
  }
}

function seedSession(
  db: Database,
  input: {
    id: string;
    source: "claude-code" | "codex";
    startedAt: string;
    projectPath: string;
    repoRemote: string;
    costUsd: number;
    summary: string;
    linked: boolean;
  }
): void {
  runSql(
    db,
    `INSERT INTO sessions (
      id,
      source,
      source_session_id,
      started_at,
      ended_at,
      project_path,
      repo_remote,
      model,
      machine,
      user_email,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.source,
      input.id,
      input.startedAt,
      input.startedAt,
      input.projectPath,
      input.repoRemote,
      input.source === "codex" ? "gpt-5.4-mini" : "claude-haiku",
      "devbox",
      "dev@example.com",
      input.startedAt
    ]
  );
  runSql(
    db,
    "INSERT INTO usage (session_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd) VALUES (?, 100, 50, 0, 0, ?)",
    [input.id, input.costUsd]
  );
  runSql(db, "INSERT INTO summaries (session_id, summary_md, model_used, generated_at) VALUES (?, ?, ?, ?)", [
    input.id,
    input.summary,
    "summary-model",
    input.startedAt
  ]);
  runSql(db, "INSERT INTO prompts (id, session_id, ts, content, content_hash) VALUES (?, ?, ?, ?, ?)", [
    `${input.id}-prompt`,
    input.id,
    input.startedAt,
    "Implement API.",
    `${input.id}-prompt-hash`
  ]);
  runSql(
    db,
    "INSERT INTO tool_calls (id, session_id, ts, tool_name, params_json, result_json, is_error, params_hash) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
    [
      `${input.id}-tool`,
      input.id,
      input.startedAt,
      "exec_command",
      "{\"cmd\":\"bun test\"}",
      "{\"exitCode\":0}",
      `${input.id}-params-hash`
    ]
  );

  if (input.linked) {
    runSql(
      db,
      "INSERT INTO session_chunks (session_id, task_id, chunk_id, stage, linked_at, linked_by) VALUES (?, 'FOREMAN-1', 'api', 'review', ?, 'hook')",
      [input.id, input.startedAt]
    );
  }
}

function runForeman(cwd: string, homeDir: string, argv: string[], env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
    env: { ...process.env, ...env, HOME: homeDir },
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
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

function createGitRepo(path: string, remote?: string): string {
  mkdirSync(path, { recursive: true });
  const init = Bun.spawnSync({
    cmd: ["git", "init"],
    cwd: path,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (init.exitCode !== 0) {
    throw new Error(decodeOutput(init.stderr));
  }

  if (remote !== undefined) {
    const addRemote = Bun.spawnSync({
      cmd: ["git", "remote", "add", "origin", remote],
      cwd: path,
      stdout: "pipe",
      stderr: "pipe"
    });

    if (addRemote.exitCode !== 0) {
      throw new Error(decodeOutput(addRemote.stderr));
    }
  }

  return path;
}

function commitAll(path: string): void {
  runGit(path, ["config", "user.email", "dev@example.com"]);
  runGit(path, ["config", "user.name", "Dev"]);
  runGit(path, ["add", "."]);
  runGit(path, ["commit", "-m", "Initial Foreman task"]);
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

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase6a-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});
