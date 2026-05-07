import { afterEach, describe, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openForemanDatabase } from "../../src/db/client";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const foremanBin = join(repoRoot, "foreman");
const decoder = new TextDecoder();
const tempDirs: string[] = [];

interface SeedSessionInput {
  id: string;
  source: "claude-code" | "codex";
  sourceSessionId: string;
  startedAt: string;
  endedAt?: string;
  projectPath: string;
  repoRemote?: string | null;
  model?: string | null;
  usage?: SeedUsageInput;
  summary?: SeedSummaryInput;
  links?: SeedLinkInput[];
  prompts?: SeedPromptInput[];
  toolCalls?: SeedToolCallInput[];
}

interface SeedUsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

interface SeedSummaryInput {
  summaryMd: string;
  modelUsed?: string;
  generatedAt?: string;
}

interface SeedLinkInput {
  taskId: string;
  chunkId: string;
  stage: string;
  linkedAt?: string;
  linkedBy?: string;
}

interface SeedPromptInput {
  id: string;
  ts: string;
  content: string;
  contentHash: string;
}

interface SeedToolCallInput {
  id: string;
  ts: string;
  toolName: string;
  paramsJson: string;
  resultJson?: string | null;
  isError?: boolean;
  paramsHash: string;
}

interface SeededSessions {
  recentCodex: SeedSessionInput;
  hourlyClaude: SeedSessionInput;
  dailyCodex: SeedSessionInput;
  tenDayClaude: SeedSessionInput;
}

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-session-test-"));
  tempDirs.push(dir);
  return dir;
}

function runForeman(homeDir: string, argv: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, foremanBin, ...argv],
    cwd: repoRoot,
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

function decodeOutput(output: string | Uint8Array | null | undefined): string {
  if (!output) {
    return "";
  }

  return typeof output === "string" ? output : decoder.decode(output);
}

