import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { getDispatchRunDetailById } from "../src/db/dispatch-queries";
import { insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";
import { claimQueuedDispatchRun } from "../src/dispatch/claim";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 8e dispatch claim CLI", () => {
  test("claims a queued dispatch run for a selected tool", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const created = JSON.parse(
      runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-8/dispatch-claim-command", "--json"]).stdout
    );
    const runId = created.dispatch_run.id;

    const claimed = runForeman(repo, homeDir, ["dispatch", "claim", runId.slice(0, 18), "--tool", "codex", "--json"]);
    const parsed = JSON.parse(claimed.stdout);

    expect(claimed.exitCode).toBe(0);
    expect(claimed.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.dispatch_run).toMatchObject({
      id: runId,
      status: "claimed",
      finished_at: null
    });
    expect(parsed.dispatch_run.events.map((event: any) => event.type)).toEqual(["queued", "claimed"]);
    expect(JSON.parse(parsed.dispatch_run.events[1].data_json)).toEqual({
      previous_status: "queued",
      status: "claimed",
      tool: "codex"
    });

    const listed = JSON.parse(runForeman(repo, homeDir, ["dispatch", "list", "--status", "claimed", "--json"]).stdout);
    expect(listed.dispatch_runs.map((run: any) => run.id)).toEqual([runId]);
  });

  test("rejects non-queued and invalid-tool claims without mutating rows", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    seedRun(homeDir, {
      id: "run_019f8000-0000-7000-8000-000000000001",
      status: "running"
    });
    seedRun(homeDir, {
      id: "run_019f8000-0000-7000-8000-000000000002",
      status: "queued"
    });

    const notClaimable = runForeman(cwd, homeDir, [
      "dispatch",
      "claim",
      "run_019f8000-0000-7000-8000-000000000001",
      "--tool",
      "claude-code",
      "--json"
    ]);
    const notClaimableParsed = JSON.parse(notClaimable.stderr);

    expect(notClaimable.exitCode).toBe(2);
    expect(notClaimable.stdout).toBe("");
    expect(notClaimableParsed.error.code).toBe("dispatch_run_not_claimable");
    expect(notClaimableParsed.error.details.dispatch_run.status).toBe("running");

    const invalidTool = runForeman(cwd, homeDir, [
      "dispatch",
      "claim",
      "run_019f8000-0000-7000-8000-000000000002",
      "--tool",
      "other",
      "--json"
    ]);
    const invalidToolParsed = JSON.parse(invalidTool.stderr);

    expect(invalidTool.exitCode).toBe(2);
    expect(invalidTool.stdout).toBe("");
    expect(invalidToolParsed.error.code).toBe("invalid_tool");

    const shownRunning = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "show", "run_019f8000-0000-7000-8000-000000000001", "--json"]).stdout
    );
    expect(shownRunning.dispatch_run.status).toBe("running");
    expect(shownRunning.dispatch_run.events.map((event: any) => event.type)).toEqual(["attempt_started"]);

    const shownQueued = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "show", "run_019f8000-0000-7000-8000-000000000002", "--json"]).stdout
    );
    expect(shownQueued.dispatch_run.status).toBe("queued");
    expect(shownQueued.dispatch_run.events.map((event: any) => event.type)).toEqual(["queued"]);
  });

  test("does not append a claim event when the queued status is lost before the conditional update", () => {
    const homeDir = createTempDir();
    const runId = "run_019f8000-0000-7000-8000-000000000003";
    seedRun(homeDir, { id: runId, status: "queued" });
    const db = openForemanDatabase({ homeDir });

    try {
      const result = claimQueuedDispatchRun(db, runId, {
        tool: "codex",
        idGenerator: () => "019f8000-0000-7000-8000-000000000004",
        now: () => {
          db.prepare("UPDATE dispatch_runs SET status = ?, updated_at = ? WHERE id = ?").run(
            "running",
            "2026-05-11T19:00:02.000Z",
            runId
          );
          return "2026-05-11T19:00:03.000Z";
        }
      });

      expect(result.kind).toBe("not_claimable");
      if (result.kind === "not_claimable") {
        expect(result.detail.run.status).toBe("running");
      }

      const detail = getDispatchRunDetailById(db, runId);
      expect(detail?.run.status).toBe("running");
      expect(detail?.events.map((event) => event.type)).toEqual(["queued"]);
    } finally {
      db.close();
    }
  });

  test("reports missing and ambiguous claim targets", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    seedRun(homeDir, {
      id: "run_019f8000-0000-7000-8000-000000000001",
      status: "queued"
    });
    seedRun(homeDir, {
      id: "run_019f8000-0000-7000-8000-000000000002",
      status: "queued"
    });

    const ambiguous = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "claim", "run_019f8000", "--tool", "codex", "--json"]).stderr
    );
    expect(ambiguous.error.code).toBe("ambiguous_dispatch_run_prefix");

    const missing = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "claim", "run_missing", "--tool", "codex", "--json"]).stderr
    );
    expect(missing.error.code).toBe("dispatch_run_not_found");
  });
});

function setupReadyRepo(): string {
  const repo = createGitRepo();
  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, "Claim a queued dispatch run.\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-8", "--title", "Dispatch"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-8/dispatch-claim-command",
      "--title",
      "Dispatch claim",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-8/dispatch-claim-command", "implement"]).exitCode).toBe(
    0
  );

  const task = readTaskYaml(repo);
  task.chunks[0].dispatch = {
    status: "ready",
    risk_level: "low",
    approval_required: "none",
    allowed_actions: ["edit_source", "run_tests"],
    blocked_actions: ["launch_runner"]
  };
  writeFileSync(taskYamlPath(repo), stringify(task), "utf8");

  return repo;
}

function seedRun(homeDir: string, input: { id: string; status: string }): void {
  const db = openForemanDatabase({ homeDir });

  try {
    insertDispatchRun(db, {
      id: input.id,
      taskId: "FOREMAN-8",
      chunkId: "dispatch-claim-command",
      requestedStage: "implement",
      status: input.status,
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-11T19:00:00.000Z",
      updatedAt: "2026-05-11T19:00:00.000Z"
    });
    insertDispatchEvent(db, {
      id: input.id.replace(/^run_/, "evt_"),
      runId: input.id,
      ts: "2026-05-11T19:00:01.000Z",
      type: input.status === "running" ? "attempt_started" : "queued",
      message: "Seeded dispatch event.",
      dataJson: "{}"
    });
  } finally {
    db.close();
  }
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

function readTaskYaml(repo: string): Record<string, any> {
  return parse(readFileSync(taskYamlPath(repo), "utf8")) as Record<string, any>;
}

function taskYamlPath(repo: string): string {
  return join(repo, ".foreman", "tasks", "FOREMAN-8.yaml");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase8e-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
