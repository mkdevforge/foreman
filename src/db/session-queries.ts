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

export interface LinkedSessionDetail {
  session: SessionDetail;
  link: SessionChunkLink;
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

interface LinkedSessionRow extends SessionRecord {
  link_task_id: string;
  link_chunk_id: string;
  link_stage: string;
  link_linked_at: string;
  link_linked_by: string;
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

export function listLinkedSessionsForChunk(
  db: Database,
  taskId: string,
  chunkId: string,
  full = false
): LinkedSessionDetail[] {
  return listLinkedSessions(db, "session_chunks.task_id = ? AND session_chunks.chunk_id = ?", [taskId, chunkId], full);
}

export function listLinkedSessionsForTask(db: Database, taskId: string, full = false): LinkedSessionDetail[] {
  return listLinkedSessions(db, "session_chunks.task_id = ?", [taskId], full);
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

function listLinkedSessions(
  db: Database,
  linkWhereClause: string,
  params: SQLQueryBindings[],
  full: boolean
): LinkedSessionDetail[] {
  const rows = db
    .prepare<LinkedSessionRow, SQLQueryBindings[]>(
      `SELECT
        sessions.id,
        sessions.source,
        sessions.source_session_id,
        sessions.started_at,
        sessions.ended_at,
        sessions.project_path,
        sessions.repo_remote,
        sessions.model,
        sessions.machine,
        sessions.user_email,
        sessions.created_at,
        session_chunks.task_id AS link_task_id,
        session_chunks.chunk_id AS link_chunk_id,
        session_chunks.stage AS link_stage,
        session_chunks.linked_at AS link_linked_at,
        session_chunks.linked_by AS link_linked_by
      FROM session_chunks
      JOIN sessions ON sessions.id = session_chunks.session_id
      WHERE ${linkWhereClause}
      ORDER BY session_chunks.stage ASC, sessions.started_at DESC, sessions.id DESC`
    )
    .all(...params);

  return rows.map((row) => ({
    session: hydrateSessionDetail(db, row, full),
    link: {
      task_id: row.link_task_id,
      chunk_id: row.link_chunk_id,
      stage: row.link_stage,
      linked_at: row.link_linked_at,
      linked_by: row.link_linked_by
    }
  }));
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
