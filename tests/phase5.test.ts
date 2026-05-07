import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { openForemanDatabase } from "../src/db/client";
import { runForemanHook } from "../src/hook/runtime";
import type { SummaryProvider, SummaryRequest } from "../src/ingest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const claudeTranscriptPath = join(repoRoot, "tests", "fixtures", "ingest", "claude-code-session.jsonl");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

interface SeedSessionInput {
  id: string;
  source: "claude-code" | "codex";
  startedAt: string;
  projectPath: string;
  sourceSessionId?: string;
  endedAt?: string;
  repoRemote?: string | null;
  model?: string | null;
  costUsd?: number;
  summary?: string;
  links?: SeedLinkInput[];
  prompts?: boolean;
  toolCalls?: boolean;
}

interface SeedLinkInput {
  taskId: string;
  chunkId: string;
  stage: string;
  linkedBy?: string;
}

describe("Phase 5 review CLI", () => {
  test("chunk review handles no linked sessions and missing chunks", () => {
    const env = setupForemanRepo();

    const empty = runForeman(env.controlRepo, env.homeDir, ["review", "FOREMAN-1/empty"]);
    const missing = runForeman(env.controlRepo, env.homeDir, ["review", "FOREMAN-1/missing"]);

    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("Chunk Review FOREMAN-1/empty\n");
    expect(empty.stdout).toContain("Linked sessions:\n  none\n");
    expect(empty.stdout).toContain("Total linked cost_usd: 0.0000\n");
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("chunk 'FOREMAN-1/missing' was not found");
  });

  test("chunk and task review join YAML with linked sessions, summaries, costs, and full details", () => {
    const env = setupForemanRepo();
    seedReviewSessions(env.homeDir, env.controlRepo);

    const chunk = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["review", "FOREMAN-1/yaml-store", "--full", "--json"]).stdout);
    const task = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["review", "FOREMAN-1", "--json"]).stdout);

    expect(chunk.schema_version).toBe(1);
    expect(chunk.review.type).toBe("chunk");
    expect(chunk.review.total_cost_usd).toBe(0.7);
    expect(chunk.review.linked_sessions_by_stage.map((group: any) => group.stage)).toEqual(["implement", "review"]);
    expect(chunk.review.linked_sessions_by_stage[0].sessions[0].session.prompts).toHaveLength(1);
    expect(chunk.review.linked_sessions_by_stage[0].sessions[0].session.tool_calls).toHaveLength(1);
    expect(chunk.review.linked_sessions_by_stage[0].sessions[0].session.summary.summary_md).toBe("Implemented YAML store.");

    expect(task.review.type).toBe("task");
    expect(task.review.total_linked_sessions).toBe(3);
    expect(task.review.total_cost_usd).toBe(0.7);
    expect(task.review.chunk_rollups).toEqual([
      expect.objectContaining({ chunk: expect.objectContaining({ id: "api" }), linked_session_count: 1, total_cost_usd: 0.5 }),
      expect.objectContaining({ chunk: expect.objectContaining({ id: "empty" }), linked_session_count: 0, total_cost_usd: 0 }),
      expect.objectContaining({ chunk: expect.objectContaining({ id: "yaml-store" }), linked_session_count: 3, total_cost_usd: 0.7 })
    ]);
  });
});

