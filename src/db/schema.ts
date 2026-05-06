import type { Database } from "bun:sqlite";

export const FOREMAN_DB_SCHEMA_VERSION = 1;

const MIGRATION_1_STATEMENTS = [
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
  "CREATE INDEX idx_session_chunks_task ON session_chunks(task_id, chunk_id)",
  `PRAGMA user_version = ${FOREMAN_DB_SCHEMA_VERSION}`
] as const;

export function applyConnectionPragmas(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = DELETE");
}

export function migrateDatabaseSchema(db: Database): void {
  const currentVersion = getUserVersion(db);

  if (currentVersion > FOREMAN_DB_SCHEMA_VERSION) {
    throw new Error(
      `unsupported Foreman database schema version ${currentVersion}; expected ${FOREMAN_DB_SCHEMA_VERSION} or older`
    );
  }

  if (currentVersion === 0) {
    applyMigration1(db);
  }

  const migratedVersion = getUserVersion(db);
  if (migratedVersion !== FOREMAN_DB_SCHEMA_VERSION) {
    throw new Error(
      `failed to migrate Foreman database schema to version ${FOREMAN_DB_SCHEMA_VERSION}; current version is ${migratedVersion}`
    );
  }
}

export function getUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();

  if (row === null || typeof row.user_version !== "number") {
    throw new Error("failed to read SQLite user_version");
  }

  return row.user_version;
}

function applyMigration1(db: Database): void {
  const migration = db.transaction(() => {
    for (const statement of MIGRATION_1_STATEMENTS) {
      db.run(statement);
    }
  });

  migration.immediate();
}
