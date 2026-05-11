import type { Database, SQLQueryBindings } from "bun:sqlite";

interface SqlRunResult {
  changes: number;
}

export interface InsertDispatchRunInput {
  id: string;
  repoName?: string | null;
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.repoName ?? null,
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
  input: {
    id: string;
    status: string;
    updatedAt: string;
    repoName?: string | null;
    finishedAt?: string | null;
    expectedStatus?: string;
  }
): number {
  const assignments = ["status = ?", "updated_at = ?"];
  const params: SQLQueryBindings[] = [input.status, input.updatedAt];
  const whereClauses = ["id = ?"];

  if ("repoName" in input) {
    assignments.push("repo_name = ?");
    params.push(input.repoName ?? null);
  }

  if ("finishedAt" in input) {
    assignments.push("finished_at = ?");
    params.push(input.finishedAt ?? null);
  }

  params.push(input.id);

  if (input.expectedStatus !== undefined) {
    whereClauses.push("status = ?");
    params.push(input.expectedStatus);
  }

  return runSql(db, `UPDATE dispatch_runs SET ${assignments.join(", ")} WHERE ${whereClauses.join(" AND ")}`, params);
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
  const assignments = ["status = ?"];
  const params: SQLQueryBindings[] = [input.status];

  if ("endedAt" in input) {
    assignments.push("ended_at = ?");
    params.push(input.endedAt ?? null);
  }

  if ("errorMessage" in input) {
    assignments.push("error_message = ?");
    params.push(input.errorMessage ?? null);
  }

  if ("sessionId" in input) {
    assignments.push("session_id = ?");
    params.push(input.sessionId ?? null);
  }

  params.push(input.id);
  return runSql(db, `UPDATE dispatch_attempts SET ${assignments.join(", ")} WHERE id = ?`, params);
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
