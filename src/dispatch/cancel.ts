import type { Database } from "bun:sqlite";
import { v7 as uuidv7 } from "uuid";
import { getDispatchRunDetailById, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent, updateDispatchRunStatus } from "../db/dispatch-writes";

type IdGenerator = () => string;
type NowGenerator = () => string;

export type CancelDispatchRunResult =
  | { kind: "canceled"; detail: DispatchRunDetail }
  | { kind: "already_canceled"; detail: DispatchRunDetail }
  | { kind: "missing" }
  | { kind: "not_cancelable"; detail: DispatchRunDetail };

export interface CancelQueuedDispatchRunOptions {
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export function cancelQueuedDispatchRun(
  db: Database,
  runId: string,
  options: CancelQueuedDispatchRunOptions = {}
): CancelDispatchRunResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;

  const cancel = db.transaction(() => {
    const existing = getDispatchRunDetailById(db, runId);

    if (existing === null) {
      return { kind: "missing" } satisfies CancelDispatchRunResult;
    }

    if (existing.run.status === "canceled") {
      return { kind: "already_canceled", detail: existing } satisfies CancelDispatchRunResult;
    }

    if (existing.run.status !== "queued") {
      return { kind: "not_cancelable", detail: existing } satisfies CancelDispatchRunResult;
    }

    const timestamp = now();
    updateDispatchRunStatus(db, {
      id: runId,
      status: "canceled",
      updatedAt: timestamp,
      finishedAt: timestamp
    });

    insertDispatchEvent(db, {
      id: `evt_${idGenerator()}`,
      runId,
      ts: timestamp,
      type: "canceled",
      message: "Dispatch run canceled.",
      dataJson: JSON.stringify({
        previous_status: existing.run.status,
        status: "canceled"
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`canceled dispatch run '${runId}' could not be read back`);
    }

    return { kind: "canceled", detail } satisfies CancelDispatchRunResult;
  });

  return cancel.immediate();
}

function defaultNow(): string {
  return new Date().toISOString();
}
