import type { Database, SQLQueryBindings } from "bun:sqlite";

interface SqlRunResult {
  changes: number;
}

export interface InsertDispatchRunInput {
  id: string;
  taskId: string;
  chunkId: string;
  requestedStage: string;
  status: string;
  requestedBy?: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
}

export interface InsertDispatchAttemptInput {
  id: string;
  runId: string;
  attemptNumber: number;
  status: string;
  tool: string;
  workspacePath?: string | null;
  worktreeBranch?: string | null;
  processId?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  errorMessage?: string | null;
  sessionId?: string | null;
}

export interface InsertDispatchEventInput {
  id: string;
  runId: string;
  attemptId?: string | null;
  ts: string;
  type: string;
  message: string;
  dataJson: string;
}

export function insertDispatchRun(db: Database, input: InsertDispatchRunInput): number {
  return runSql(
    db,
    `INSERT INTO dispatch_runs (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.taskId,
      input.chunkId,
      input.requestedStage,
      input.status,
      input.requestedBy ?? null,
      input.source,
      input.createdAt,
      input.updatedAt,
      input.finishedAt ?? null
    ]
  );
}

export function updateDispatchRunStatus(
  db: Database,
  input: { id: string; status: string; updatedAt: string; finishedAt?: string | null }
): number {
  return runSql(
    db,
    "UPDATE dispatch_runs SET status = ?, updated_at = ?, finished_at = ? WHERE id = ?",
    [input.status, input.updatedAt, input.finishedAt ?? null, input.id]
  );
}

export function insertDispatchAttempt(db: Database, input: InsertDispatchAttemptInput): number {
  return runSql(
    db,
    `INSERT INTO dispatch_attempts (
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.runId,
      input.attemptNumber,
      input.status,
      input.tool,
      input.workspacePath ?? null,
      input.worktreeBranch ?? null,
      input.processId ?? null,
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.errorMessage ?? null,
      input.sessionId ?? null
    ]
  );
}

export function updateDispatchAttemptStatus(
  db: Database,
  input: {
    id: string;
    status: string;
    endedAt?: string | null;
    errorMessage?: string | null;
    sessionId?: string | null;
  }
): number {
  return runSql(
    db,
    "UPDATE dispatch_attempts SET status = ?, ended_at = ?, error_message = ?, session_id = ? WHERE id = ?",
    [input.status, input.endedAt ?? null, input.errorMessage ?? null, input.sessionId ?? null, input.id]
  );
}

export function insertDispatchEvent(db: Database, input: InsertDispatchEventInput): number {
  return runSql(
    db,
    `INSERT INTO dispatch_events (
      id,
      run_id,
      attempt_id,
      ts,
      type,
      message,
      data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.id, input.runId, input.attemptId ?? null, input.ts, input.type, input.message, input.dataJson]
  );
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const result = db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params) as SqlRunResult;
  return result.changes;
}