describe("Phase 5 catalog CLI", () => {
  test("catalog scopes unattached sessions by normalized remote, --all, --since, and path-only fallback", () => {
    const root = createTempDir();
    const homeDir = createTempDir();
    const controlRepo = createGitRepo(join(root, "control"), "git@github.com:Example/Repo.git");
    const siblingRepo = createGitRepo(join(root, "sibling"), "https://github.com/example/repo.git");
    const otherRepo = createGitRepo(join(root, "other"), "git@github.com:other/repo.git");
    initForemanYaml(controlRepo, homeDir);
    seedSessions(homeDir, [
      {
        id: "018f5000-0000-7000-8000-000000000101",
        source: "codex",
        startedAt: "2026-05-06T10:00:00.000Z",
        projectPath: controlRepo,
        repoRemote: "https://github.com/example/repo.git",
        summary: "Current repo session."
      },
      {
        id: "018f5000-0000-7000-8000-000000000102",
        source: "claude-code",
        startedAt: "2026-05-06T09:00:00.000Z",
        projectPath: siblingRepo,
        repoRemote: "git@github.com:example/repo.git",
        summary: "Sibling worktree session."
      },
      {
        id: "018f5000-0000-7000-8000-000000000103",
        source: "codex",
        startedAt: "2026-05-06T08:00:00.000Z",
        projectPath: otherRepo,
        repoRemote: "git@github.com:other/repo.git",
        summary: "Other repo session."
      },
      {
        id: "018f5000-0000-7000-8000-000000000104",
        source: "codex",
        startedAt: "2000-01-01T00:00:00.000Z",
        projectPath: controlRepo,
        repoRemote: "git@github.com:example/repo.git",
        summary: "Old session."
      },
      {
        id: "018f5000-0000-7000-8000-000000000105",
        source: "codex",
        startedAt: "2026-05-06T07:00:00.000Z",
        projectPath: controlRepo,
        repoRemote: "git@github.com:example/repo.git",
        links: [{ taskId: "FOREMAN-1", chunkId: "yaml-store", stage: "review" }]
      }
    ]);

    const scoped = JSON.parse(runForeman(controlRepo, homeDir, ["catalog", "--since", "2w", "--json"]).stdout);
    const all = JSON.parse(runForeman(controlRepo, homeDir, ["catalog", "--since", "2w", "--all", "--json"]).stdout);

    expect(scoped.catalog.scope.normalized_repo_remote).toBe("github.com/example/repo");
    expect(scoped.catalog.candidates.map((session: any) => session.id)).toEqual([
      "018f5000-0000-7000-8000-000000000101",
      "018f5000-0000-7000-8000-000000000102"
    ]);
    expect(all.catalog.candidates.map((session: any) => session.id)).toEqual([
      "018f5000-0000-7000-8000-000000000101",
      "018f5000-0000-7000-8000-000000000102",
      "018f5000-0000-7000-8000-000000000103"
    ]);

    const noRemoteHome = createTempDir();
    const noRemoteRepo = createGitRepo(join(root, "no-remote"));
    const noRemoteSibling = createGitRepo(join(root, "no-remote-sibling"));
    initForemanYaml(noRemoteRepo, noRemoteHome);
    seedSessions(noRemoteHome, [
      {
        id: "018f5000-0000-7000-8000-000000000201",
        source: "codex",
        startedAt: "2026-05-06T10:00:00.000Z",
        projectPath: noRemoteRepo,
        repoRemote: null
      },
      {
        id: "018f5000-0000-7000-8000-000000000202",
        source: "codex",
        startedAt: "2026-05-06T09:00:00.000Z",
        projectPath: noRemoteSibling,
        repoRemote: null
      }
    ]);

    const pathOnly = runForeman(noRemoteRepo, noRemoteHome, ["catalog", "--json"]);
    const pathOnlyText = runForeman(noRemoteRepo, noRemoteHome, ["catalog"], "quit\n");

    expect(JSON.parse(pathOnly.stdout).catalog.candidates.map((session: any) => session.id)).toEqual([
      "018f5000-0000-7000-8000-000000000201"
    ]);
    expect(pathOnlyText.stdout).toContain("No origin remote found; catalog is limited to this worktree path.");
  });

  test("catalog one-shot link and unlink are idempotent and keep chunk YAML unchanged", () => {
    const env = setupForemanRepo();
    seedSessions(env.homeDir, [
      {
        id: "018f5000-0000-7000-8000-000000000301",
        source: "codex",
        startedAt: "2026-05-06T10:00:00.000Z",
        projectPath: env.controlRepo,
        repoRemote: "git@github.com:mkdevforge/foreman.git"
      }
    ]);

    const linked = runForeman(env.controlRepo, env.homeDir, [
      "catalog",
      "--link",
      "018f5000-0000-7000-8000-000000000301",
      "FOREMAN-1/yaml-store",
      "--stage",
      "implement",
      "--json"
    ]);
    const linkedAgain = runForeman(env.controlRepo, env.homeDir, [
      "catalog",
      "--link",
      "018f5000-0000-7000-8000-000000000301",
      "FOREMAN-1/yaml-store",
      "--stage",
      "implement",
      "--json"
    ]);
    const yaml = parse(readFileSync(join(env.controlRepo, ".foreman", "tasks", "FOREMAN-1.yaml"), "utf8")) as any;

    expect(linked.exitCode).toBe(0);
    expect(JSON.parse(linked.stdout).catalog).toMatchObject({
      action: "link",
      stage: "implement",
      linked_by: "catalog",
      changed: true
    });
    expect(JSON.parse(linkedAgain.stdout).catalog.changed).toBe(false);
    expect(readLinkRows(env.homeDir)).toEqual([
      {
        session_id: "018f5000-0000-7000-8000-000000000301",
        task_id: "FOREMAN-1",
        chunk_id: "yaml-store",
        stage: "implement",
        linked_by: "catalog"
      }
    ]);
    expect(yaml.chunks.find((chunk: any) => chunk.id === "yaml-store").stage).toBe("discovery");

    const unlinked = runForeman(env.controlRepo, env.homeDir, [
      "catalog",
      "--unlink",
      "018f5000-0000-7000-8000-000000000301",
      "FOREMAN-1/yaml-store",
      "--json"
    ]);
    const unlinkedAgain = runForeman(env.controlRepo, env.homeDir, [
      "catalog",
      "--unlink",
      "018f5000-0000-7000-8000-000000000301",
      "FOREMAN-1/yaml-store",
      "--json"
    ]);

    expect(JSON.parse(unlinked.stdout).catalog.changed).toBe(true);
    expect(JSON.parse(unlinkedAgain.stdout).catalog.changed).toBe(false);
    expect(readLinkRows(env.homeDir)).toEqual([]);
  });

  test("interactive catalog links, skips, quits, reprompts invalid refs, and JSON mode never prompts", () => {
    const env = setupForemanRepo();
    seedSessions(env.homeDir, [
      {
        id: "018f5000-0000-7000-8000-000000000401",
        source: "codex",
        startedAt: "2026-05-06T12:00:00.000Z",
        projectPath: env.controlRepo,
        repoRemote: "git@github.com:mkdevforge/foreman.git",
        summary: "First candidate."
      },
      {
        id: "018f5000-0000-7000-8000-000000000402",
        source: "codex",
        startedAt: "2026-05-06T11:00:00.000Z",
        projectPath: env.controlRepo,
        repoRemote: "git@github.com:mkdevforge/foreman.git",
        summary: "Second candidate."
      },
      {
        id: "018f5000-0000-7000-8000-000000000403",
        source: "codex",
        startedAt: "2026-05-06T10:00:00.000Z",
        projectPath: env.controlRepo,
        repoRemote: "git@github.com:mkdevforge/foreman.git",
        summary: "Third candidate."
      }
    ]);

    const interactive = runForeman(env.controlRepo, env.homeDir, ["catalog"], [
      "BAD-1/nope",
      "FOREMAN-1/yaml-store",
      "skip",
      "quit"
    ].join("\n") + "\n");
    const json = runForeman(env.controlRepo, env.homeDir, ["catalog", "--json"], "FOREMAN-1/api\n");

    expect(interactive.exitCode).toBe(0);
    expect(interactive.stdout).toContain("Invalid selection:");
    expect(interactive.stdout).toContain("Linked session 018f5000-0000-7000-8000-000000000401 to FOREMAN-1/yaml-store.");
    expect(interactive.stdout).toContain("Skipped 018f5000-0000-7000-8000-000000000402.");
    expect(interactive.stdout).toContain("Stopped catalog.");
    expect(json.stdout).not.toContain("Link to <task>/<chunk>");
    expect(readLinkRows(env.homeDir)).toEqual([
      {
        session_id: "018f5000-0000-7000-8000-000000000401",
        task_id: "FOREMAN-1",
        chunk_id: "yaml-store",
        stage: "discovery",
        linked_by: "catalog"
      }
    ]);
  });
});

