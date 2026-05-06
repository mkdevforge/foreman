import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { CliError } from "../cli/errors";
import { getForemanPaths, type ForemanPaths } from "./repo";
import {
  SCHEMA_VERSION,
  assertIsoUtcTimestamp,
  assertNonEmpty,
  assertValidChunkId,
  assertValidChunkStage,
  assertValidTaskId,
  assertValidTaskStatus,
  nowIso,
  type ChunkNote,
  type ForemanChunk,
  type ForemanTask,
  type TaskStatus
} from "./schema";

export interface AddTaskInput {
  id: string;
  title: string;
  sourceRef?: string;
  description?: string;
}

export interface AddChunkInput {
  taskId: string;
  chunkId: string;
  title: string;
  spec: string;
}

const README_BODY = `# Foreman

Repo-scoped Foreman task metadata lives here.

- \`tasks/*.yaml\` contains task and chunk definitions.
- These files are intended to be committed with the repository.
`;

export function initializeForemanRepo(repoRoot: string): ForemanPaths {
  const paths = getForemanPaths(repoRoot);

  mkdirSync(paths.tasksDir, { recursive: true });

  if (!existsSync(paths.readmePath)) {
    atomicWriteFile(paths.readmePath, README_BODY);
  }

  return paths;
}

export function addTask(repoRoot: string, input: AddTaskInput): ForemanTask {
  const paths = requireInitialized(repoRoot);

  assertValidTaskId(input.id);
  assertNonEmpty(input.title, "title");

  const path = taskFilePath(paths, input.id);
  if (existsSync(path)) {
    throw new CliError(2, "task_exists", `task '${input.id}' already exists`);
  }

  const now = nowIso();
  const task: ForemanTask = {
    schema_version: SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    source_ref: input.sourceRef ?? null,
    description: input.description ?? null,
    status: "todo",
    created_at: now,
    updated_at: now,
    chunks: []
  };

  writeTaskFile(paths, task);
  return task;
}

export function listTasks(repoRoot: string, status?: string): ForemanTask[] {
  const paths = requireInitialized(repoRoot);
  let statusFilter: TaskStatus | undefined;

  if (status !== undefined) {
    assertValidTaskStatus(status);
    statusFilter = status;
  }

  const tasks = readdirSync(paths.tasksDir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => readTaskFile(join(paths.tasksDir, file)))
    .sort((left, right) => left.id.localeCompare(right.id));

  return statusFilter === undefined ? tasks : tasks.filter((task) => task.status === statusFilter);
}

export function readTask(repoRoot: string, id: string): ForemanTask {
  const paths = requireInitialized(repoRoot);

  assertValidTaskId(id);

  const path = taskFilePath(paths, id);
  if (!existsSync(path)) {
    throw new CliError(2, "task_not_found", `task '${id}' was not found`);
  }

  const task = readTaskFile(path);
  if (task.id !== id) {
    throw new CliError(2, "invalid_task_yaml", `${path}: task id '${task.id}' does not match file name '${id}'`);
  }

  return task;
}

export function updateTaskStatus(repoRoot: string, id: string, status: string): ForemanTask {
  assertValidTaskStatus(status);

  const paths = requireInitialized(repoRoot);
  const task = readTask(repoRoot, id);

  task.status = status;
  task.updated_at = nowIso();
  writeTaskFile(paths, task);

  return task;
}

export function addChunk(repoRoot: string, input: AddChunkInput): ForemanChunk {
  const paths = requireInitialized(repoRoot);
  const task = readTask(repoRoot, input.taskId);

  assertValidChunkId(input.chunkId);
  assertNonEmpty(input.title, "title");

  if (task.chunks.some((chunk) => chunk.id === input.chunkId)) {
    throw new CliError(2, "chunk_exists", `chunk '${input.taskId}/${input.chunkId}' already exists`);
  }

  const now = nowIso();
  const chunk: ForemanChunk = {
    id: input.chunkId,
    title: input.title,
    spec: input.spec,
    status: "todo",
    stage: "discovery",
    created_at: now,
    updated_at: now,
    notes: []
  };

  task.chunks.push(chunk);
  task.updated_at = now;
  writeTaskFile(paths, task);

  return chunk;
}

export function listChunks(repoRoot: string, taskId: string): ForemanChunk[] {
  return readTask(repoRoot, taskId).chunks;
}

