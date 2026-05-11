import type { Database, SQLQueryBindings } from "bun:sqlite";

export interface DispatchRunRecord {
  id: string;
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

export interface DispatchEventRecord {
  id: string;
  run_id: string;
  attempt_id: string | null;
  ts: string;
  type: string;
  message: string;
  data_json: string;
}

export interface DispatchRunFilters {
  taskId?: string;
  chunkId?: string;
  status?: string;
}

export function getDispatchRunById(db: Database, id: string): DispatchRunRecord | null {
  return db
    .query<DispatchRunRecord, [string]>(
      `SELECT
        id,
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
