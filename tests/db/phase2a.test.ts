import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaultForemanDatabasePath, openForemanDatabase } from "../../src/db/client";
import { FOREMAN_DB_SCHEMA_VERSION, getUserVersion } from "../../src/db/schema";

const tempDirs: string[] = [];
const baseTs = "2026-05-06T00:00:00.000Z";

const expectedTables = [
  "dispatch_attempts",
  "dispatch_events",
  "dispatch_runs",
  "prompts",
  "session_chunks",
  "sessions",
  "summaries",
  "tool_calls",
  "usage"
];
const expectedIndexes = [
  "idx_dispatch_attempts_run",
  "idx_dispatch_attempts_session",
  "idx_dispatch_attempts_status",
  "idx_dispatch_events_attempt_ts",
  "idx_dispatch_events_run_ts",
  "idx_dispatch_events_type",
  "idx_dispatch_runs_chunk",
  "idx_dispatch_runs_created",
  "idx_dispatch_runs_status",
  "idx_prompts_session",
  "idx_session_chunks_task",
  "idx_sessions_project",
  "idx_sessions_source",
  "idx_sessions_started",
  "idx_tool_calls_session",
  "idx_tool_calls_tool"
];

interface FileStatSnapshot {
  mtimeMs: number;
  size: number;
}

interface SeedSessionInput {
  id?: string;
  source?: string;
  sourceSessionId?: string;
}

interface SeedPromptInput {
  id?: string;
  ts?: string;
  contentHash?: string;
}

interface SeedToolCallInput {
  id?: string;
  ts?: string;
  paramsHash?: string;
}

interface SeedSessionChunkInput {
  taskId?: string;
  chunkId?: string;
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "foreman-db-test-"));
  tempDirs.push(dir);
  return dir;
}

function openTempDatabase(name = "foreman.db"): Database {
  return openForemanDatabase({ databasePath: join(createTempDir(), name) });
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): void {
  db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
}

function seedSession(db: Database, input: SeedSessionInput = {}): string {
  const id = input.id ?? "session-1";
  const source = input.source ?? "codex";
  const sourceSessionId = input.sourceSessionId ?? `${source}-session-1`;

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
      id,
      source,
      sourceSessionId,
      baseTs,
      "2026-05-06T00:05:00.000Z",
      "/tmp/foreman-project",
      "git@example.com:mkdevforge/foreman.git",
      "gpt-5.3-codex",
      "dev-machine",
      "dev@example.com",
      baseTs
    ]
  );

  return id;
}

function seedPrompt(db: Database, sessionId: string, input: SeedPromptInput = {}): void {
  runSql(db, "INSERT INTO prompts (id, session_id, ts, content, content_hash) VALUES (?, ?, ?, ?, ?)", [
    input.id ?? "prompt-1",
    sessionId,
    input.ts ?? baseTs,
    "Implement the database schema.",
    input.contentHash ?? "prompt-hash-1"
  ]);
}

function seedToolCall(db: Database, sessionId: string, input: SeedToolCallInput = {}): void {
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
      input.id ?? "tool-call-1",
      sessionId,
      input.ts ?? baseTs,
      "exec_command",
      "{\"cmd\":\"bun test tests/db\"}",
      "{\"exitCode\":0}",
      0,
      input.paramsHash ?? "params-hash-1"
    ]
  );
}

function seedUsage(db: Database, sessionId: string): void {
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
    [sessionId, 100, 50, 10, 5, 0.12]
  );
}

function seedSummary(db: Database, sessionId: string): void {
  runSql(db, "INSERT INTO summaries (session_id, summary_md, model_used, generated_at) VALUES (?, ?, ?, ?)", [
    sessionId,
    "Implemented SQLite schema.",
    "summary-model",
    "2026-05-06T00:06:00.000Z"
  ]);
}

function seedSessionChunk(db: Database, sessionId: string, input: SeedSessionChunkInput = {}): void {
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
    [
      sessionId,
      input.taskId ?? "FOREMAN-1",
      input.chunkId ?? "sqlite-schema",
      "implement",
      "2026-05-06T00:07:00.000Z",
      "manual"
    ]
  );
}

