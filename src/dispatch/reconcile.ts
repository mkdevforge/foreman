import type { Database } from "bun:sqlite";
import { v7 as uuidv7 } from "uuid";
import {
  getDispatchRunDetailById,
  listDispatchRunDetails,
  type DispatchAttemptDetail,
  type DispatchRunDetail
} from "../db/dispatch-queries";
import { insertDispatchEvent, updateDispatchAttemptStatus, updateDispatchRunStatus } from "../db/dispatch-writes";

type IdGenerator = () => string;
type NowGenerator = () => string;
type ProcessExists = (pid: number) => boolean;

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "canceled"] as const;

export interface DispatchReconciliation {
  run_id: string;
  attempt_id: string | null;
  previous_run_status: string;
  previous_attempt_status: string | null;
  status: string;
  attempt_status: string | null;
  reason: string;
  changed: boolean;
  process_id: number | null;
  stale_reference_at: string | null;
  stale_after_ms: number;
  checked_at: string;
  reconciled_at: string | null;
}

export type ReconcileDispatchRunResult =
  | { kind: "reconciled"; detail: DispatchRunDetail; reconciliation: DispatchReconciliation }
  | { kind: "already_terminal"; detail: DispatchRunDetail; reconciliation: DispatchReconciliation }
  | { kind: "skipped"; detail: DispatchRunDetail; reconciliation: DispatchReconciliation }
  | { kind: "missing" }
  | { kind: "repo_mismatch"; detail: DispatchRunDetail; expectedRepoName: string; actualRepoName: string };

export interface ReconcileDispatchRunOptions {
  repoName: string;
  olderThanMs: number;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
  processExists?: ProcessExists;
}

type ReconciliationDecision =
  | { kind: "fail"; attempt: DispatchAttemptDetail | null; reason: string; staleReferenceAt: string; processId: number | null }
  | { kind: "skip"; reason: string; attempt: DispatchAttemptDetail | null; staleReferenceAt: string | null; processId: number | null };

class ReconcileStatusLostError extends Error {
  constructor() {
    super("dispatch reconcile status was lost during update");
  }
}

export function reconcileDispatchRun(
  db: Database,
  runId: string,
  options: ReconcileDispatchRunOptions
): ReconcileDispatchRunResult {
  const existing = getDispatchRunDetailById(db, runId);
  if (existing === null) {
    return { kind: "missing" };
  }

  if (existing.run.repo_name !== null && existing.run.repo_name !== options.repoName) {
    return {
      kind: "repo_mismatch",
      detail: existing,
      expectedRepoName: existing.run.repo_name,
      actualRepoName: options.repoName
    };
  }

  const reconcile = db.transaction(() => {
    const current = getDispatchRunDetailById(db, runId);
    if (current === null) {
      return { kind: "missing" } satisfies ReconcileDispatchRunResult;
    }

    const checkedAt = (options.now ?? defaultNow)();
    const processExists = options.processExists ?? defaultProcessExists;
    const decision = decideReconciliation(current, {
      checkedAt,
      olderThanMs: options.olderThanMs,
      processExists
    });

    if (decision.kind === "skip") {
      const reconciliation = buildReconciliation(current, {
        attempt: decision.attempt,
        reason: decision.reason,
        changed: false,
        processId: decision.processId,
        staleReferenceAt: decision.staleReferenceAt,
        staleAfterMs: options.olderThanMs,
        checkedAt,
        reconciledAt: null
      });

      return {
        kind: isTerminalRunStatus(current.run.status) ? "already_terminal" : "skipped",
        detail: current,
        reconciliation
      } satisfies ReconcileDispatchRunResult;
    }

    const timestamp = checkedAt;
    if (decision.attempt !== null) {
      const attemptUpdated = updateDispatchAttemptStatus(db, {
        id: decision.attempt.id,
        status: "failed",
        endedAt: timestamp,
        errorMessage: `Dispatch reconcile marked stale run failed: ${decision.reason}`,
        expectedStatus: decision.attempt.status
      });

      if (attemptUpdated !== 1) {
        throw new ReconcileStatusLostError();
      }
    }

    const runUpdated = updateDispatchRunStatus(db, {
      id: runId,
      status: "failed",
      updatedAt: timestamp,
      finishedAt: timestamp,
      expectedStatus: current.run.status
    });

    if (runUpdated !== 1) {
      throw new ReconcileStatusLostError();
    }

    const reconciliation = buildReconciliation(current, {
      attempt: decision.attempt,
      reason: decision.reason,
      changed: true,
      processId: decision.processId,
      staleReferenceAt: decision.staleReferenceAt,
      staleAfterMs: options.olderThanMs,
      checkedAt,
      reconciledAt: timestamp
    });

    insertDispatchEvent(db, {
      id: `evt_${(options.idGenerator ?? uuidv7)()}`,
      runId,
      attemptId: decision.attempt?.id ?? null,
      ts: timestamp,
      type: "reconciled_failed",
      message: "Reconciled stale dispatch run as failed.",
      dataJson: JSON.stringify(reconciliation)
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`reconciled dispatch run '${runId}' could not be read back`);
    }

    return { kind: "reconciled", detail, reconciliation } satisfies ReconcileDispatchRunResult;
  });

  try {
    return reconcile.immediate();
  } catch (error) {
    if (!(error instanceof ReconcileStatusLostError)) {
      throw error;
    }

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      return { kind: "missing" };
    }

    const checkedAt = (options.now ?? defaultNow)();
    const reconciliation = buildReconciliation(detail, {
      attempt: detail.attempts.length === 1 ? detail.attempts[0] : null,
      reason: "status_changed",
      changed: false,
      processId: detail.attempts.length === 1 ? detail.attempts[0].process_id : null,
      staleReferenceAt: detail.run.updated_at,
      staleAfterMs: options.olderThanMs,
      checkedAt,
      reconciledAt: null
    });
    return { kind: "skipped", detail, reconciliation };
  }
}

