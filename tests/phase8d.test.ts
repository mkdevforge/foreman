import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { getDispatchRunDetailById } from "../src/db/dispatch-queries";
import { insertDispatchEvent, insertDispatchRun } from "../src/db/dispatch-writes";
import { cancelQueuedDispatchRun } from "../src/dispatch/cancel";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Phase 8d dispatch cancel CLI", () => {
  test("cancels a queued dispatch run exactly once", () => {
    const homeDir = createTempDir();
    const repo = setupReadyRepo();
    const created = JSON.parse(
      runForeman(repo, homeDir, ["dispatch", "create", "FOREMAN-8/dispatch-cancel-command", "--json"]).stdout
    );
    const runId = created.dispatch_run.id;

    const canceled = runForeman(repo, homeDir, ["dispatch", "cancel", runId.slice(0, 18), "--json"]);
    const parsed = JSON.parse(canceled.stdout);

    expect(canceled.exitCode).toBe(0);
    expect(canceled.stderr).toBe("");
    expect(parsed.changed).toBe(true);
    expect(parsed.dispatch_run).toMatchObject({
      id: runId,
      status: "canceled",
      finished_at: parsed.dispatch_run.updated_at
    });
    expect(parsed.dispatch_run.events.map((event: any) => event.type)).toEqual(["queued", "canceled"]);
    expect(JSON.parse(parsed.dispatch_run.events[1].data_json)).toEqual({
      previous_status: "queued",
      status: "canceled"
    });

    const again = JSON.parse(runForeman(repo, homeDir, ["dispatch", "cancel", runId, "--json"]).stdout);
    expect(again.changed).toBe(false);
    expect(again.dispatch_run.status).toBe("canceled");
    expect(again.dispatch_run.events.map((event: any) => event.type)).toEqual(["queued", "canceled"]);
  });

  test("rejects running runs without mutating rows", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    seedRun(homeDir, {
      id: "run_019f7000-0000-7000-8000-000000000001",
      status: "running"
    });

    const result = runForeman(cwd, homeDir, ["dispatch", "cancel", "run_019f7000-0000-7000-8000-000000000001", "--json"]);
    const parsed = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(parsed.error.code).toBe("dispatch_run_not_cancelable");
    expect(parsed.error.details.dispatch_run.status).toBe("running");

    const shown = JSON.parse(
      runForeman(cwd, homeDir, ["dispatch", "show", "run_019f7000-0000-7000-8000-000000000001", "--json"]).stdout
    );
    expect(shown.dispatch_run.status).toBe("running");
    expect(shown.dispatch_run.events.map((event: any) => event.type)).toEqual(["attempt_started"]);
  });

  test("does not append a cancel event when the queued status is lost before the conditional update", () => {
    const homeDir = createTempDir();
    const nonCancelableRunId = "run_019f7000-0000-7000-8000-000000000003";
    const alreadyCanceledRunId = "run_019f7000-0000-7000-8000-000000000004";
    seedRun(homeDir, { id: nonCancelableRunId, status: "queued" });
    seedRun(homeDir, { id: alreadyCanceledRunId, status: "queued" });
    const db = openForemanDatabase({ homeDir });

    try {
      const nonCancelable = cancelQueuedDispatchRun(db, nonCancelableRunId, {
        idGenerator: () => "019f7000-0000-7000-8000-000000000005",
        now: () => {
          db.prepare("UPDATE dispatch_runs SET status = ?, updated_at = ? WHERE id = ?").run(
            "claimed",
            "2026-05-11T18:00:02.000Z",
            nonCancelableRunId
          );
          return "2026-05-11T18:00:03.000Z";
        }
      });

      expect(nonCancelable.kind).toBe("not_cancelable");
      if (nonCancelable.kind === "not_cancelable") {
        expect(nonCancelable.detail.run.status).toBe("claimed");
      }

      const nonCancelableDetail = getDispatchRunDetailById(db, nonCancelableRunId);
      expect(nonCancelableDetail?.run.status).toBe("claimed");
      expect(nonCancelableDetail?.events.map((event) => event.type)).toEqual(["queued"]);

      const alreadyCanceled = cancelQueuedDispatchRun(db, alreadyCanceledRunId, {
        idGenerator: () => "019f7000-0000-7000-8000-000000000006",
        now: () => {
          db.prepare("UPDATE dispatch_runs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?").run(
            "canceled",
            "2026-05-11T18:00:04.000Z",
            "2026-05-11T18:00:04.000Z",
            alreadyCanceledRunId
          );
          return "2026-05-11T18:00:05.000Z";
        }
      });

      expect(alreadyCanceled.kind).toBe("already_canceled");

      const alreadyCanceledDetail = getDispatchRunDetailById(db, alreadyCanceledRunId);
      expect(alreadyCanceledDetail?.run.status).toBe("canceled");
      expect(alreadyCanceledDetail?.run.finished_at).toBe("2026-05-11T18:00:04.000Z");
      expect(alreadyCanceledDetail?.events.map((event) => event.type)).toEqual(["queued"]);
    } finally {
      db.close();
    }
  });

  test("reports missing and ambiguous cancel targets", () => {
    const homeDir = createTempDir();
    const cwd = createTempDir();
    seedRun(homeDir, {
      id: "run_019f7000-0000-7000-8000-000000000001",
      status: "queued"
    });
    seedRun(homeDir, {
      id: "run_019f7000-0000-7000-8000-000000000002",
      status: "queued"
    });

    const ambiguous = JSON.parse(runForeman(cwd, homeDir, ["dispatch", "cancel", "run_019f7000", "--json"]).stderr);
    expect(ambiguous.error.code).toBe("ambiguous_dispatch_run_prefix");

    const missing = JSON.parse(runForeman(cwd, homeDir, ["dispatch", "cancel", "run_missing", "--json"]).stderr);
    expect(missing.error.code).toBe("dispatch_run_not_found");
  });
});

function setupReadyRepo(): string {
  const repo = createGitRepo();
  const specPath = join(repo, "spec.md");
  writeFileSync(specPath, "Cancel a queued dispatch run.\n", "utf8");

  expect(runForeman(repo, createTempDir(), ["init"]).exitCode).toBe(0);
  expect(runForeman(repo, createTempDir(), ["task", "add", "FOREMAN-8", "--title", "Dispatch"]).exitCode).toBe(0);
  expect(
    runForeman(repo, createTempDir(), [
      "chunk",
      "add",
      "FOREMAN-8/dispatch-cancel-command",
      "--title",
      "Dispatch cancel",
      "--spec-file",
      specPath
    ]).exitCode
  ).toBe(0);
  expect(runForeman(repo, createTempDir(), ["chunk", "stage", "FOREMAN-8/dispatch-cancel-command", "implement"]).exitCode).toBe(
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
      chunkId: "dispatch-cancel-command",
      requestedStage: "implement",
      status: input.status,
      requestedBy: null,
      source: "cli",
      createdAt: "2026-05-11T18:00:00.000Z",
      updatedAt: "2026-05-11T18:00:00.000Z"
    });
    insertDispatchEvent(db, {
      id: input.id.replace(/^run_/, "evt_"),
      runId: input.id,
      ts: "2026-05-11T18:00:01.000Z",
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
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase8d-"));
  tempDirs.push(dir);
  return dir;
}

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}