function createLegacyVersion1Database(path: string): void {
  const db = new Database(path, {
    create: true,
    readwrite: true,
    strict: true
  });

  try {
    const statements = [
      `CREATE TABLE sessions (
        id                  TEXT PRIMARY KEY,
        source              TEXT NOT NULL,
        source_session_id   TEXT NOT NULL,
        started_at          TEXT NOT NULL,
        ended_at            TEXT NOT NULL,
        project_path        TEXT NOT NULL,
        repo_remote         TEXT,
        model               TEXT,
        machine             TEXT NOT NULL,
        user_email          TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        UNIQUE (source, source_session_id)
      )`,
      "CREATE INDEX idx_sessions_started ON sessions(started_at DESC)",
      "CREATE INDEX idx_sessions_project ON sessions(project_path)",
      "CREATE INDEX idx_sessions_source ON sessions(source)",
      `CREATE TABLE prompts (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ts            TEXT NOT NULL,
        content       TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        UNIQUE (session_id, content_hash, ts)
      )`,
      "CREATE INDEX idx_prompts_session ON prompts(session_id)",
      `CREATE TABLE tool_calls (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ts            TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        params_json   TEXT NOT NULL,
        result_json   TEXT,
        is_error      INTEGER NOT NULL DEFAULT 0,
        params_hash   TEXT NOT NULL,
        UNIQUE (session_id, params_hash, ts)
      )`,
      "CREATE INDEX idx_tool_calls_session ON tool_calls(session_id)",
      "CREATE INDEX idx_tool_calls_tool ON tool_calls(tool_name)",
      `CREATE TABLE usage (
        session_id              TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        input_tokens            INTEGER NOT NULL DEFAULT 0,
        output_tokens           INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd                REAL    NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE summaries (
        session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        summary_md    TEXT NOT NULL,
        model_used    TEXT NOT NULL,
        generated_at  TEXT NOT NULL
      )`,
      `CREATE TABLE session_chunks (
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        task_id       TEXT NOT NULL,
        chunk_id      TEXT NOT NULL,
        stage         TEXT NOT NULL,
        linked_at     TEXT NOT NULL,
        linked_by     TEXT NOT NULL,
        PRIMARY KEY (session_id, task_id, chunk_id)
      )`,
      "CREATE INDEX idx_session_chunks_task ON session_chunks(task_id, chunk_id)"
    ];

    for (const statement of statements) {
      runSql(db, statement);
    }

    seedSession(db, { id: "legacy-session" });
    runSql(db, "PRAGMA user_version = 1");
  } finally {
    db.close();
  }
}

function objectNames(db: Database, type: "table" | "index"): string[] {
  return db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all(type)
    .map((row) => row.name);
}

function pragmaNumber(db: Database, sql: string, field: string): number {
  const row = db.query<Record<string, number>, []>(sql).get();

  expect(row).not.toBeNull();
  return row![field];
}

function pragmaText(db: Database, sql: string, field: string): string {
  const row = db.query<Record<string, string>, []>(sql).get();

  expect(row).not.toBeNull();
  return row![field];
}

function tableCount(db: Database, table: string): number {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();

  expect(row).not.toBeNull();
  return row!.count;
}

