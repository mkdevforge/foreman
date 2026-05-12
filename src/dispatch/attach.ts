import type { Database } from "bun:sqlite";
import { v7 as uuidv7 } from "uuid";
import { getDispatchRunDetailById, type DispatchRunDetail } from "../db/dispatch-queries";
import { attachDispatchAttemptSession, insertDispatchEvent } from "../db/dispatch-writes";

type IdGenerator = () => string;
type NowGenerator = () => string;

export type AttachDispatchSessionResult =
  | { kind: "attached"; detail: DispatchRunDetail }
  | { kind: "already_attached"; detail: DispatchRunDetail }
  | { kind: "missing" }
  | { kind: "not_attachable"; detail: DispatchRunDetail; reason: string };

export interface AttachDispatchSessionOptions {
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export function attachDispatchSession(
  db: Database,
  input: {
    runId: string;
    attemptId: string;
    sessionId: string;
  },
  options: AttachDispatchSessionOptions = {}
): AttachDispatchSessionResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;

  const attached = db.transaction(() => {
    const existing = getDispatchRunDetailById(db, input.runId);
    if (existing === null) {
      return { kind: "missing" } satisfies AttachDispatchSessionResult;
    }

    const attachable = validateAttachable(existing, input);
    if (attachable !== null) {
      return attachable;
    }

    const attachedAt = now();
    const updated = attachDispatchAttemptSession(db, {
      id: input.attemptId,
      runId: input.runId,
      expectedStatus: "launching_agent",
      sessionId: input.sessionId
    });

    if (updated !== 1) {
      const current = getDispatchRunDetailById(db, input.runId);
      if (current === null) {
        return { kind: "missing" } satisfies AttachDispatchSessionResult;
      }

      const retryResult = validateAttachable(current, input);
      return (
        retryResult ??
        ({ kind: "not_attachable", detail: current, reason: "status_changed" } satisfies AttachDispatchSessionResult)
      );
    }

    insertDispatchEvent(db, {
      id: `evt_${idGenerator()}`,
      runId: input.runId,
      attemptId: input.attemptId,
      ts: attachedAt,
      type: "session_attached",
      message: "Attached captured session to dispatch attempt.",
      dataJson: JSON.stringify({
        status: "launching_agent",
        session_id: input.sessionId
      })
    });

    const detail = getDispatchRunDetailById(db, input.runId);
    if (detail === null) {
      throw new Error(`attached dispatch run '${input.runId}' could not be read back`);
    }

    return { kind: "attached", detail } satisfies AttachDispatchSessionResult;
  });

  return attached.immediate();
}

function validateAttachable(
  detail: DispatchRunDetail,
  input: {
    attemptId: string;
    sessionId: string;
  }
): AttachDispatchSessionResult | null {
  const attempt = detail.attempts.find((candidate) => candidate.id === input.attemptId);
  if (attempt === undefined) {
    return { kind: "not_attachable", detail, reason: "attempt_missing" };
  }

  if (attempt.session_id === input.sessionId) {
    return { kind: "already_attached", detail };
  }

  if (attempt.session_id !== null) {
    return { kind: "not_attachable", detail, reason: "attempt_session_conflict" };
  }

  if (detail.run.status !== "running") {
    return { kind: "not_attachable", detail, reason: "status_not_running" };
  }

  if (attempt.status !== "launching_agent") {
    return { kind: "not_attachable", detail, reason: "attempt_status_not_launching_agent" };
  }

  return null;
}

function defaultNow(): string {
  return new Date().toISOString();
}
