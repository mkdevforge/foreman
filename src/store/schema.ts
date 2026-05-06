import { CliError } from "../cli/errors";

export const SCHEMA_VERSION = 1;

export const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
export const CHUNK_STAGES = ["discovery", "plan", "implement", "review"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ChunkStage = (typeof CHUNK_STAGES)[number];

export interface ChunkNote {
  ts: string;
  author: string;
  body: string;
}

export interface ForemanChunk {
  id: string;
  title: string;
  spec: string;
  status: TaskStatus;
  stage: ChunkStage;
  created_at: string;
  updated_at: string;
  notes: ChunkNote[];
}

export interface ForemanTask {
  schema_version: 1;
  id: string;
  title: string;
  source_ref: string | null;
  description: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  chunks: ForemanChunk[];
}

export interface ChunkRef {
  taskId: string;
  chunkId: string;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHUNK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertValidTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new CliError(
      2,
      "invalid_task_id",
      `invalid task id '${id}'; expected [A-Za-z0-9][A-Za-z0-9._-]*`
    );
  }
}

export function assertValidChunkId(id: string): void {
  if (!CHUNK_ID_PATTERN.test(id)) {
    throw new CliError(
      2,
      "invalid_chunk_id",
      `invalid chunk id '${id}'; expected [a-z0-9][a-z0-9-]*`
    );
  }
}

export function parseChunkRef(ref: string): ChunkRef {
  const parts = ref.split("/");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CliError(2, "invalid_chunk_ref", "chunk reference must use <task>/<chunk>");
  }

  const [taskId, chunkId] = parts;
  assertValidTaskId(taskId);
  assertValidChunkId(chunkId);

  return { taskId, chunkId };
}

export function assertValidTaskStatus(status: string): asserts status is TaskStatus {
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new CliError(
      2,
      "invalid_status",
      `invalid status '${status}'; expected one of ${TASK_STATUSES.join(", ")}`
    );
  }
}

export function assertValidChunkStage(stage: string): asserts stage is ChunkStage {
  if (!CHUNK_STAGES.includes(stage as ChunkStage)) {
    throw new CliError(
      2,
      "invalid_stage",
      `invalid stage '${stage}'; expected one of ${CHUNK_STAGES.join(", ")}`
    );
  }
}

export function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new CliError(2, "invalid_input", `${fieldName} must not be empty`);
  }
}

export function assertIsoUtcTimestamp(value: string, fieldName: string, source: string): void {
  if (!ISO_UTC_PATTERN.test(value)) {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must be an ISO 8601 UTC timestamp`);
  }
}