export function reconcileDispatchRuns(db: Database, options: ReconcileDispatchRunOptions): ReconcileDispatchRunResult[] {
  return listDispatchRunDetails(db)
    .filter((detail) => detail.run.status === "claimed" || detail.run.status === "running")
    .map((detail) => reconcileDispatchRun(db, detail.run.id, options));
}

function decideReconciliation(
  detail: DispatchRunDetail,
  options: {
    checkedAt: string;
    olderThanMs: number;
    processExists: ProcessExists;
  }
): ReconciliationDecision {
  if (isTerminalRunStatus(detail.run.status)) {
    return skip("already_terminal", detail, null);
  }

  if (detail.run.status === "claimed") {
    if (detail.attempts.length > 0) {
      return skip("claimed_has_attempts", detail, null);
    }

    return staleDecision(detail, null, options, "stale_claimed_without_attempts");
  }

  if (detail.run.status !== "running") {
    return skip("unsupported_run_status", detail, null);
  }

  if (detail.attempts.length === 0) {
    return skip("missing_attempt", detail, null);
  }

  if (detail.attempts.length > 1) {
    return skip("multiple_attempts", detail, null);
  }

  const attempt = detail.attempts[0];
  if (attempt.status === "preparing_workspace") {
    return staleDecision(detail, attempt, options, "stale_preparing_workspace");
  }

  if (attempt.status !== "launching_agent") {
    return skip("unsupported_attempt_status", detail, attempt);
  }

  if (attempt.session_id !== null) {
    return skip("session_attached", detail, attempt);
  }

  if (attempt.process_id === null) {
    return skip("missing_process_id", detail, attempt);
  }

  if (!isPositiveSafeInteger(attempt.process_id)) {
    return skip("invalid_process_id", detail, attempt, attempt.process_id);
  }

  const stale = staleReference(detail.run.updated_at, options.checkedAt, options.olderThanMs);
  if (stale.kind !== "stale") {
    return skip(stale.kind, detail, attempt, attempt.process_id, stale.referenceAt);
  }

  if (options.processExists(attempt.process_id)) {
    return skip("process_alive", detail, attempt, attempt.process_id, stale.referenceAt);
  }

  return {
    kind: "fail",
    attempt,
    reason: "launch_process_dead",
    staleReferenceAt: stale.referenceAt,
    processId: attempt.process_id
  };
}

function staleDecision(
  detail: DispatchRunDetail,
  attempt: DispatchAttemptDetail | null,
  options: {
    checkedAt: string;
    olderThanMs: number;
  },
  reason: string
): ReconciliationDecision {
  const stale = staleReference(detail.run.updated_at, options.checkedAt, options.olderThanMs);
  if (stale.kind !== "stale") {
    return skip(stale.kind, detail, attempt, attempt?.process_id ?? null, stale.referenceAt);
  }

  return {
    kind: "fail",
    attempt,
    reason,
    staleReferenceAt: stale.referenceAt,
    processId: attempt?.process_id ?? null
  };
}

function staleReference(
  referenceAt: string,
  checkedAt: string,
  olderThanMs: number
): { kind: "stale"; referenceAt: string } | { kind: "not_stale" | "invalid_timestamp"; referenceAt: string | null } {
  const referenceMs = Date.parse(referenceAt);
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(referenceMs) || !Number.isFinite(checkedMs)) {
    return { kind: "invalid_timestamp", referenceAt: Number.isFinite(referenceMs) ? referenceAt : null };
  }

  return checkedMs - referenceMs >= olderThanMs
    ? { kind: "stale", referenceAt }
    : { kind: "not_stale", referenceAt };
}

function skip(
  reason: string,
  detail: DispatchRunDetail,
  attempt: DispatchAttemptDetail | null,
  processId = attempt?.process_id ?? null,
  staleReferenceAt: string | null = detail.run.updated_at
): ReconciliationDecision {
  return { kind: "skip", reason, attempt, staleReferenceAt, processId };
}

function buildReconciliation(
  detail: DispatchRunDetail,
  input: {
    attempt: DispatchAttemptDetail | null;
    reason: string;
    changed: boolean;
    processId: number | null;
    staleReferenceAt: string | null;
    staleAfterMs: number;
    checkedAt: string;
    reconciledAt: string | null;
  }
): DispatchReconciliation {
  return {
    run_id: detail.run.id,
    attempt_id: input.attempt?.id ?? null,
    previous_run_status: detail.run.status,
    previous_attempt_status: input.attempt?.status ?? null,
    status: input.changed ? "failed" : detail.run.status,
    attempt_status: input.attempt === null ? null : input.changed ? "failed" : input.attempt.status,
    reason: input.reason,
    changed: input.changed,
    process_id: input.processId,
    stale_reference_at: input.staleReferenceAt,
    stale_after_ms: input.staleAfterMs,
    checked_at: input.checkedAt,
    reconciled_at: input.reconciledAt
  };
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status as (typeof TERMINAL_RUN_STATUSES)[number]);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: string }).code;
      if (code === "ESRCH" || code === "EINVAL") {
        return false;
      }

      if (code === "EPERM") {
        return true;
      }
    }

    return false;
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}
