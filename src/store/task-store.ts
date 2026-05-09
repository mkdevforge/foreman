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
import { v7 as uuidv7 } from "uuid";
import { parse, stringify } from "yaml";
import { CliError } from "../cli/errors";
import { getForemanPaths, type ForemanPaths } from "./repo";
import {
  SCHEMA_VERSION,
  DISPATCH_APPROVAL_REQUIREMENTS,
  DISPATCH_READINESS_STATUSES,
  DISPATCH_RISK_LEVELS,
  QUESTION_STATUSES,
  assertIsoUtcTimestamp,
  assertNonEmpty,
  assertValidChunkId,
  assertValidChunkStage,
  assertValidDecisionId,
  assertValidQuestionId,
  assertValidTaskId,
  assertValidTaskStatus,
  nowIso,
  type ChunkRef,
  type ChunkDecision,
  type ChunkDispatchReadiness,
  type ChunkNote,
  type ChunkQuestion,
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

export interface AppendChunkNoteInput extends ChunkRef {
  body: string;
}

export interface AddChunkQuestionInput extends ChunkRef {
  body: string;
}

export interface AnswerChunkQuestionInput extends ChunkRef {
  questionId: string;
  answer: string;
}

export interface ChunkQuestionMutationResult {
  chunk: ForemanChunk;
  question: ChunkQuestion;
}

export interface AddChunkDecisionInput extends ChunkRef {
  body: string;
}

export interface ChunkDecisionMutationResult {
  chunk: ForemanChunk;
  decision: ChunkDecision;
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

export function updateChunkStatus(repoRoot: string, ref: ChunkRef, status: string): ForemanChunk {
  assertValidTaskStatus(status);

  return mutateChunk(repoRoot, ref, (task, chunk) => {
    const now = nowIso();

    chunk.status = status;
    chunk.updated_at = now;
    task.updated_at = now;
  });
}

export function updateChunkStage(repoRoot: string, ref: ChunkRef, stage: string): ForemanChunk {
  assertValidChunkStage(stage);

  return mutateChunk(repoRoot, ref, (task, chunk) => {
    const now = nowIso();

    chunk.stage = stage;
    chunk.updated_at = now;
    task.updated_at = now;
  });
}

export function appendChunkNote(repoRoot: string, input: AppendChunkNoteInput): ForemanChunk {
  assertNonEmpty(input.body, "note body");

  return mutateChunk(repoRoot, input, (task, chunk) => {
    const now = nowIso();

    chunk.notes.push({
      ts: now,
      body: input.body
    });
    chunk.updated_at = now;
    task.updated_at = now;
  });
}

export function listChunkQuestions(repoRoot: string, ref: ChunkRef): ChunkQuestion[] {
  const task = readTask(repoRoot, ref.taskId);
  const chunk = findChunkOrThrow(task, ref);

  return chunk.questions ?? [];
}

export function addChunkQuestion(repoRoot: string, input: AddChunkQuestionInput): ChunkQuestionMutationResult {
  assertNonEmpty(input.body, "question body");

  let question: ChunkQuestion | undefined;
  const chunk = mutateChunk(repoRoot, input, (task, targetChunk) => {
    const now = nowIso();
    const questions = targetChunk.questions ?? [];

    question = {
      id: nextQuestionId(questions),
      status: "open",
      body: input.body,
      asked_at: now,
      answered_at: null,
      answer: null
    };

    targetChunk.questions = [...questions, question];
    targetChunk.updated_at = now;
    task.updated_at = now;
  });

  if (question === undefined) {
    throw new CliError(1, "internal_error", "failed to add question");
  }

  return { chunk, question };
}

export function answerChunkQuestion(repoRoot: string, input: AnswerChunkQuestionInput): ChunkQuestionMutationResult {
  assertValidQuestionId(input.questionId);
  assertNonEmpty(input.answer, "answer");

  let question: ChunkQuestion | undefined;
  const chunk = mutateChunk(repoRoot, input, (task, targetChunk) => {
    const questions = targetChunk.questions ?? [];
    question = questions.find((candidate) => candidate.id === input.questionId);

    if (question === undefined) {
      throw new CliError(
        2,
        "question_not_found",
        `question '${input.taskId}/${input.chunkId}#${input.questionId}' was not found`
      );
    }

    if (question.status === "answered") {
      throw new CliError(
        2,
        "question_already_answered",
        `question '${input.taskId}/${input.chunkId}#${input.questionId}' is already answered`
      );
    }

    const now = nowIso();
    question.status = "answered";
    question.answered_at = now;
    question.answer = input.answer;
    targetChunk.updated_at = now;
    task.updated_at = now;
  });

  if (question === undefined) {
    throw new CliError(1, "internal_error", "failed to answer question");
  }

  return { chunk, question };
}

export function listChunkDecisions(repoRoot: string, ref: ChunkRef): ChunkDecision[] {
  const task = readTask(repoRoot, ref.taskId);
  const chunk = findChunkOrThrow(task, ref);

  return chunk.decisions ?? [];
}

export function addChunkDecision(repoRoot: string, input: AddChunkDecisionInput): ChunkDecisionMutationResult {
  assertNonEmpty(input.body, "decision body");

  let decision: ChunkDecision | undefined;
  const chunk = mutateChunk(repoRoot, input, (task, targetChunk) => {
    const now = nowIso();
    const decisions = targetChunk.decisions ?? [];

    decision = {
      id: nextDecisionId(decisions),
      body: input.body,
      decided_at: now
    };

    targetChunk.decisions = [...decisions, decision];
    targetChunk.updated_at = now;
    task.updated_at = now;
  });

  if (decision === undefined) {
    throw new CliError(1, "internal_error", "failed to add decision");
  }

  return { chunk, decision };
}

function mutateChunk(
  repoRoot: string,
  ref: ChunkRef,
  mutate: (task: ForemanTask, chunk: ForemanChunk) => void
): ForemanChunk {
  const paths = requireInitialized(repoRoot);
  const task = readTask(repoRoot, ref.taskId);
  const chunk = findChunkOrThrow(task, ref);

  mutate(task, chunk);
  writeTaskFile(paths, task);

  return chunk;
}

function findChunkOrThrow(task: ForemanTask, ref: ChunkRef): ForemanChunk {
  const chunk = task.chunks.find((candidate) => candidate.id === ref.chunkId);

  if (chunk === undefined) {
    throw new CliError(2, "chunk_not_found", `chunk '${ref.taskId}/${ref.chunkId}' was not found`);
  }

  return chunk;
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
  const normalized = validateTask(task, taskFilePath(paths, task.id));
  atomicWriteFile(taskFilePath(paths, normalized.id), formatTaskYaml(normalized));
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
    ...record,
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
  const questions =
    record.questions === undefined
      ? undefined
      : expectArray(record.questions, "questions", source).map((question, index) =>
          validateQuestion(question, `${source}: questions[${index}]`)
        );
  if (questions !== undefined) {
    assertUniqueIds(questions, "questions", source);
  }
  const decisions =
    record.decisions === undefined
      ? undefined
      : expectArray(record.decisions, "decisions", source).map((decision, index) =>
          validateDecision(decision, `${source}: decisions[${index}]`)
        );
  if (decisions !== undefined) {
    assertUniqueIds(decisions, "decisions", source);
  }
  const dispatch =
    record.dispatch === undefined ? undefined : validateDispatchReadiness(record.dispatch, `${source}: dispatch`);

  return {
    ...record,
    id,
    title,
    spec,
    status,
    stage,
    created_at: createdAt,
    updated_at: updatedAt,
    notes,
    ...(questions === undefined ? {} : { questions }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(dispatch === undefined ? {} : { dispatch })
  };
}

function validateNote(value: unknown, source: string): ChunkNote {
  const record = expectRecord(value, "note", source);
  const ts = expectString(record.ts, "ts", source);
  assertIsoUtcTimestamp(ts, "ts", source);

  return {
    ...record,
    ts,
    body: expectString(record.body, "body", source)
  };
}

function validateQuestion(value: unknown, source: string): ChunkQuestion {
  const record = expectRecord(value, "question", source);
  const id = expectNonEmptyString(record.id, "id", source);
  assertValidQuestionId(id);
  const status = expectString(record.status, "status", source);
  if (!QUESTION_STATUSES.includes(status as ChunkQuestion["status"])) {
    throw new CliError(
      2,
      "invalid_task_yaml",
      `${source}: status must be one of ${QUESTION_STATUSES.join(", ")}`
    );
  }
  const questionStatus = status as ChunkQuestion["status"];

  const body = expectNonEmptyString(record.body, "body", source);
  const askedAt = expectString(record.asked_at, "asked_at", source);
  assertIsoUtcTimestamp(askedAt, "asked_at", source);
  const answeredAt = expectNullableString(record.answered_at, "answered_at", source);
  if (answeredAt !== null) {
    assertIsoUtcTimestamp(answeredAt, "answered_at", source);
  }
  const answer = expectNullableString(record.answer, "answer", source);

  if (questionStatus === "open" && (answeredAt !== null || answer !== null)) {
    throw new CliError(2, "invalid_task_yaml", `${source}: open questions must not have an answer`);
  }

  if (questionStatus === "answered" && (answeredAt === null || answer === null || answer.trim().length === 0)) {
    throw new CliError(2, "invalid_task_yaml", `${source}: answered questions must have answered_at and answer`);
  }

  return {
    ...record,
    id,
    status: questionStatus,
    body,
    asked_at: askedAt,
    answered_at: answeredAt,
    answer
  };
}

function assertUniqueIds(items: { id: string }[], fieldName: string, source: string): void {
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.id)) {
      throw new CliError(2, "invalid_task_yaml", `${source}: duplicate ${fieldName} id '${item.id}'`);
    }

    seen.add(item.id);
  }
}

