import type { Database, SQLQueryBindings } from "bun:sqlite";

export const SESSION_SOURCES = ["claude-code", "codex"] as const;

export type SessionSource = (typeof SESSION_SOURCES)[number];

export interface SessionRecord {
  id: string;
  source: SessionSource;
  source_session_id: string;
  started_at: string;
  ended_at: string;
  project_path: string;
  repo_remote: string | null;
  model: string | null;
  machine: string;
  user_email: string;
  created_at: string;
}

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
}

export interface SessionSummary {
  summary_md: string;
  model_used: string;
  generated_at: string;
}

export interface SessionChunkLink {
  task_id: string;
  chunk_id: string;
  stage: string;
  linked_at: string;
  linked_by: string;
}

export interface SessionPrompt {
  id: string;
  ts: string;
  content: string;
  content_hash: string;
}

export interface SessionToolCall {
  id: string;
  ts: string;
  tool_name: string;
  params_json: string;
  result_json: string | null;
  is_error: boolean;
  params_hash: string;
}

export interface SessionOverview extends SessionRecord {
  usage: SessionUsage | null;
  summary: SessionSummary | null;
  linked_chunks: SessionChunkLink[];
}

export interface SessionDetail extends SessionOverview {
  prompts?: SessionPrompt[];
  tool_calls?: SessionToolCall[];
}

export interface ListSessionsFilters {
  startedAtSince?: string;
  projectPath?: string;
  source?: SessionSource;
  unattached?: boolean;
}

export type SessionPrefixResolution =
  | { kind: "matched"; id: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: string[] };

interface ToolCallRow {
  id: string;
  ts: string;
  tool_name: string;
  params_json: string;
  result_json: string | null;
  is_error: number;
  params_hash: string;
}

export function listSessions(db: Database, filters: ListSessionsFilters = {}): SessionOverview[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filters.startedAtSince !== undefined) {
    clauses.push("started_at >= ?");
    params.push(filters.startedAtSince);
  }

  if (filters.projectPath !== undefined) {
    clauses.push("project_path = ?");
    params.push(filters.projectPath);
  }

  if (filters.source !== undefined) {
    clauses.push("source = ?");
    params.push(filters.source);
  }

  if (filters.unattached === true) {
    clauses.push("NOT EXISTS (SELECT 1 FROM session_chunks WHERE session_chunks.session_id = sessions.id)");
  }

  const whereClause = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  const rows = db
    .prepare<SessionRecord, SQLQueryBindings[]>(
      `SELECT
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
      FROM sessions${whereClause}
      ORDER BY started_at DESC, id DESC`
    )
    .all(...params);

  return rows.map((row) => hydrateSessionOverview(db, row));
}

export function getLastSession(db: Database, full = false): SessionDetail | null {
  const row = db
    .query<SessionRecord, []>(
      `SELECT
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
      FROM sessions
      ORDER BY started_at DESC, id DESC
      LIMIT 1`
    )
    .get();

  return row === null ? null : hydrateSessionDetail(db, row, full);
}

export function getSessionById(db: Database, id: string, full = false): SessionDetail | null {
  const row = db
    .query<SessionRecord, [string]>(
      `SELECT
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
      FROM sessions
      WHERE id = ?`
    )
    .get(id);

  return row === null ? null : hydrateSessionDetail(db, row, full);
}

export function resolveSessionPrefix(db: Database, prefix: string): SessionPrefixResolution {
  const exact = db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id = ?").get(prefix);

  if (exact !== null) {
    return { kind: "matched", id: exact.id };
  }

  const candidates = db
    .query<{ id: string }, [number, string]>(
      "SELECT id FROM sessions WHERE substr(id, 1, ?) = ? ORDER BY id ASC"
    )
    .all(prefix.length, prefix)
    .map((row) => row.id);

  if (candidates.length === 0) {
    return { kind: "missing" };
  }

  if (candidates.length === 1) {
    return { kind: "matched", id: candidates[0] };
  }

  return { kind: "ambiguous", candidates };
}

export function getSessionUsage(db: Database, sessionId: string): SessionUsage | null {
  return db
    .query<SessionUsage, [string]>(
      `SELECT
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        cost_usd
      FROM usage
      WHERE session_id = ?`
    )
    .get(sessionId);
}

export function getSessionSummary(db: Database, sessionId: string): SessionSummary | null {
  return db
    .query<SessionSummary, [string]>(
      `SELECT
        summary_md,
        model_used,
        generated_at
      FROM summaries
      WHERE session_id = ?`
    )
    .get(sessionId);
}

export function listSessionChunks(db: Database, sessionId: string): SessionChunkLink[] {
  return db
    .query<SessionChunkLink, [string]>(
      `SELECT
        task_id,
        chunk_id,
        stage,
        linked_at,
        linked_by
      FROM session_chunks
      WHERE session_id = ?
      ORDER BY task_id ASC, chunk_id ASC`
    )
    .all(sessionId);
}

export function listSessionPrompts(db: Database, sessionId: string): SessionPrompt[] {
  return db
    .query<SessionPrompt, [string]>(
      `SELECT
        id,
        ts,
        content,
        content_hash
      FROM prompts
      WHERE session_id = ?
      ORDER BY ts ASC, id ASC`
    )
    .all(sessionId);
}

export function listSessionToolCalls(db: Database, sessionId: string): SessionToolCall[] {
  return db
    .query<ToolCallRow, [string]>(
      `SELECT
        id,
        ts,
        tool_name,
        params_json,
        result_json,
        is_error,
        params_hash
      FROM tool_calls
      WHERE session_id = ?
      ORDER BY ts ASC, id ASC`
    )
    .all(sessionId)
    .map((row) => ({
      ...row,
      is_error: row.is_error !== 0
    }));
}

function hydrateSessionOverview(db: Database, row: SessionRecord): SessionOverview {
  return {
    ...row,
    usage: getSessionUsage(db, row.id),
    summary: getSessionSummary(db, row.id),
    linked_chunks: listSessionChunks(db, row.id)
  };
}

function hydrateSessionDetail(db: Database, row: SessionRecord, full: boolean): SessionDetail {
  const overview = hydrateSessionOverview(db, row);

  if (!full) {
    return overview;
  }

  return {
    ...overview,
    prompts: listSessionPrompts(db, row.id),
    tool_calls: listSessionToolCalls(db, row.id)
  };
}