describe("Phase 5 session cost CLI", () => {
  test("session cost reports every grouping, includes unlinked sessions, and rejects invalid --by values", () => {
    const env = setupForemanRepo();
    seedReviewSessions(env.homeDir, env.controlRepo);
    seedSessions(env.homeDir, [
      {
        id: "018f5000-0000-7000-8000-000000000901",
        source: "codex",
        startedAt: "2026-05-06T13:00:00.000Z",
        projectPath: env.controlRepo,
        repoRemote: "git@github.com:mkdevforge/foreman.git",
        model: null,
        costUsd: 0.04
      }
    ]);

    for (const by of ["source", "project", "task", "chunk", "model", "day"]) {
      const result = runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", by, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).cost.by).toBe(by);
    }

    const source = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "source", "--json"]).stdout);
    const project = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "project", "--json"]).stdout);
    const task = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "task", "--json"]).stdout);
    const chunk = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "chunk", "--json"]).stdout);
    const model = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "model", "--json"]).stdout);
    const day = JSON.parse(runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "day", "--json"]).stdout);
    const invalid = runForeman(env.controlRepo, env.homeDir, ["session", "cost", "--by", "provider"]);

    expect(source.cost.overall).toEqual({ session_count: 4, total_cost_usd: 0.74 });
    expect(source.cost.groups).toEqual([
      { source: "claude-code", session_count: 1, total_cost_usd: 0.08 },
      { source: "codex", session_count: 3, total_cost_usd: 0.66 }
    ]);
    expect(project.cost.groups).toEqual([{ project_path: env.controlRepo, session_count: 4, total_cost_usd: 0.74 }]);
    expect(task.cost.groups).toContainEqual({ task_id: null, session_count: 1, total_cost_usd: 0.04 });
    expect(task.cost.groups).toContainEqual({ task_id: "FOREMAN-1", session_count: 3, total_cost_usd: 0.7 });
    expect(chunk.cost.groups).toContainEqual({ task_id: null, chunk_id: null, session_count: 1, total_cost_usd: 0.04 });
    expect(chunk.cost.groups).toContainEqual({ task_id: "FOREMAN-1", chunk_id: "api", session_count: 1, total_cost_usd: 0.5 });
    expect(chunk.cost.groups).toContainEqual({ task_id: "FOREMAN-1", chunk_id: "yaml-store", session_count: 3, total_cost_usd: 0.7 });
    expect(model.cost.groups).toContainEqual({ model: null, session_count: 1, total_cost_usd: 0.04 });
    expect(day.cost.groups).toEqual([{ day: "2026-05-06", session_count: 4, total_cost_usd: 0.74 }]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stderr).toContain("invalid --by value 'provider'");
  });
});