function nextQuestionId(questions: ChunkQuestion[]): string {
  return nextPrefixedUuidId("q", questions.map((question) => question.id));
}

function validateDecision(value: unknown, source: string): ChunkDecision {
  const record = expectRecord(value, "decision", source);
  const id = expectNonEmptyString(record.id, "id", source);
  assertValidDecisionId(id);
  const body = expectNonEmptyString(record.body, "body", source);
  const decidedAt = expectString(record.decided_at, "decided_at", source);
  assertIsoUtcTimestamp(decidedAt, "decided_at", source);

  return {
    ...record,
    id,
    body,
    decided_at: decidedAt
  };
}

function nextDecisionId(decisions: ChunkDecision[]): string {
  return nextPrefixedUuidId("d", decisions.map((decision) => decision.id));
}

function nextPrefixedUuidId(prefix: "q" | "d", existingIds: string[]): string {
  const existing = new Set(existingIds);

  while (true) {
    const id = `${prefix}_${uuidv7()}`;
    if (!existing.has(id)) {
      return id;
    }
  }
}

function validateDispatchReadiness(value: unknown, source: string): ChunkDispatchReadiness {
  const record = expectRecord(value, "dispatch", source);
  const status = expectString(record.status, "status", source);
  if (!DISPATCH_READINESS_STATUSES.includes(status as ChunkDispatchReadiness["status"])) {
    throw new CliError(
      2,
      "invalid_task_yaml",
      `${source}: status must be one of ${DISPATCH_READINESS_STATUSES.join(", ")}`
    );
  }
  const readinessStatus = status as ChunkDispatchReadiness["status"];

  const riskLevel = expectString(record.risk_level, "risk_level", source);
  if (!DISPATCH_RISK_LEVELS.includes(riskLevel as ChunkDispatchReadiness["risk_level"])) {
    throw new CliError(
      2,
      "invalid_task_yaml",
      `${source}: risk_level must be one of ${DISPATCH_RISK_LEVELS.join(", ")}`
    );
  }
  const dispatchRiskLevel = riskLevel as ChunkDispatchReadiness["risk_level"];

  const approvalRequired = expectString(record.approval_required, "approval_required", source);
  if (!DISPATCH_APPROVAL_REQUIREMENTS.includes(approvalRequired as ChunkDispatchReadiness["approval_required"])) {
    throw new CliError(
      2,
      "invalid_task_yaml",
      `${source}: approval_required must be one of ${DISPATCH_APPROVAL_REQUIREMENTS.join(", ")}`
    );
  }
  const dispatchApprovalRequired = approvalRequired as ChunkDispatchReadiness["approval_required"];

  const allowedActions = expectStringArray(record.allowed_actions, "allowed_actions", source);
  const blockedActions = expectStringArray(record.blocked_actions, "blocked_actions", source);

  return {
    ...record,
    status: readinessStatus,
    risk_level: dispatchRiskLevel,
    approval_required: dispatchApprovalRequired,
    allowed_actions: allowedActions,
    blocked_actions: blockedActions
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

function expectNonEmptyString(value: unknown, fieldName: string, source: string): string {
  const text = expectString(value, fieldName, source);
  if (text.trim().length === 0) {
    throw new CliError(2, "invalid_task_yaml", `${source}: ${fieldName} must not be empty`);
  }

  return text;
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

function expectStringArray(value: unknown, fieldName: string, source: string): string[] {
  return expectArray(value, fieldName, source).map((item, index) =>
    expectNonEmptyString(item, `${fieldName}[${index}]`, source)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
