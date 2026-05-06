import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CliError } from "../cli/errors";
import {
  SCHEMA_VERSION,
  assertIsoUtcTimestamp,
  assertValidChunkId,
  assertValidChunkStage,
  assertValidTaskId,
  type ChunkStage
} from "./schema";

export const ACTIVE_CONTEXT_STALE_HOURS = 24;
export const ACTIVE_CONTEXT_STALE_MS = ACTIVE_CONTEXT_STALE_HOURS * 60 * 60 * 1000;

export interface ActiveContext {
  schema_version: 1;
  task_id: string;
  chunk_id: string;
  stage: ChunkStage;
  stage_override: ChunkStage | null;
  control_repo_root: string;
  project_path: string;
  created_at: string;
}

export type ActiveContextReadResult =
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; error: string }
  | { kind: "valid"; path: string; context: ActiveContext };

export interface ActiveContextStatus {
  read: ActiveContextReadResult;
  stale: boolean;
  staleAfterHours: number;
}

export function getDefaultForemanHome(homeDir = homedir()): string {
  return join(homeDir, ".foreman");
}

export function getActiveContextPath(homeDir = homedir()): string {
  return join(getDefaultForemanHome(homeDir), "active.json");
}

export function writeActiveContext(context: ActiveContext, homeDir = homedir()): string {
  const path = getActiveContextPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify(validateActiveContext(context, path), null, 2)}\n`);
  return path;
}

export function readActiveContext(homeDir = homedir()): ActiveContextReadResult {
  const path = getActiveContextPath(homeDir);
  if (!existsSync(path)) {
    return { kind: "missing", path };
  }

  try {
    if (!statSync(path).isFile()) {
      return { kind: "invalid", path, error: "active context path is not a file" };
    }

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { kind: "valid", path, context: validateActiveContext(parsed, path) };
  } catch (error) {
    return { kind: "invalid", path, error: errorMessage(error) };
  }
}

export function clearActiveContext(homeDir = homedir()): boolean {
  const path = getActiveContextPath(homeDir);
  if (!existsSync(path)) {
    return false;
  }

  unlinkSync(path);
  return true;
}

export function getActiveContextStatus(homeDir = homedir(), now = new Date()): ActiveContextStatus {
  const read = readActiveContext(homeDir);
  return {
    read,
    stale: read.kind === "valid" ? isActiveContextStale(read.context, now) : false,
    staleAfterHours: ACTIVE_CONTEXT_STALE_HOURS
  };
}

export function isActiveContextStale(context: ActiveContext, now = new Date()): boolean {
  const createdAtMs = new Date(context.created_at).getTime();
  return Number.isFinite(createdAtMs) && now.getTime() - createdAtMs > ACTIVE_CONTEXT_STALE_MS;
}

function validateActiveContext(value: unknown, source: string): ActiveContext {
  const record = expectRecord(value, source);

  if (record.schema_version !== SCHEMA_VERSION) {
    throw new CliError(2, "invalid_active_context", `${source}: schema_version must be ${SCHEMA_VERSION}`);
  }

  const taskId = expectString(record.task_id, "task_id", source);
  const chunkId = expectString(record.chunk_id, "chunk_id", source);
  const stage = expectString(record.stage, "stage", source);
  const stageOverride = expectNullableString(record.stage_override, "stage_override", source);
  const controlRepoRoot = expectString(record.control_repo_root, "control_repo_root", source);
  const projectPath = expectString(record.project_path, "project_path", source);
  const createdAt = expectString(record.created_at, "created_at", source);

  assertValidTaskId(taskId);
  assertValidChunkId(chunkId);
  assertValidChunkStage(stage);
  if (stageOverride !== null) {
    assertValidChunkStage(stageOverride);
  }
  assertNonEmpty(controlRepoRoot, "control_repo_root", source);
  assertNonEmpty(projectPath, "project_path", source);
  assertIsoUtcTimestamp(createdAt, "created_at", source);

  return {
    schema_version: SCHEMA_VERSION,
    task_id: taskId,
    chunk_id: chunkId,
    stage,
    stage_override: stageOverride,
    control_repo_root: controlRepoRoot,
    project_path: projectPath,
    created_at: createdAt
  };
}

function expectRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(2, "invalid_active_context", `${source}: active context must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function expectString(value: unknown, fieldName: string, source: string): string {
  if (typeof value !== "string") {
    throw new CliError(2, "invalid_active_context", `${source}: ${fieldName} must be a string`);
  }

  return value;
}

function expectNullableString(value: unknown, fieldName: string, source: string): string | null {
  if (value === null) {
    return null;
  }

  return expectString(value, fieldName, source);
}

function assertNonEmpty(value: string, fieldName: string, source: string): void {
  if (value.trim().length === 0) {
    throw new CliError(2, "invalid_active_context", `${source}: ${fieldName} must not be empty`);
  }
}

function atomicWriteFile(path: string, body: string): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

  try {
    writeFileSync(tempPath, body, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