function snapshotFile(path: string): FileStatSnapshot | null {
  if (!existsSync(path)) {
    return null;
  }

  const stat = statSync(path);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("foreman SQLite schema", () => {
  test("creates and migrates a fresh database to the current schema version", () => {
    const dbPath = join(createTempDir(), "fresh.db");
    const db = openForemanDatabase({ databasePath: dbPath });

    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(getUserVersion(db)).toBe(FOREMAN_DB_SCHEMA_VERSION);
      expect(pragmaNumber(db, "PRAGMA foreign_keys", "foreign_keys")).toBe(1);
      expect(pragmaText(db, "PRAGMA journal_mode", "journal_mode")).toBe("delete");
    } finally {
      db.close();
    }
  });

  test("creates the default database parent under an injected home", () => {
    const homeDir = createTempDir();
    const dbPath = getDefaultForemanDatabasePath(homeDir);

    expect(existsSync(dirname(dbPath))).toBe(false);
    const db = openForemanDatabase({ homeDir });

    try {
      expect(db.filename).toBe(dbPath);
      expect(existsSync(dirname(dbPath))).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
      expect(getUserVersion(db)).toBe(FOREMAN_DB_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test("creates all expected tables and documented indexes", () => {
    const db = openTempDatabase();

    try {
      expect(objectNames(db, "table")).toEqual(expectedTables);
      expect(objectNames(db, "index")).toEqual(expectedIndexes);
    } finally {
      db.close();
    }
  });

  test("migrates an existing version 1 database to version 2 without dropping sessions", () => {
    const dbPath = join(createTempDir(), "legacy-v1.db");
    createLegacyVersion1Database(dbPath);

    const db = openForemanDatabase({ databasePath: dbPath });

    try {
      expect(getUserVersion(db)).toBe(FOREMAN_DB_SCHEMA_VERSION);
      expect(tableCount(db, "sessions")).toBe(1);
      expect(objectNames(db, "table")).toContain("dispatch_runs");
      expect(objectNames(db, "table")).toContain("dispatch_attempts");
      expect(objectNames(db, "table")).toContain("dispatch_events");
    } finally {
      db.close();
    }
  });

  test("enforces foreign keys on every opened connection", () => {
    const dbPath = join(createTempDir(), "foreign-keys.db");
    const firstConnection = openForemanDatabase({ databasePath: dbPath });
    firstConnection.close();
    const secondConnection = openForemanDatabase({ databasePath: dbPath });

    try {
      expect(pragmaNumber(secondConnection, "PRAGMA foreign_keys", "foreign_keys")).toBe(1);
      expect(() => seedPrompt(secondConnection, "missing-session")).toThrow("FOREIGN KEY constraint failed");
    } finally {
      secondConnection.close();
    }
  });

  test("enforces required unique constraints", () => {
    const db = openTempDatabase();

    try {
      const sessionId = seedSession(db, {
        id: "session-1",
        source: "codex",
        sourceSessionId: "codex-session-1"
      });

      expect(() =>
        seedSession(db, {
          id: "session-2",
          source: "codex",
          sourceSessionId: "codex-session-1"
        })
      ).toThrow("UNIQUE constraint failed");

      seedPrompt(db, sessionId, { id: "prompt-1", contentHash: "prompt-hash-1" });
      expect(() => seedPrompt(db, sessionId, { id: "prompt-2", contentHash: "prompt-hash-1" })).toThrow(
        "UNIQUE constraint failed"
      );

      seedToolCall(db, sessionId, { id: "tool-call-1", paramsHash: "params-hash-1" });
      expect(() => seedToolCall(db, sessionId, { id: "tool-call-2", paramsHash: "params-hash-1" })).toThrow(
        "UNIQUE constraint failed"
      );

      seedSessionChunk(db, sessionId, { taskId: "FOREMAN-1", chunkId: "sqlite-schema" });
      expect(() => seedSessionChunk(db, sessionId, { taskId: "FOREMAN-1", chunkId: "sqlite-schema" })).toThrow(
        "UNIQUE constraint failed"
      );
    } finally {
      db.close();
    }
  });

  test("cascades session deletes to child tables", () => {
    const db = openTempDatabase();

    try {
      const sessionId = seedSession(db);
      seedPrompt(db, sessionId);
      seedToolCall(db, sessionId);
      seedUsage(db, sessionId);
      seedSummary(db, sessionId);
      seedSessionChunk(db, sessionId);

      for (const table of ["sessions", "prompts", "tool_calls", "usage", "summaries", "session_chunks"]) {
        expect(tableCount(db, table)).toBe(1);
      }

      runSql(db, "DELETE FROM sessions WHERE id = ?", [sessionId]);

      for (const table of ["sessions", "prompts", "tool_calls", "usage", "summaries", "session_chunks"]) {
        expect(tableCount(db, table)).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  test("injected test database paths do not touch the real user database", () => {
    const realDbPath = getDefaultForemanDatabasePath();
    const before = snapshotFile(realDbPath);
    const dbPath = join(createTempDir(), "isolated.db");
    const db = openForemanDatabase({ databasePath: dbPath });

    try {
      expect(db.filename).toBe(dbPath);
      expect(existsSync(dbPath)).toBe(true);
      expect(snapshotFile(realDbPath)).toEqual(before);
    } finally {
      db.close();
    }
  });
});
