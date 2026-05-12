import type { Database } from "bun:sqlite";
import { v7 as uuidv7 } from "uuid";
import { getDispatchRunDetailById, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent, updateDispatchAttemptStatus, updateDispatchRunStatus } from "../db/dispatch-writes";

type IdGenerator = () => string;
type NowGenerator = () => string;

export const DISPATCH_FINISH_STATUSES = ["succeeded", "failed"] as const;
export type DispatchFinishStatus = (typeof DISPATCH_FINISH_STATUSES)[number];

export type FinishDispatchRunResult =
  | { kind: "finished"; detail: DispatchRunDetail }
  | { kind: "already_finished"; detail: DispatchRunDetail }
  | { kind: "missing" }
  | { kind: "not_finishable"; detail: DispatchRunDetail; reason: string };

export interface FinishDispatchRunOptions {
  status: DispatchFinishStatus;
  message?: string | null;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

class FinishStatusLostError extends Error {
  constructor() {
    super("dispatch finish status was lost during update");
  }
}

export function finishDispatchRun(
  db: Database,
  runId: string,
  options: FinishDispatchRunOptions
): FinishDispatchRunResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;

  const finish = db.transaction(() => {
    const existing = getDispatchRunDetailById(db, runId);
    if (existing === null) {
      return { kind: "missing" } satisfies FinishDispatchRunResult;
    }

    const finishable = validateFinishable(existing, options.status);
    if (finishable !== null) {
      return finishable;
    }

    const attempt = existing.attempts[0];
    const timestamp = now();
    const message = normalizeMessage(options.message);
    const attemptUpdated = updateDispatchAttemptStatus(db, {
      id: attempt.id,
      status: options.status,
      endedAt: timestamp,
      errorMessage: options.status === "failed" ? message : null,
      expectedStatus: "launching_agent"
    });

    if (attemptUpdated !== 1) {
      throw new FinishStatusLostError();
    }

    const runUpdated = updateDispatchRunStatus(db, {
      id: runId,
      status: options.status,
      updatedAt: timestamp,
      finishedAt: timestamp,
      expectedStatus: "running"
    });

    if (runUpdated !== 1) {
      throw new FinishStatusLostError();
    }

    insertDispatchEvent(db, {
      id: `evt_${idGenerator()}`,
      runId,
      attemptId: attempt.id,
      ts: timestamp,
      type: options.status,
      message: `Dispatch attempt ${options.status}.`,
      dataJson: JSON.stringify({
        previous_run_status: existing.run.status,
        previous_attempt_status: attempt.status,
        status: options.status,
        session_id: attempt.session_id,
        message
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`finished dispatch run '${runId}' could not be read back`);
    }

    return { kind: "finished", detail } satisfies FinishDispatchRunResult;
  });

  try {
    return finish.immediate();
  } catch (error) {
    if (!(error instanceof FinishStatusLostError)) {
      throw error;
    }

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      return { kind: "missing" } satisfies FinishDispatchRunResult;
    }

    return validateFinishable(detail, options.status) ?? {
      kind: "not_finishable",
      detail,
      reason: "status_changed"
    };
  }
}

function validateFinishable(
  detail: DispatchRunDetail,
  requestedStatus: DispatchFinishStatus
): Exclude<FinishDispatchRunResult, { kind: "finished" | "missing" }> | null {
  if (isFinishedStatus(detail.run.status)) {
    if (detail.run.status !== requestedStatus) {
      return { kind: "not_finishable", detail, reason: "already_finished_with_different_status" };
    }

    const attempt = detail.attempts.length === 1 ? detail.attempts[0] : null;
    return attempt?.status === requestedStatus
      ? { kind: "already_finished", detail }
      : { kind: "not_finishable", detail, reason: "terminal_state_mismatch" };
  }

  if (detail.run.status !== "running") {
    return { kind: "not_finishable", detail, reason: "status_not_running" };
  }

  if (detail.attempts.length === 0) {
    return { kind: "not_finishable", detail, reason: "missing_attempt" };
  }

  if (detail.attempts.length > 1) {
    return { kind: "not_finishable", detail, reason: "multiple_attempts" };
  }

  const attempt = detail.attempts[0];
  if (attempt.session_id === null) {
    return { kind: "not_finishable", detail, reason: "missing_session" };
  }

  if (attempt.status !== "launching_agent") {
    return { kind: "not_finishable", detail, reason: "attempt_status_not_launching_agent" };
  }

  return null;
}

function isFinishedStatus(status: string): status is DispatchFinishStatus {
  return DISPATCH_FINISH_STATUSES.includes(status as DispatchFinishStatus);
}

function normalizeMessage(message: string | null | undefined): string | null {
  if (message === undefined || message === null) {
    return null;
  }

  const trimmed = message.trim();
  return trimmed === "" ? null : trimmed;
}

function defaultNow(): string {
  return new Date().toISOString();
}
