import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openForemanDatabase } from "../src/db/client";
import { getSessionSummary } from "../src/db/session-queries";
import { writeActiveContext } from "../src/store/active";
import { initializeForemanRepo, addTask, addChunk } from "../src/store/task-store";
import { runForemanHook, type HookName } from "../src/hook/runtime";
import type { SummaryProvider, SummaryRequest } from "../src/ingest";

const fixturesDir = fileURLToPath(new URL("fixtures/ingest/", import.meta.url));
const claudeTranscriptPath = join(fixturesDir, "claude-code-session.jsonl");
const codexSessionsRoot = join(fixturesDir, "codex", "sessions");
const tempDirs: string[] = [];

describe("Phase 4 Stop hook runtime and active linkage", () => {
  test("Claude hook ingests, links matching active context, and re-runs idempotently", async () => {
    const env = setupHookEnv();
    const summaryProvider = fakeSummaryProvider(() => ({ summary_md: "Claude summary", model_used: "fake-summary" }));
    const idGenerator = deterministicIds();

    const first = await runHook("foreman-hook-stop-claude-code", claudePayload(env.projectRepo), env.homeDir, {
      summaryProvider,
      idGenerator
    });
    const second = await runHook("foreman-hook-stop-claude-code", claudePayload(env.projectRepo), env.homeDir, {
      summaryProvider,
      idGenerator
    });
    const { db } = openDb(env.homeDir);

    try {
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toBe("");
      expect(first.stderr).toBe("");
      expect(second.exitCode).toBe(0);
      expect(countRows(db, "sessions")).toBe(1);
      expect(countRows(db, "session_chunks")).toBe(1);
      expect(db.query("SELECT stage, linked_by FROM session_chunks").get()).toEqual({
        stage: "implement",
        linked_by: "hook"
      });
      expect(getSessionSummary(db, "00000000-0000-7000-8000-000000000001")?.summary_md).toBe("Claude summary");
    } finally {
      db.close();
    }
  });

  test("Codex hook falls back to session transcript search when payload omits transcript_path", async () => {
    const env = setupHookEnv();

    await runHook("foreman-hook-stop-codex", codexPayload(env.projectRepo), env.homeDir, {
      summaryProvider: fakeSummaryProvider(() => ({ summary_md: "Codex summary", model_used: "fake-summary" })),
      codexSessionsRoot
    });
    const { db } = openDb(env.homeDir);

    try {
      expect(countRows(db, "sessions")).toBe(1);
      expect(countRows(db, "session_chunks")).toBe(1);
      expect(db.query("SELECT source, source_session_id, project_path FROM sessions").get()).toEqual({
        source: "codex",
        source_session_id: "codex-worktree-1",
        project_path: env.projectRepo
      });
    } finally {
      db.close();
    }
  });

  test("summary failures log but keep captured session and active link", async () => {
    const env = setupHookEnv();

    await runHook("foreman-hook-stop-claude-code", claudePayload(env.projectRepo), env.homeDir, {
      summaryProvider: failingSummaryProvider()
    });
    const { db } = openDb(env.homeDir);

    try {
      expect(countRows(db, "sessions")).toBe(1);
      expect(countRows(db, "session_chunks")).toBe(1);
      expect(countRows(db, "summaries")).toBe(0);
      expect(readHookLog(env.homeDir)).toContain("\"phase\":\"summary\"");
    } finally {
      db.close();
    }
  });

  test("malformed payloads and missing transcripts log and exit zero", async () => {
    const env = setupHookEnv();

    const malformed = await runHookRaw("foreman-hook-stop-codex", "{not-json", env.homeDir);
    const missingTranscript = await runHook(
      "foreman-hook-stop-claude-code",
      { ...claudePayload(env.projectRepo), transcript_path: join(env.projectRepo, "missing.jsonl") },
      env.homeDir
    );

    expect(malformed.exitCode).toBe(0);
    expect(missingTranscript.exitCode).toBe(0);
    expect(malformed.stdout).toBe("");
    expect(missingTranscript.stderr).toBe("");
    expect(readHookLog(env.homeDir)).toContain("parse_payload_json");
    expect(readHookLog(env.homeDir)).toContain("parse_transcript");
  });

  test("stale active contexts and project mismatches skip linkage only", async () => {
    const staleEnv = setupHookEnv({ createdAt: "2000-01-01T00:00:00.000Z" });
    await runHook("foreman-hook-stop-claude-code", claudePayload(staleEnv.projectRepo), staleEnv.homeDir);

    const mismatchEnv = setupHookEnv({ activeProjectRepo: createGitRepo(createTempDir()) });
    await runHook("foreman-hook-stop-claude-code", claudePayload(mismatchEnv.projectRepo), mismatchEnv.homeDir);

    const staleDb = openDb(staleEnv.homeDir).db;
    const mismatchDb = openDb(mismatchEnv.homeDir).db;
    try {
      expect(countRows(staleDb, "sessions")).toBe(1);
      expect(countRows(staleDb, "session_chunks")).toBe(0);
      expect(countRows(mismatchDb, "sessions")).toBe(1);
      expect(countRows(mismatchDb, "session_chunks")).toBe(0);
    } finally {
      staleDb.close();
      mismatchDb.close();
    }
  });
});