describe("Phase 5 hook repo remote fallback", () => {
  test("Stop hook ingestion fills missing repo_remote from the session project path", async () => {
    const projectRepo = createGitRepo(createTempDir(), "git@github.com:mkdevforge/foreman.git");
    const homeDir = createTempDir();
    let stdout = "";
    let stderr = "";

    const result = await runForemanHook(
      "foreman-hook-stop-claude-code",
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
        stdin: () =>
          JSON.stringify({
            session_id: "claude-worktree-1",
            transcript_path: claudeTranscriptPath,
            cwd: projectRepo,
            hook_event_name: "Stop"
          }),
        homeDir,
        summaryProvider: fakeSummaryProvider(() => ({ summary_md: "summary", model_used: "fake-summary" })),
        userEmail: "dev@example.com",
        machine: "devbox",
        idGenerator: deterministicIds(),
        now: () => "2026-05-06T12:00:00.000Z"
      }
    );

    expect(result.exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(readSessions(homeDir)).toEqual([
      {
        id: "00000000-0000-7000-8000-000000000001",
        repo_remote: "git@github.com:mkdevforge/foreman.git"
      }
    ]);
  });
});

function setupForemanRepo(): { controlRepo: string; homeDir: string } {
  const homeDir = createTempDir();
  const controlRepo = createGitRepo(createTempDir(), "git@github.com:mkdevforge/foreman.git");
  initForemanYaml(controlRepo, homeDir);
  return { controlRepo, homeDir };
}