function seedStandardSessions(homeDir: string): SeededSessions {
  const now = Date.now();
  const recentStartedAt = isoOffset(now, -10 * 60 * 1000);
  const hourlyStartedAt = isoOffset(now, -2 * 60 * 60 * 1000);
  const dailyStartedAt = isoOffset(now, -2 * 24 * 60 * 60 * 1000);
  const tenDayStartedAt = isoOffset(now, -10 * 24 * 60 * 60 * 1000);

  const sessions: SeededSessions = {
    recentCodex: {
      id: "018f2a00-aaaa-7000-b000-000000000002",
      source: "codex",
      sourceSessionId: "codex-alpha-recent",
      startedAt: recentStartedAt,
      endedAt: isoOffsetFrom(recentStartedAt, 5 * 60 * 1000),
      projectPath: "/repo/alpha",
      repoRemote: "git@example.com:alpha/repo.git",
      model: "gpt-5.3-codex",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.12
      },
      summary: {
        summaryMd: "Recent alpha work.",
        modelUsed: "summary-model",
        generatedAt: isoOffsetFrom(recentStartedAt, 6 * 60 * 1000)
      },
      links: [
        {
          taskId: "FOREMAN-1",
          chunkId: "sqlite-schema",
          stage: "implement",
          linkedAt: isoOffsetFrom(recentStartedAt, 7 * 60 * 1000),
          linkedBy: "hook"
        }
      ],
      prompts: [
        {
          id: "prompt-recent-1",
          ts: isoOffsetFrom(recentStartedAt, 60 * 1000),
          content: "Implement the session query CLI.",
          contentHash: "prompt-hash-recent"
        }
      ],
      toolCalls: [
        {
          id: "tool-recent-1",
          ts: isoOffsetFrom(recentStartedAt, 2 * 60 * 1000),
          toolName: "exec_command",
          paramsJson: "{\"cmd\":\"bun test tests/db\"}",
          resultJson: "{\"exitCode\":0}",
          isError: false,
          paramsHash: "params-hash-recent"
        }
      ]
    },
    hourlyClaude: {
      id: "018f2a00-aaaa-7000-b000-000000000001",
      source: "claude-code",
      sourceSessionId: "claude-alpha-hourly",
      startedAt: hourlyStartedAt,
      endedAt: isoOffsetFrom(hourlyStartedAt, 4 * 60 * 1000),
      projectPath: "/repo/alpha",
      repoRemote: null,
      model: "claude-sonnet",
      summary: {
        summaryMd: "Hourly alpha follow-up.",
        modelUsed: "summary-model",
        generatedAt: isoOffsetFrom(hourlyStartedAt, 5 * 60 * 1000)
      }
    },
    dailyCodex: {
      id: "018f2b00-bbbb-7000-b000-000000000003",
      source: "codex",
      sourceSessionId: "codex-beta-daily",
      startedAt: dailyStartedAt,
      endedAt: isoOffsetFrom(dailyStartedAt, 3 * 60 * 1000),
      projectPath: "/repo/beta",
      repoRemote: null,
      model: null,
      links: [
        {
          taskId: "FOREMAN-2",
          chunkId: "session-query",
          stage: "review",
          linkedAt: isoOffsetFrom(dailyStartedAt, 4 * 60 * 1000),
          linkedBy: "catalog"
        }
      ]
    },
    tenDayClaude: {
      id: "018f2c00-cccc-7000-b000-000000000004",
      source: "claude-code",
      sourceSessionId: "claude-gamma-old",
      startedAt: tenDayStartedAt,
      endedAt: isoOffsetFrom(tenDayStartedAt, 2 * 60 * 1000),
      projectPath: "/repo/gamma",
      repoRemote: "git@example.com:gamma/repo.git",
      model: "claude-haiku",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01
      }
    }
  };

  seedSessions(homeDir, Object.values(sessions));
  return sessions;
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
      session.sourceSessionId,
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

  if (session.usage !== undefined) {
    runSql(
      db,
      `INSERT INTO usage (
        session_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        session.id,
        session.usage.inputTokens,
        session.usage.outputTokens,
        session.usage.cacheReadTokens,
        session.usage.cacheCreationTokens,
        session.usage.costUsd
      ]
    );
  }

  if (session.summary !== undefined) {
    runSql(db, "INSERT INTO summaries (session_id, summary_md, model_used, generated_at) VALUES (?, ?, ?, ?)", [
      session.id,
      session.summary.summaryMd,
      session.summary.modelUsed ?? "summary-model",
      session.summary.generatedAt ?? session.startedAt
    ]);
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
      [session.id, link.taskId, link.chunkId, link.stage, link.linkedAt ?? session.startedAt, link.linkedBy ?? "manual"]
    );
  }

  for (const prompt of session.prompts ?? []) {
    runSql(db, "INSERT INTO prompts (id, session_id, ts, content, content_hash) VALUES (?, ?, ?, ?, ?)", [
      prompt.id,
      session.id,
      prompt.ts,
      prompt.content,
      prompt.contentHash
    ]);
  }

  for (const toolCall of session.toolCalls ?? []) {
    runSql(
      db,
      `INSERT INTO tool_calls (
        id,
        session_id,
        ts,
        tool_name,
        params_json,
        result_json,
        is_error,
        params_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        toolCall.id,
        session.id,
        toolCall.ts,
        toolCall.toolName,
        toolCall.paramsJson,
        toolCall.resultJson ?? null,
        toolCall.isError === true ? 1 : 0,
        toolCall.paramsHash
      ]
    );
  }
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function isoOffset(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function isoOffsetFrom(baseIso: string, offsetMs: number): string {
  return isoOffset(new Date(baseIso).getTime(), offsetMs);
}

function sessionIdsFromList(stdout: string): string[] {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("  ", 1)[0]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("foreman session query CLI", () => {
  test("lists empty databases cleanly in text and JSON", () => {
    const homeDir = createTempHome();

    const text = runForeman(homeDir, ["session", "list"]);
    const json = runForeman(homeDir, ["session", "list", "--json"]);

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toBe("No sessions found.\n");
    expect(text.stderr).toBe("");
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      schema_version: 1,
      sessions: []
    });
  });

  test("lists seeded sessions with stable text output", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);
    const result = runForeman(homeDir, ["session", "list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `${sessions.recentCodex.id}  codex  ${sessions.recentCodex.startedAt}  /repo/alpha  cost_usd=0.1200  chunks=FOREMAN-1/sqlite-schema  summary=Recent alpha work.`,
        `${sessions.hourlyClaude.id}  claude-code  ${sessions.hourlyClaude.startedAt}  /repo/alpha  cost_usd=null  chunks=none  summary=Hourly alpha follow-up.`,
        `${sessions.dailyCodex.id}  codex  ${sessions.dailyCodex.startedAt}  /repo/beta  cost_usd=null  chunks=FOREMAN-2/session-query  summary=null`,
        `${sessions.tenDayClaude.id}  claude-code  ${sessions.tenDayClaude.startedAt}  /repo/gamma  cost_usd=0.0100  chunks=none  summary=null`
      ].join("\n") + "\n"
    );
  });

  test("filters sessions by project, source, and unattached state", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);

    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--project", "/repo/alpha"]).stdout)).toEqual([
      sessions.recentCodex.id,
      sessions.hourlyClaude.id
    ]);
    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--source", "codex"]).stdout)).toEqual([
      sessions.recentCodex.id,
      sessions.dailyCodex.id
    ]);
    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--unattached"]).stdout)).toEqual([
      sessions.hourlyClaude.id,
      sessions.tenDayClaude.id
    ]);

    const invalidSource = runForeman(homeDir, ["session", "list", "--source", "other"]);
    expect(invalidSource.exitCode).toBe(2);
    expect(invalidSource.stderr).toContain("invalid source 'other'");
  });

  test("normalizes relative project filters to the current Git root", () => {
    const homeDir = createTempHome();
    const repoProjectPath = resolve(repoRoot);
    const session: SeedSessionInput = {
      id: "018f2d00-dddd-7000-b000-000000000005",
      source: "codex",
      sourceSessionId: "codex-current-repo",
      startedAt: new Date().toISOString(),
      projectPath: repoProjectPath,
      model: "gpt-5.3-codex"
    };

    seedSessions(homeDir, [session]);

    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--project", "."]).stdout)).toEqual([
      session.id
    ]);
  });

  test("filters sessions by compact since durations and rejects invalid values", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);

    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--since", "30m"]).stdout)).toEqual([
      sessions.recentCodex.id
    ]);
    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--since", "3h"]).stdout)).toEqual([
      sessions.recentCodex.id,
      sessions.hourlyClaude.id
    ]);
    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--since", "3d"]).stdout)).toEqual([
      sessions.recentCodex.id,
      sessions.hourlyClaude.id,
      sessions.dailyCodex.id
    ]);
    expect(sessionIdsFromList(runForeman(homeDir, ["session", "list", "--since", "2w"]).stdout)).toEqual([
      sessions.recentCodex.id,
      sessions.hourlyClaude.id,
      sessions.dailyCodex.id,
      sessions.tenDayClaude.id
    ]);

    const invalid = runForeman(homeDir, ["session", "list", "--since", "24hours"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("invalid --since value");

    const tooLarge = runForeman(homeDir, ["session", "list", "--since", "9007199254740991w"]);
    expect(tooLarge.exitCode).toBe(2);
    expect(tooLarge.stdout).toBe("");
    expect(tooLarge.stderr).toContain("duration is too large");
  });

  test("shows sessions by full ID and unique prefix with default detail", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);
    const fullId = runForeman(homeDir, ["session", "show", sessions.recentCodex.id]);
    const prefix = runForeman(homeDir, ["session", "show", "018f2b00"]);

    expect(fullId.exitCode).toBe(0);
    expect(fullId.stdout).toContain(`Session ${sessions.recentCodex.id}\n`);
    expect(fullId.stdout).toContain("Source: codex\n");
    expect(fullId.stdout).toContain("Usage: input=100 output=50 cache_read=10 cache_creation=5 cost_usd=0.1200\n");
    expect(fullId.stdout).toContain("Summary:\n  Model: summary-model\n");
    expect(fullId.stdout).toContain("Linked chunks:\n  FOREMAN-1/sqlite-schema  implement  hook  ");
    expect(fullId.stdout).not.toContain("Prompts:\n");
    expect(fullId.stdout).not.toContain("Tool calls:\n");

    expect(prefix.exitCode).toBe(0);
    expect(prefix.stdout).toContain(`Session ${sessions.dailyCodex.id}\n`);
    expect(prefix.stdout).toContain("Repo remote: null\n");
    expect(prefix.stdout).toContain("Model: null\n");
    expect(prefix.stdout).toContain("Usage: null\n");
    expect(prefix.stdout).toContain("Summary:\n  null\n");
  });

  test("reports ambiguous and missing session prefixes", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);
    const ambiguous = runForeman(homeDir, ["session", "show", "018f2a00"]);
    const missing = runForeman(homeDir, ["session", "show", "missing"]);

    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stdout).toBe("");
    expect(ambiguous.stderr).toContain("session prefix '018f2a00' is ambiguous");
    expect(ambiguous.stderr).toContain(sessions.hourlyClaude.id);
    expect(ambiguous.stderr).toContain(sessions.recentCodex.id);

    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("session 'missing' was not found");
  });

  test("session last sorts by started_at with deterministic ID tie-breaker", () => {
    const homeDir = createTempHome();
    const startedAt = new Date(Date.now() - 60 * 1000).toISOString();

    seedSessions(homeDir, [
      {
        id: "tie-session-001",
        source: "codex",
        sourceSessionId: "tie-1",
        startedAt,
        projectPath: "/repo/tie"
      },
      {
        id: "tie-session-009",
        source: "codex",
        sourceSessionId: "tie-9",
        startedAt,
        projectPath: "/repo/tie"
      }
    ]);

    const result = runForeman(homeDir, ["session", "last"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Session tie-session-009\n");
  });

  test("full output includes prompts and tool calls", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);
    const result = runForeman(homeDir, ["session", "show", sessions.recentCodex.id, "--full"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Prompts:\n");
    expect(result.stdout).toContain("  prompt-recent-1  ");
    expect(result.stdout).toContain("    Implement the session query CLI.\n");
    expect(result.stdout).toContain("Tool calls:\n");
    expect(result.stdout).toContain("  tool-recent-1  ");
    expect(result.stdout).toContain("exec_command  error=false  params-hash-recent\n");
    expect(result.stdout).toContain("    params: {\"cmd\":\"bun test tests/db\"}\n");
    expect(result.stdout).toContain("    result: {\"exitCode\":0}\n");
  });

  test("emits JSON output for list, show, and last", () => {
    const homeDir = createTempHome();
    const sessions = seedStandardSessions(homeDir);
    const list = JSON.parse(runForeman(homeDir, ["session", "list", "--json"]).stdout);
    const show = JSON.parse(runForeman(homeDir, ["session", "show", sessions.recentCodex.id, "--full", "--json"]).stdout);
    const last = JSON.parse(runForeman(homeDir, ["session", "last", "--json"]).stdout);

    expect(list.schema_version).toBe(1);
    expect(list.sessions).toHaveLength(4);
    expect(list.sessions[0]).toMatchObject({
      id: sessions.recentCodex.id,
      source: "codex",
      source_session_id: "codex-alpha-recent",
      project_path: "/repo/alpha",
      repo_remote: "git@example.com:alpha/repo.git",
      model: "gpt-5.3-codex",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        cost_usd: 0.12
      },
      summary: {
        summary_md: "Recent alpha work.",
        model_used: "summary-model"
      },
      linked_chunks: [
        {
          task_id: "FOREMAN-1",
          chunk_id: "sqlite-schema",
          stage: "implement",
          linked_by: "hook"
        }
      ]
    });
    expect(list.sessions[2].repo_remote).toBeNull();
    expect(list.sessions[2].model).toBeNull();
    expect(list.sessions[2].usage).toBeNull();
    expect(list.sessions[2].summary).toBeNull();

    expect(show.schema_version).toBe(1);
    expect(show.session.id).toBe(sessions.recentCodex.id);
    expect(show.session.prompts).toEqual([
      {
        id: "prompt-recent-1",
        ts: sessions.recentCodex.prompts![0].ts,
        content: "Implement the session query CLI.",
        content_hash: "prompt-hash-recent"
      }
    ]);
    expect(show.session.tool_calls).toEqual([
      {
        id: "tool-recent-1",
        ts: sessions.recentCodex.toolCalls![0].ts,
        tool_name: "exec_command",
        params_json: "{\"cmd\":\"bun test tests/db\"}",
        result_json: "{\"exitCode\":0}",
        is_error: false,
        params_hash: "params-hash-recent"
      }
    ]);

    expect(last.schema_version).toBe(1);
    expect(last.session.id).toBe(sessions.recentCodex.id);
    expect(last.session).not.toHaveProperty("prompts");
    expect(last.session).not.toHaveProperty("tool_calls");
  });
});