function requireInitialized(repoRoot: string): ForemanPaths {
  const paths = getForemanPaths(repoRoot);

  if (!existsSync(paths.tasksDir) || !statSync(paths.tasksDir).isDirectory()) {
    throw new CliError(2, "not_initialized", "foreman is not initialized in this repository; run 'foreman init'");
  }

  return paths;
}

function taskFilePath(paths: ForemanPaths, id: string): string {
  return join(paths.tasksDir, `${id}.yaml`);
}

function readTaskFile(path: string): ForemanTask {
  let value: unknown;

  try {
    value = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(2, "invalid_task_yaml", `${path}: failed to parse YAML: ${errorMessage(error)}`);
  }

  return validateTask(value, path);
}

function writeTaskFile(paths: ForemanPaths, task: ForemanTask): void {
  validateTask(task, taskFilePath(paths, task.id));
  atomicWriteFile(taskFilePath(paths, task.id), formatTaskYaml(task));
}

function formatTaskYaml(task: ForemanTask): string {
  return stringify(task, {
    lineWidth: 100
  });
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

function validateTask(value: unknown, source: string): ForemanTask {
  const record = expectRecord(value, "task", source);

  expectNumber(record.schema_version, "schema_version", source);
  if (record.schema_version !== SCHEMA_VERSION) {
    throw new CliError(2, "invalid_task_yaml", `${source}: schema_version must be ${SCHEMA_VERSION}`);
  }

  const id = expectString(record.id, "id", source);
  assertValidTaskId(id);

  const title = expectString(record.title, "title", source);
  const sourceRef = expectNullableString(record.source_ref, "source_ref", source);
  const description = expectNullableString(record.description, "description", source);
  const status = expectString(record.status, "status", source);
  assertValidTaskStatus(status);

  const createdAt = expectString(record.created_at, "created_at", source);
  const updatedAt = expectString(record.updated_at, "updated_at", source);
  assertIsoUtcTimestamp(createdAt, "created_at", source);
  assertIsoUtcTimestamp(updatedAt, "updated_at", source);

  const chunks = expectArray(record.chunks, "chunks", source).map((chunk, index) =>
    validateChunk(chunk, `${source}: chunks[${index}]`)
  );
  const chunkIds = new Set<string>();
  for (const chunk of chunks) {
    if (chunkIds.has(chunk.id)) {
      throw new CliError(2, "invalid_task_yaml", `${source}: duplicate chunk id '${chunk.id}'`);
    }
    chunkIds.add(chunk.id);
  }

  return {
    schema_version: SCHEMA_VERSION,
    id,
    title,
    source_ref: sourceRef,
    description,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
    chunks
  };
}

function validateChunk(value: unknown, source: string): ForemanChunk {
  const record = expectRecord(value, "chunk", source);

  const id = expectString(record.id, "id", source);
  assertValidChunkId(id);

  const title = expectString(record.title, "title", source);
  const spec = expectString(record.spec, "spec", source);
  const status = expectString(record.status, "status", source);
  assertValidTaskStatus(status);
  const stage = expectString(record.stage, "stage", source);
  assertValidChunkStage(stage);

  const createdAt = expectString(record.created_at, "created_at", source);
  const updatedAt = expectString(record.updated_at, "updated_at", source);
  assertIsoUtcTimestamp(createdAt, "created_at", source);
  assertIsoUtcTimestamp(updatedAt, "updated_at", source);

  const notes = expectArray(record.notes, "notes", source).map((note, index) =>
    validateNote(note, `${source}: notes[${index}]`)
  );

  return {
    id,
    title,
    spec,
    status,
    stage,
    created_at: createdAt,
    updated_at: updatedAt,
    notes
  };
}

function validateNote(value: unknown, source: string): ChunkNote {
  const record = expectRecord(value, "note", source);
  const ts = expectString(record.ts, "ts", source);
  assertIsoUtcTimestamp(ts, "ts", source);

  return {
    ts,
    author: expectString(record.author, "author", source),
    body: expectString(record.body, "body", source)
  };
}

function expectRecord(value: unknown, fieldName: string, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

function expectArray(value: unknown, fieldName: string, source: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must be a list`);
  }

  return value;
}

function expectString(value: unknown, fieldName: string, source: string): string {
  if (typeof value !== "string") {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must be a string`);
  }

  return value;
}

function expectNullableString(value: unknown, fieldName: string, source: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must be a string or null`);
  }

  return value;
}

function expectNumber(value: unknown, fieldName: string, source: string): number {
  if (typeof value !== "number") {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must be a number`);
  }

  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
