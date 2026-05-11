import type { Database } from "bun:sqlite";
import { v7 as uuidv7 } from "uuid";
import { getDispatchRunDetailById, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent, insertDispatchRun } from "../db/dispatch-writes";
import type { ChunkRef, ChunkStage } from "../store/schema";

type IdGenerator = () => string;
type NowGenerator = () => string;

export interface CreateQueuedDispatchRunOptions {
  requestedStage: ChunkStage;
  requestedBy?: string | null;
  source?: string;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export function createQueuedDispatchRun(
  db: Database,
  ref: ChunkRef,
  options: CreateQueuedDispatchRunOptions
): DispatchRunDetail {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;
  const source = options.source ?? "cli";
  const timestamp = now();
  const runId = `run_${idGenerator()}`;
  const eventId = `evt_${idGenerator()}`;

  const create = db.transaction(() => {
    insertDispatchRun(db, {
      id: runId,
      taskId: ref.taskId,
      chunkId: ref.chunkId,
      requestedStage: options.requestedStage,
      status: "queued",
      requestedBy: options.requestedBy ?? null,
      source,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    insertDispatchEvent(db, {
      id: eventId,
      runId,
      ts: timestamp,
      type: "queued",
      message: `Queued dispatch run for ${ref.taskId}/${ref.chunkId}.`,
      dataJson: JSON.stringify({
        task_id: ref.taskId,
        chunk_id: ref.chunkId,
        requested_stage: options.requestedStage,
        source
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`created dispatch run '${runId}' could not be read back`);
    }

    return detail;
  });

  return create.immediate();
}

function defaultNow(): string {
  return new Date().toISOString();
}
