import { CliError } from "../cli/errors";

export const SCHEMA_VERSION = 1;

export const TASK_STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
export const CHUNK_STAGES = ["discovery", "plan", "implement", "review"] as const;
export const QUESTION_STATUSES = ["open", "answered"] as const;
export const DISPATCH_READINESS_STATUSES = ["needs_context", "ready", "blocked"] as const;
export const DISPATCH_RISK_LEVELS = ["low", "medium", "high"] as const;
export const DISPATCH_APPROVAL_REQUIREMENTS = ["none", "plan", "implement", "review"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ChunkStage = (typeof CHUNK_STAGES)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export type DispatchReadinessStatus = (typeof DISPATCH_READINESS_STATUSES)[number];
export type DispatchRiskLevel = (typeof DISPATCH_RISK_LEVELS)[number];
export type DispatchApprovalRequirement = (typeof DISPATCH_APPROVAL_REQUIREMENTS)[number];

export interface ChunkNote {
  ts: string;
  body: string;
  [key: string]: unknown;
}

export interface ChunkQuestion {
  id: string;
  status: QuestionStatus;
  body: string;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
  [key: string]: unknown;
}

export interface ChunkDecision {
  id: string;
  body: string;
  decided_at: string;
  [key: string]: unknown;
}

export interface ChunkDispatchReadiness {
  status: DispatchReadinessStatus;
  risk_level: DispatchRiskLevel;
  approval_required: DispatchApprovalRequirement;
  allowed_actions: string[];
  blocked_actions: string[];
  [key: string]: unknown;
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
  questions?: ChunkQuestion[];
  decisions?: ChunkDecision[];
  dispatch?: ChunkDispatchReadiness;
  [key: string]: unknown;
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
  [key: string]: unknown;
}

export interface ChunkRef {
  taskId: string;
  chunkId: string;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHUNK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const QUESTION_ID_PATTERN = /^q_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISION_ID_PATTERN = /^d_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export function assertValidQuestionId(id: string): void {
  if (!QUESTION_ID_PATTERN.test(id)) {
    throw new CliError(2, "invalid_question_id", `invalid question id '${id}'; expected q_<uuidv7>`);
  }
}

export function assertValidDecisionId(id: string): void {
  if (!DECISION_ID_PATTERN.test(id)) {
    throw new CliError(2, "invalid_decision_id", `invalid decision id '${id}'; expected d_<uuidv7>`);
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
