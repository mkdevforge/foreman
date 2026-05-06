import type { Database, SQLQueryBindings } from "bun:sqlite";

interface SqlRunResult {
  changes: number;
}

export function updateSessionCost(db: Database, sessionId: string, costUsd: number): number {
  return runSql(db, "UPDATE usage SET cost_usd = ? WHERE session_id = ?", [costUsd, sessionId]);
}

export function upsertSessionSummary(
  db: Database,
  input: { sessionId: string; summaryMd: string; modelUsed: string; generatedAt: string }
): number {
  return runSql(
    db,
    `INSERT INTO summaries (
      session_id,
      summary_md,
      model_used,
      generated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      summary_md = excluded.summary_md,
      model_used = excluded.model_used,
      generated_at = excluded.generated_at`,
    [input.sessionId, input.summaryMd, input.modelUsed, input.generatedAt]
  );
}

export function linkSessionChunk(
  db: Database,
  input: {
    sessionId: string;
    taskId: string;
    chunkId: string;
    stage: string;
    linkedAt: string;
    linkedBy: "hook" | "catalog" | "manual";
  }
): number {
  return runSql(
    db,
    `INSERT INTO session_chunks (
      session_id,
      task_id,
      chunk_id,
      stage,
      linked_at,
      linked_by
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`,
    [input.sessionId, input.taskId, input.chunkId, input.stage, input.linkedAt, input.linkedBy]
  );
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const result = db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params) as SqlRunResult;
  return result.changes;
}
