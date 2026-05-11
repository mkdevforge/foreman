import type { Database, SQLQueryBindings } from "bun:sqlite";
import { getSessionById, type SessionOverview } from "./session-queries";

export interface DispatchRunRecord {
  id: string;
  repo_name: string | null;
  task_id: string;
  chunk_id: string;
  requested_stage: string;
  status: string;
  requested_by: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface DispatchAttemptRecord {
  id: string;
  run_id: string;
  attempt_number: number;
  status: string;
  tool: string;
  workspace_path: string | null;
  worktree_branch: string | null;
  process_id: number | null;
  started_at: string | null;
  ended_at: string | null;
  error_message: string | null;
  session_id: string | null;
}

export interface DispatchAttemptDetail extends DispatchAttemptRecord {
  session: SessionOverview | null;
}

export interface DispatchEventRecord {
  id: string;
  run_id: string;
  attempt_id: string | null;
  ts: string;
  type: string;
  message: string;
  data_json: string;
}

export interface DispatchRunDetail {
  run: DispatchRunRecord;
  attempts: DispatchAttemptDetail[];
  events: DispatchEventRecord[];
}

export interface DispatchRunFilters {
  taskId?: string;
  chunkId?: string;
  status?: string;
}

export type DispatchRunPrefixResolution =
  | { kind: "matched"; id: string }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: string[] };

export function getDispatchRunById(db: Database, id: string): DispatchRunRecord | null {
  return db
    .query<DispatchRunRecord, [string]>(
      `SELECT
        id,
        repo_name,
        task_id,
        chunk_id,
        requested_stage,
        status,
        requested_by,
        source,
        created_at,
        updated_at,
        finished_at
      FROM dispatch_runs
      WHERE id = ?`
    )
    .get(id);
}

export function getDispatchRunDetailById(db: Database, id: string): DispatchRunDetail | null {
  const run = getDispatchRunById(db, id);

  return run === null ? null : hydrateDispatchRunDetail(db, run);
}

export function listDispatchRuns(db: Database, filters: DispatchRunFilters = {}): DispatchRunRecord[] {
  const clauses: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filters.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(filters.taskId);
  }

  if (filters.chunkId !== undefined) {
    clauses.push("chunk_id = ?");
    params.push(filters.chunkId);
  }

  if (filters.status !== undefined) {
    clauses.push("status = ?");
    params.push(filters.status);
  }

  const whereClause = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
  return db
    .prepare<DispatchRunRecord, SQLQueryBindings[]>(
      `SELECT
        id,
        repo_name,
        task_id,
        chunk_id,
        requested_stage,
        status,
        requested_by,
        source,
        created_at,
        updated_at,
        finished_at
      FROM dispatch_runs${whereClause}
      ORDER BY created_at DESC, id DESC`
    )
    .all(...params);
}

export function listDispatchRunDetails(db: Database, filters: DispatchRunFilters = {}): DispatchRunDetail[] {
  return listDispatchRuns(db, filters).map((run) => hydrateDispatchRunDetail(db, run));
}

export function resolveDispatchRunPrefix(db: Database, prefix: string): DispatchRunPrefixResolution {
  const exact = db.query<{ id: string }, [string]>("SELECT id FROM dispatch_runs WHERE id = ?").get(prefix);

  if (exact !== null) {
    return { kind: "matched", id: exact.id };
  }

  const candidates = db
    .query<{ id: string }, [number, string]>(
      "SELECT id FROM dispatch_runs WHERE substr(id, 1, ?) = ? ORDER BY id ASC"
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

export function listDispatchAttemptsForRun(db: Database, runId: string): DispatchAttemptRecord[] {
  return db
    .query<DispatchAttemptRecord, [string]>(
      `SELECT
        id,
        run_id,
        attempt_number,
        status,
        tool,
        workspace_path,
        worktree_branch,
        process_id,
        started_at,
        ended_at,
        error_message,
        session_id
      FROM dispatch_attempts
      WHERE run_id = ?
      ORDER BY attempt_number ASC, id ASC`
    )
    .all(runId);
}

export function listDispatchEventsForRun(db: Database, runId: string): DispatchEventRecord[] {
  return db
    .query<DispatchEventRecord, [string]>(
      `SELECT
        id,
        run_id,
        attempt_id,
        ts,
        type,
        message,
        data_json
      FROM dispatch_events
      WHERE run_id = ?
      ORDER BY ts ASC, id ASC`
    )
    .all(runId);
}

function hydrateDispatchRunDetail(db: Database, run: DispatchRunRecord): DispatchRunDetail {
  return {
    run,
    attempts: listDispatchAttemptsForRun(db, run.id).map((attempt) => ({
      ...attempt,
      session: attempt.session_id === null ? null : getSessionById(db, attempt.session_id, false)
    })),
    events: listDispatchEventsForRun(db, run.id)
  };
}