function initForemanYaml(controlRepo: string, homeDir: string): void {
  expect(runForeman(controlRepo, homeDir, ["init"]).exitCode).toBe(0);
  expect(runForeman(controlRepo, homeDir, ["task", "add", "FOREMAN-1", "--title", "Task"]).exitCode).toBe(0);
  expect(runForeman(controlRepo, homeDir, ["chunk", "add", "FOREMAN-1/api", "--title", "API"]).exitCode).toBe(0);
  expect(runForeman(controlRepo, homeDir, ["chunk", "add", "FOREMAN-1/empty", "--title", "Empty"]).exitCode).toBe(0);
  expect(
    runForeman(controlRepo, homeDir, ["chunk", "add", "FOREMAN-1/yaml-store", "--title", "YAML store", "--spec-file", specFile(controlRepo)]).exitCode
  ).toBe(0);
}

function specFile(repo: string): string {
  const path = join(repo, "spec.md");
  writeFileSync(path, "Build the YAML-backed task store.\n", "utf8");
  return path;
}

function seedReviewSessions(homeDir: string, projectPath: string): void {
  seedSessions(homeDir, [
    {
      id: "018f5000-0000-7000-8000-000000000001",
      source: "codex",
      startedAt: "2026-05-06T10:00:00.000Z",
      projectPath,
      repoRemote: "git@github.com:mkdevforge/foreman.git",
      model: "gpt-5.4-mini",
      costUsd: 0.12,
      summary: "Implemented YAML store.",
      prompts: true,
      toolCalls: true,
      links: [{ taskId: "FOREMAN-1", chunkId: "yaml-store", stage: "implement", linkedBy: "hook" }]
    },
    {
      id: "018f5000-0000-7000-8000-000000000002",
      source: "claude-code",
      startedAt: "2026-05-06T09:00:00.000Z",
      projectPath,
      repoRemote: "git@github.com:mkdevforge/foreman.git",
      model: "claude-haiku",
      costUsd: 0.08,
      summary: "Reviewed YAML store.",
      links: [{ taskId: "FOREMAN-1", chunkId: "yaml-store", stage: "review", linkedBy: "catalog" }]
    },
    {
      id: "018f5000-0000-7000-8000-000000000003",
      source: "codex",
      startedAt: "2026-05-06T08:00:00.000Z",
      projectPath,
      repoRemote: "git@github.com:mkdevforge/foreman.git",
      model: "gpt-5.4-mini",
      costUsd: 0.5,
      summary: "Shared session touched two chunks.",
      links: [
        { taskId: "FOREMAN-1", chunkId: "api", stage: "implement", linkedBy: "hook" },
        { taskId: "FOREMAN-1", chunkId: "yaml-store", stage: "implement", linkedBy: "hook" }
      ]
    }
  ]);
}

function seedSessions(homeDir: string, sessions: SeedSessionInput[]): void {
  const db = openForemanDatabase({ homeDir });

  try {
    for (const session of sessions) {
      seedSession(db, session);
    }
  } finally {
    db.close();
  }
}

