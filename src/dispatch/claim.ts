import type { Database } from "bun:sqlite";
import { v7 as uuidv7 } from "uuid";
import { getDispatchRunDetailById, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent, updateDispatchRunStatus } from "../db/dispatch-writes";

type IdGenerator = () => string;
type NowGenerator = () => string;

export const DISPATCH_TOOLS = ["claude-code", "codex"] as const;

export type DispatchTool = (typeof DISPATCH_TOOLS)[number];

export type ClaimDispatchRunResult =
  | { kind: "claimed"; detail: DispatchRunDetail }
  | { kind: "missing" }
  | { kind: "not_claimable"; detail: DispatchRunDetail };

export interface ClaimQueuedDispatchRunOptions {
  tool: DispatchTool;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export function claimQueuedDispatchRun(
  db: Database,
  runId: string,
  options: ClaimQueuedDispatchRunOptions
): ClaimDispatchRunResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;

  const claim = db.transaction(() => {
    const existing = getDispatchRunDetailById(db, runId);

    if (existing === null) {
      return { kind: "missing" } satisfies ClaimDispatchRunResult;
    }

    if (existing.run.status !== "queued") {
      return { kind: "not_claimable", detail: existing } satisfies ClaimDispatchRunResult;
    }

    const timestamp = now();
    updateDispatchRunStatus(db, {
      id: runId,
      status: "claimed",
      updatedAt: timestamp
    });

    insertDispatchEvent(db, {
      id: `evt_${idGenerator()}`,
      runId,
      ts: timestamp,
      type: "claimed",
      message: `Dispatch run claimed for ${options.tool}.`,
      dataJson: JSON.stringify({
        previous_status: existing.run.status,
        status: "claimed",
        tool: options.tool
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`claimed dispatch run '${runId}' could not be read back`);
    }

    return { kind: "claimed", detail } satisfies ClaimDispatchRunResult;
  });

  return claim.immediate();
}

function defaultNow(): string {
  return new Date().toISOString();
}