function setupHookEnv(options: { createdAt?: string; activeProjectRepo?: string } = {}): {
  controlRepo: string;
  projectRepo: string;
  homeDir: string;
} {
  const controlRepo = createGitRepo(createTempDir());
  const projectRepo = createGitRepo(createTempDir());
  const homeDir = createTempDir();

  initializeForemanRepo(controlRepo);
  addTask(controlRepo, { id: "FOREMAN-1", title: "Task" });
  addChunk(controlRepo, { taskId: "FOREMAN-1", chunkId: "yaml-store", title: "YAML store", spec: "" });
  writeActiveContext(
    {
      schema_version: 1,
      task_id: "FOREMAN-1",
      chunk_id: "yaml-store",
      stage: "implement",
      stage_override: "implement",
      control_repo_root: controlRepo,
      project_path: options.activeProjectRepo ?? projectRepo,
      created_at: options.createdAt ?? "2026-05-06T12:00:00.000Z"
    },
    homeDir
  );

  return { controlRepo, projectRepo, homeDir };
}

async function runHook(
  name: HookName,
  payload: unknown,
  homeDir: string,
  options: {
    summaryProvider?: SummaryProvider;
    idGenerator?: () => string;
    codexSessionsRoot?: string;
  } = {}
) {
  return runHookRaw(name, JSON.stringify(payload), homeDir, options);
}

async function runHookRaw(
  name: HookName,
  stdin: string,
  homeDir: string,
  options: {
    summaryProvider?: SummaryProvider;
    idGenerator?: () => string;
    codexSessionsRoot?: string;
  } = {}
) {
  let stdout = "";
  let stderr = "";
  const result = await runForemanHook(
    name,
    [],
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    },
    {
      stdin: () => stdin,
      homeDir,
      summaryProvider: options.summaryProvider ?? fakeSummaryProvider(() => ({ summary_md: "summary", model_used: "fake-summary" })),
      userEmail: "dev@example.com",
      machine: "devbox",
      idGenerator: options.idGenerator ?? deterministicIds(),
      now: () => "2026-05-06T12:00:00.000Z",
      codexSessionsRoot: options.codexSessionsRoot
    }
  );

  return { ...result, stdout, stderr };
}

function claudePayload(cwd: string) {
  return {
    session_id: "claude-worktree-1",
    transcript_path: claudeTranscriptPath,
    cwd,
    hook_event_name: "Stop"
  };
}

function codexPayload(cwd: string) {
  return {
    session_id: "codex-worktree-1",
    transcript_path: null,
    cwd,
    hook_event_name: "Stop",
    last_assistant_message: "Done"
  };
}

function fakeSummaryProvider(
  summarize: (request: SummaryRequest) => { summary_md: string; model_used: string; warnings?: string[] }
): SummaryProvider {
  return {
    async summarize(request) {
      return summarize(request);
    }
  };
}

function failingSummaryProvider(): SummaryProvider {
  return {
    async summarize() {
      throw new Error("summary unavailable");
    }
  };
}

function deterministicIds(): () => string {
  let next = 1;
  return () => `00000000-0000-7000-8000-${String(next++).padStart(12, "0")}`;
}

function openDb(homeDir: string): { db: Database } {
  return { db: openForemanDatabase({ homeDir }) };
}

function countRows(db: Database, table: string): number {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

function readHookLog(homeDir: string): string {
  return readFileSync(join(homeDir, ".foreman", "logs", "hook-errors.log"), "utf8");
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase4-hooks-"));
  tempDirs.push(dir);
  return dir;
}

function createGitRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  const result = Bun.spawnSync({
    cmd: ["git", "init"],
    cwd: path,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }

  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});