function seedSession(db: Database, session: SeedSessionInput): void {
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
      session.id,
      session.source,
      session.sourceSessionId ?? session.id,
      session.startedAt,
      session.endedAt ?? session.startedAt,
      session.projectPath,
      session.repoRemote ?? null,
      session.model ?? null,
      "devbox",
      "dev@example.com",
      session.startedAt
    ]
  );

  if (session.costUsd !== undefined) {
    runSql(
      db,
      `INSERT INTO usage (
        session_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cost_usd
      ) VALUES (?, 100, 50, 0, 0, ?)`,
      [session.id, session.costUsd]
    );
  }

  if (session.summary !== undefined) {
    runSql(db, "INSERT INTO summaries (session_id, summary_md, model_used, generated_at) VALUES (?, ?, ?, ?)", [
      session.id,
      session.summary,
      "summary-model",
      session.startedAt
    ]);
  }

  if (session.prompts === true) {
    runSql(db, "INSERT INTO prompts (id, session_id, ts, content, content_hash) VALUES (?, ?, ?, ?, ?)", [
      `${session.id}-prompt`,
      session.id,
      session.startedAt,
      "Implement the YAML store.",
      `${session.id}-prompt-hash`
    ]);
  }

  if (session.toolCalls === true) {
    runSql(
      db,
      "INSERT INTO tool_calls (id, session_id, ts, tool_name, params_json, result_json, is_error, params_hash) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      [
        `${session.id}-tool`,
        session.id,
        session.startedAt,
        "exec_command",
        "{\"cmd\":\"bun test\"}",
        "{\"exitCode\":0}",
        `${session.id}-params-hash`
      ]
    );
  }

  for (const link of session.links ?? []) {
    runSql(
      db,
      `INSERT INTO session_chunks (
        session_id,
        task_id,
        chunk_id,
        stage,
        linked_at,
        linked_by
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [session.id, link.taskId, link.chunkId, link.stage, session.startedAt, link.linkedBy ?? "manual"]
    );
  }
}

function readLinkRows(homeDir: string): any[] {
  const db = openForemanDatabase({ homeDir });

  try {
    return db
      .query<any, []>(
        "SELECT session_id, task_id, chunk_id, stage, linked_by FROM session_chunks ORDER BY session_id, task_id, chunk_id"
      )
      .all();
  } finally {
    db.close();
  }
}

function readSessions(homeDir: string): any[] {
  const db = openForemanDatabase({ homeDir });

  try {
    return db.query<any, []>("SELECT id, repo_remote FROM sessions ORDER BY id").all();
  } finally {
    db.close();
  }
}

function runForeman(cwd: string, homeDir: string, argv: string[], stdin?: string) {
  const stdinFile = stdin === undefined ? undefined : writeStdinFile(stdin);
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd,
    env: { ...process.env, HOME: homeDir },
    stdin: stdinFile === undefined ? "ignore" : Bun.file(stdinFile),
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode,
    stdout: decodeOutput(result.stdout),
    stderr: decodeOutput(result.stderr)
  };
}

function writeStdinFile(body: string): string {
  const path = join(createTempDir(), "stdin.txt");
  writeFileSync(path, body, "utf8");
  return path;
}

function createGitRepo(path: string, remote?: string): string {
  mkdirSync(path, { recursive: true });
  runGit(path, ["init"]);

  if (remote !== undefined) {
    runGit(path, ["remote", "add", "origin", remote]);
  }

  return realpathSync(path);
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

function fakeSummaryProvider(
  summarize: (request: SummaryRequest) => { summary_md: string; model_used: string; warnings?: string[] }
): SummaryProvider {
  return {
    async summarize(request) {
      return summarize(request);
    }
  };
}

function deterministicIds(): () => string {
  let next = 1;
  return () => `00000000-0000-7000-8000-${String(next++).padStart(12, "0")}`;
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-phase5-"));
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
