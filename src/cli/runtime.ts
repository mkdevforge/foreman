import { Command, CommanderError } from "commander";
import type { Database } from "bun:sqlite";
import { readFileSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, type ExitCode } from "./errors";
import { formatJsonData, formatJsonError, renderTextError } from "./output";
import { openForemanDatabase } from "../db/client";
import { linkSessionChunk, unlinkSessionChunk } from "../db/session-writes";
import {
  SESSION_SOURCES,
  getLastSession,
  getSessionById,
  listLinkedSessionsForChunk,
  listLinkedSessionsForTask,
  listSessions,
  resolveSessionPrefix,
  type LinkedSessionDetail,
  type SessionChunkLink,
  type SessionDetail,
  type SessionOverview,
  type SessionPrompt,
  type SessionSource,
  type SessionSummary,
  type SessionToolCall,
  type SessionUsage
} from "../db/session-queries";
import { findRepoRoot, getGitOriginRemote, getGitUserEmail, normalizeGitRemoteUrl } from "../store/repo";
import {
  clearActiveContext,
  getActiveContextStatus,
  writeActiveContext,
  type ActiveContext,
  type ActiveContextStatus
} from "../store/active";
import {
  addChunk,
  addTask,
  appendChunkNote,
  initializeForemanRepo,
  listChunks,
  listTasks,
  readTask,
  updateChunkStage,
  updateChunkStatus,
  updateTaskStatus
} from "../store/task-store";
import {
  assertValidChunkStage,
  parseChunkRef,
  type ChunkNote,
  type ChunkStage,
  type ForemanChunk,
  type ForemanTask
} from "../store/schema";
import { installForemanHooks, parseInstallTool } from "../hook/install";

export type WriteFn = (text: string) => void;

export interface CliIo {
  stdout: WriteFn;
  stderr: WriteFn;
  readLine?: () => string | null;
}

export interface CliResult {
  exitCode: ExitCode;
}

interface GlobalFlags {
  json: boolean;
  argv: string[];
}

interface ChunkReview {
  kind: "chunk";
  task: ForemanTask;
  chunk: ForemanChunk;
  linkedSessions: LinkedSessionDetail[];
  totalCostUsd: number;
}

interface TaskReview {
  kind: "task";
  task: ForemanTask;
  linkedSessions: LinkedSessionDetail[];
  chunkRollups: ChunkReviewRollup[];
  totalLinkedSessions: number;
  totalCostUsd: number;
}

interface ChunkReviewRollup {
  chunk: ForemanChunk;
  linkedSessionCount: number;
  totalCostUsd: number;
}

interface CatalogOptions {
  all?: boolean;
  since?: string;
  link?: string;
  unlink?: string;
  stage?: string;
}

interface CatalogScope {
  all: boolean;
  repoRoot: string;
  repoRemote: string | null;
  normalizedRepoRemote: string | null;
  pathOnly: boolean;
}

interface CatalogListing {
  scope: CatalogScope;
  startedAtSince: string | null;
  candidates: SessionOverview[];
}

interface CatalogOneShotResult {
  action: "link" | "unlink";
  sessionId: string;
  taskId: string;
  chunkId: string;
  stage: string | null;
  linkedBy: "catalog" | null;
  changed: boolean;
}

type CostGroupBy = "project" | "task" | "chunk" | "model" | "source" | "day";

interface SessionCostReport {
  by: CostGroupBy;
  since: string | null;
  groups: SessionCostGroup[];
  overall: {
    sessionCount: number;
    totalCostUsd: number;
  };
}

interface SessionCostGroup {
  source?: SessionSource;
  projectPath?: string;
  taskId?: string | null;
  chunkId?: string | null;
  model?: string | null;
  day?: string;
  sessionCount: number;
  totalCostUsd: number;
}

export function runForemanCli(argv: string[], io: CliIo): CliResult {
  const globals = extractGlobalFlags(argv);
  const program = createProgram(globals.json, io);

  try {
    program.parse(globals.argv, { from: "user" });

    if (globals.argv.length === 0) {
      io.stdout(program.helpInformation());
      return { exitCode: 0 };
    }

    return { exitCode: 0 };
  } catch (error) {
    if (isCommanderHelp(error)) {
      return { exitCode: 0 };
    }

    const cliError = normalizeError(error, globals.argv);
    writeError(cliError, globals.json, io);
    return { exitCode: cliError.exitCode };
  }
}

function createProgram(json: boolean, io: CliIo): Command {
  const program = configureCommand(
    new Command()
      .name("foreman")
      .description("Supervisor-first CLI for managing AI coding agents.")
      .helpOption("-h, --help", "display help for command"),
    io
  );

  program
    .command("init")
    .description("Initialize Foreman metadata in the current Git repository.")
    .action(() => {
      const repoRoot = findRepoRoot();
      const paths = initializeForemanRepo(repoRoot);

      writeData(json, io, `Initialized Foreman in ${paths.foremanDir}\n`, {
        repo_root: repoRoot,
        foreman_dir: paths.foremanDir,
        tasks_dir: paths.tasksDir
      });
    });

  program
    .command("install")
    .description("Install Foreman Stop hooks for supported agent tools.")
    .addHelpText(
      "after",
      [
        "",
        "Config files:",
        "  Claude Code: ~/.claude/settings.json",
        "  Codex:      ~/.codex/hooks.json and ~/.codex/config.toml",
        "",
        "Codex install writes the Stop hook to hooks.json and enables",
        "[features] codex_hooks = true in config.toml when needed."
      ].join("\n")
    )
    .option("--tool <tool>", "claude-code, codex, or all")
    .action((options: { tool?: string }) => {
      const result = installForemanHooks({ tool: parseInstallTool(options.tool) });

      writeData(json, io, renderInstallResult(result.installed_tools), { ...result });
    });

  program
    .command("work")
    .description("Set the active Foreman task/chunk context for Stop hook linkage.")
    .argument("<task>/<chunk>")
    .option("--stage <stage>")
    .option("--project <path>")
    .action((ref: string, options: { stage?: string; project?: string }) => {
      const active = createActiveContext(ref, options);
      writeActiveContext(active);

      writeData(json, io, renderWorkResult(active), { active });
    });

  program
    .command("stop")
    .description("Clear the active Foreman task/chunk context.")
    .action(() => {
      const cleared = clearActiveContext();

      writeData(json, io, "Cleared active Foreman work context.\n", { active: null, cleared });
    });

  program
    .command("status")
    .description("Show the active Foreman task/chunk context.")
    .action(() => {
      const status = getActiveContextStatus();

      writeData(json, io, renderActiveStatus(status), toJsonActiveStatus(status));
    });

  program.addCommand(createReviewCommand(json, io));
  program.addCommand(createCatalogCommand(json, io));
  program.addCommand(createTaskCommand(json, io));
  program.addCommand(createChunkCommand(json, io));
  program.addCommand(createSessionCommand(json, io));

  return program;
}

function createTaskCommand(json: boolean, io: CliIo): Command {
  const task = configureCommand(new Command("task"), io)
    .description("Manage repo-scoped tasks.")
    .action(() => {
      throw new CliError(2, "missing_command", "missing task command");
    });

  configureCommand(task.command("add"), io)
    .description("Create a task YAML file.")
    .argument("<id>")
    .requiredOption("--title <title>")
    .option("--source-ref <sourceRef>")
    .option("--description <description>")
    .action((id: string, options: { title: string; sourceRef?: string; description?: string }) => {
      const repoRoot = findRepoRoot();
      const newTask = addTask(repoRoot, {
        id,
        title: options.title,
        sourceRef: options.sourceRef,
        description: options.description
      });

      writeData(json, io, `Added task ${newTask.id}\n`, { task: toJsonTask(newTask) });
    });

  configureCommand(task.command("list"), io)
    .description("List task YAML files.")
    .option("--status <status>")
    .action((options: { status?: string }) => {
      const repoRoot = findRepoRoot();
      const tasks = listTasks(repoRoot, options.status);

      writeData(json, io, renderTaskList(tasks), { tasks: tasks.map(toJsonTask) });
    });

  configureCommand(task.command("show"), io)
    .description("Show a task YAML file.")
    .argument("<id>")
    .action((id: string) => {
      const repoRoot = findRepoRoot();
      const taskRecord = readTask(repoRoot, id);

      writeData(json, io, renderTaskShow(taskRecord), { task: toJsonTask(taskRecord) });
    });

  configureCommand(task.command("status"), io)
    .description("Update task status.")
    .argument("<id>")
    .argument("<status>")
    .action((id: string, status: string) => {
      const repoRoot = findRepoRoot();
      const taskRecord = updateTaskStatus(repoRoot, id, status);

      writeData(json, io, `Updated task ${taskRecord.id} status to ${taskRecord.status}\n`, {
        task: toJsonTask(taskRecord)
      });
    });

  return task;
}

function createChunkCommand(json: boolean, io: CliIo): Command {
  const chunk = configureCommand(new Command("chunk"), io)
    .description("Manage task chunks.")
    .action(() => {
      throw new CliError(2, "missing_command", "missing chunk command");
    });

  configureCommand(chunk.command("add"), io)
    .description("Create a chunk under a task.")
    .argument("<task>/<chunk>")
    .requiredOption("--title <title>")
    .option("--spec-file <path>")
    .action((ref: string, options: { title: string; specFile?: string }) => {
      const repoRoot = findRepoRoot();
      const { taskId, chunkId } = parseChunkRef(ref);
      const newChunk = addChunk(repoRoot, {
        taskId,
        chunkId,
        title: options.title,
        spec: readSpecFile(options.specFile)
      });

      writeData(json, io, `Added chunk ${taskId}/${newChunk.id}\n`, { task_id: taskId, chunk: toJsonChunk(newChunk) });
    });

  configureCommand(chunk.command("list"), io)
    .description("List chunks for a task.")
    .argument("<task>")
    .action((taskId: string) => {
      const repoRoot = findRepoRoot();
      const chunks = listChunks(repoRoot, taskId);

      writeData(json, io, renderChunkList(chunks), { task_id: taskId, chunks: chunks.map(toJsonChunk) });
    });

  configureCommand(chunk.command("status"), io)
    .description("Update chunk status.")
    .argument("<task>/<chunk>")
    .argument("<status>")
    .action((ref: string, status: string) => {
      const repoRoot = findRepoRoot();
      const chunkRef = parseChunkRef(ref);
      const updatedChunk = updateChunkStatus(repoRoot, chunkRef, status);

      writeData(json, io, `Updated chunk ${ref} status to ${updatedChunk.status}\n`, {
        task_id: chunkRef.taskId,
        chunk: toJsonChunk(updatedChunk)
      });
    });

  configureCommand(chunk.command("stage"), io)
    .description("Update chunk stage.")
    .argument("<task>/<chunk>")
    .argument("<stage>")
    .action((ref: string, stage: string) => {
      const repoRoot = findRepoRoot();
      const chunkRef = parseChunkRef(ref);
      const updatedChunk = updateChunkStage(repoRoot, chunkRef, stage);

      writeData(json, io, `Updated chunk ${ref} stage to ${updatedChunk.stage}\n`, {
        task_id: chunkRef.taskId,
        chunk: toJsonChunk(updatedChunk)
      });
    });

  configureCommand(chunk.command("note"), io)
    .description("Append a review note to a chunk.")
    .argument("<task>/<chunk>")
    .argument("<body>")
    .option("--author <email>")
    .action((ref: string, body: string, options: { author?: string }) => {
      const repoRoot = findRepoRoot();
      const chunkRef = parseChunkRef(ref);
      const updatedChunk = appendChunkNote(repoRoot, {
        ...chunkRef,
        author: resolveNoteAuthor(repoRoot, options.author),
        body
      });
      const note = updatedChunk.notes.at(-1);

      writeData(json, io, `Added note to chunk ${ref}\n`, {
        task_id: chunkRef.taskId,
        chunk: toJsonChunk(updatedChunk),
        note: note === undefined ? null : toJsonNote(note)
      });
    });

  return chunk;
}

function createReviewCommand(json: boolean, io: CliIo): Command {
  return configureCommand(new Command("review"), io)
    .description("Review task or chunk metadata with linked session data.")
    .argument("<task-or-chunk>")
    .option("--full", "include prompt and tool-call details for chunk-linked sessions")
    .action((ref: string, options: { full?: boolean }) => {
      if (ref.includes("/")) {
        const review = buildChunkReview(ref, options.full === true);

        writeData(json, io, renderChunkReview(review), { review: toJsonChunkReview(review) });
        return;
      }

      const review = buildTaskReview(ref);
      writeData(json, io, renderTaskReview(review), { review: toJsonTaskReview(review) });
    });
}

function createCatalogCommand(json: boolean, io: CliIo): Command {
  return configureCommand(new Command("catalog"), io)
    .description("List unattached sessions and link or unlink them to chunks.")
    .argument("[task>/<chunk>")
    .option("--all", "include sessions from every project")
    .option("--since <duration>")
    .option("--link <session-prefix>")
    .option("--unlink <session-prefix>")
    .option("--stage <stage>")
    .action((ref: string | undefined, options: CatalogOptions) => {
      if (options.link !== undefined || options.unlink !== undefined) {
        const result = runCatalogOneShot(ref, options);
        writeData(json, io, renderCatalogOneShotResult(result), { catalog: toJsonCatalogOneShotResult(result) });
        return;
      }

      if (ref !== undefined) {
        throw new CliError(2, "invalid_catalog_command", "catalog task/chunk argument is only valid with --link or --unlink");
      }

      if (options.stage !== undefined) {
        throw new CliError(2, "invalid_catalog_command", "--stage is only valid with --link");
      }

      const listing = buildCatalogListing(options);
      if (json) {
        writeData(true, io, "", { catalog: toJsonCatalogListing(listing) });
        return;
      }

      runInteractiveCatalog(listing, io);
    });
}

function createSessionCommand(json: boolean, io: CliIo): Command {
  const session = configureCommand(new Command("session"), io)
    .description("Query recorded agent sessions.")
    .action(() => {
      throw new CliError(2, "missing_command", "missing session command");
    });

  configureCommand(session.command("list"), io)
    .description("List recorded sessions.")
    .option("--since <duration>")
    .option("--project <path>")
    .option("--source <source>")
    .option("--unattached")
    .action((options: { since?: string; project?: string; source?: string; unattached?: boolean }) => {
      const startedAtSince = parseSinceOption(options.since);
      const source = parseSessionSourceOption(options.source);
      const sessions = withForemanDatabase((db) =>
        listSessions(db, {
          startedAtSince,
          projectPath: options.project,
          source,
          unattached: options.unattached === true
        })
      );

      writeData(json, io, renderSessionList(sessions), { sessions: sessions.map(toJsonSessionOverview) });
    });

  configureCommand(session.command("cost"), io)
    .description("Report estimated session costs.")
    .option("--since <duration>")
    .option("--by <dimension>", "project, task, chunk, model, source, or day")
    .action((options: { since?: string; by?: string }) => {
      const report = buildSessionCostReport({
        since: parseSinceOption(options.since),
        by: parseCostGroupBy(options.by)
      });

      writeData(json, io, renderSessionCostReport(report), { cost: toJsonSessionCostReport(report) });
    });

  configureCommand(session.command("show"), io)
    .description("Show a recorded session.")
    .argument("<prefix>")
    .option("--full")
    .action((prefix: string, options: { full?: boolean }) => {
      const full = options.full === true;
      const detail = withForemanDatabase((db) => {
        const resolved = resolveSessionPrefix(db, prefix);

        if (resolved.kind === "missing") {
          throw new CliError(1, "session_not_found", `session '${prefix}' was not found`);
        }

        if (resolved.kind === "ambiguous") {
          throw new CliError(
            1,
            "ambiguous_session_prefix",
            `session prefix '${prefix}' is ambiguous; candidates: ${resolved.candidates.join(", ")}`
          );
        }

        return getSessionById(db, resolved.id, full);
      });

      if (detail === null) {
        throw new CliError(1, "session_not_found", `session '${prefix}' was not found`);
      }

      writeData(json, io, renderSessionShow(detail), { session: toJsonSessionDetail(detail) });
    });

  configureCommand(session.command("last"), io)
    .description("Show the latest recorded session.")
    .option("--full")
    .action((options: { full?: boolean }) => {
      const detail = withForemanDatabase((db) => getLastSession(db, options.full === true));

      writeData(json, io, detail === null ? "No sessions found.\n" : renderSessionShow(detail), {
        session: detail === null ? null : toJsonSessionDetail(detail)
      });
    });

  return session;
}

function configureCommand(command: Command, io: CliIo): Command {
  return command
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: io.stdout,
      writeErr: () => undefined
    });
}

function extractGlobalFlags(argv: string[]): GlobalFlags {
  const remaining: string[] = [];
  let json = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    remaining.push(arg);
  }

  return { json, argv: remaining };
}

function isCommanderHelp(error: unknown): boolean {
  return error instanceof CommanderError && error.exitCode === 0;
}

function normalizeError(error: unknown, argv: string[] = []): CliError {
  if (error instanceof CliError) {
    return error;
  }

  if (error instanceof CommanderError) {
    return new CliError(
      commanderExitCode(error),
      commanderCode(error),
      commanderMessage(error, argv)
    );
  }

  if (error instanceof Error) {
    return new CliError(1, "internal_error", error.message);
  }

  return new CliError(1, "internal_error", "Unknown error.");
}

function commanderExitCode(error: CommanderError): ExitCode {
  if (error.code === "commander.unknownCommand" || error.code === "commander.unknownOption") {
    return 2;
  }

  return error.exitCode === 0 ? 0 : 2;
}

function commanderCode(error: CommanderError): string {
  if (error.code === "commander.excessArguments") {
    return "unknown_command";
  }

  return error.code.replace(/^commander\./, "").replace(/([A-Z])/g, "_$1").toLowerCase();
}

function commanderMessage(error: CommanderError, argv: string[]): string {
  if (error.code === "commander.excessArguments" && argv[0]) {
    return `unknown command '${argv[0]}'`;
  }

  return (error.message || "Invalid command.").replace(/^error: /, "");
}

function writeError(error: CliError, json: boolean, io: CliIo): void {
  const body = json ? formatJsonError(error) : renderTextError(error);
  io.stderr(body);
}

function writeData<T extends Record<string, unknown>>(json: boolean, io: CliIo, text: string, data: T): void {
  io.stdout(json ? formatJsonData(data) : text);
}

function readSpecFile(path: string | undefined): string {
  if (path === undefined) {
    return "";
  }

  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(2, "spec_file_read_failed", `failed to read spec file '${path}': ${message}`);
  }
}

function createActiveContext(ref: string, options: { stage?: string; project?: string }): ActiveContext {
  const controlRepoRoot = findRepoRoot();
  const chunkRef = parseChunkRef(ref);
  const task = readTask(controlRepoRoot, chunkRef.taskId);
  const chunk = task.chunks.find((candidate) => candidate.id === chunkRef.chunkId);
  if (chunk === undefined) {
    throw new CliError(2, "chunk_not_found", `chunk '${ref}' was not found`);
  }

  let stageOverride: ChunkStage | null = null;
  if (options.stage !== undefined) {
    assertValidChunkStage(options.stage);
    stageOverride = options.stage;
  }

  return {
    schema_version: 1,
    task_id: chunkRef.taskId,
    chunk_id: chunkRef.chunkId,
    stage: stageOverride ?? chunk.stage,
    stage_override: stageOverride,
    control_repo_root: controlRepoRoot,
    project_path: resolveProjectRoot(controlRepoRoot, options.project),
    created_at: new Date().toISOString()
  };
}

function resolveProjectRoot(controlRepoRoot: string, projectPath: string | undefined): string {
  if (projectPath === undefined) {
    return controlRepoRoot;
  }

  return findRepoRoot(resolve(controlRepoRoot, projectPath));
}

function renderInstallResult(tools: string[]): string {
  return `Installed Foreman hooks for ${tools.join(", ")}.\n`;
}

function renderWorkResult(active: ActiveContext): string {
  return [
    `Set active Foreman work context to ${active.task_id}/${active.chunk_id}.`,
    `Stage: ${active.stage}`,
    `Control repo: ${active.control_repo_root}`,
    `Project path: ${active.project_path}`,
    ""
  ].join("\n");
}

function renderActiveStatus(status: ActiveContextStatus): string {
  if (status.read.kind === "missing") {
    return "No active Foreman work context.\n";
  }

  if (status.read.kind === "invalid") {
    return [
      "Active Foreman work context is invalid.",
      `Path: ${status.read.path}`,
      `Error: ${status.read.error}`,
      ""
    ].join("\n");
  }

  const active = status.read.context;
  return [
    "Active Foreman work context",
    `Task: ${active.task_id}`,
    `Chunk: ${active.chunk_id}`,
    `Stage: ${active.stage}`,
    `Stage override: ${active.stage_override ?? "null"}`,
    `Control repo: ${active.control_repo_root}`,
    `Project path: ${active.project_path}`,
    `Created: ${active.created_at}`,
    `Stale: ${status.stale ? "yes" : "no"} (${status.staleAfterHours}h)`,
    ""
  ].join("\n");
}

function toJsonActiveStatus(status: ActiveContextStatus) {
  return {
    active: status.read.kind === "valid" ? status.read.context : null,
    stale: status.stale,
    stale_after_hours: status.staleAfterHours,
    invalid:
      status.read.kind === "invalid"
        ? {
            path: status.read.path,
            error: status.read.error
          }
        : null
  };
}

function withForemanDatabase<T>(read: (db: Database) => T): T {
  const db = openForemanDatabase();

  try {
    return read(db);
  } finally {
    db.close();
  }
}

function parseSinceOption(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = /^([1-9]\d*)([mhdw])$/.exec(value);
  if (match === null) {
    throw new CliError(2, "invalid_since", "invalid --since value; expected compact duration like 30m, 24h, 7d, or 2w");
  }

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) {
    throw new CliError(2, "invalid_since", "invalid --since value; duration is too large");
  }

  const unit = match[2] as "m" | "h" | "d" | "w";
  const unitMs = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  }[unit];

  const durationMs = amount * unitMs;
  const sinceMs = Date.now() - durationMs;
  const since = new Date(sinceMs);

  if (!Number.isSafeInteger(durationMs) || !Number.isFinite(sinceMs) || Number.isNaN(since.getTime())) {
    throw new CliError(2, "invalid_since", "invalid --since value; duration is too large");
  }

  return since.toISOString();
}

function parseSessionSourceOption(value: string | undefined): SessionSource | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!SESSION_SOURCES.includes(value as SessionSource)) {
    throw new CliError(2, "invalid_source", `invalid source '${value}'; expected one of ${SESSION_SOURCES.join(", ")}`);
  }

  return value as SessionSource;
}

function parseCostGroupBy(value: string | undefined): CostGroupBy {
  const allowed = ["project", "task", "chunk", "model", "source", "day"] as const;
  if (value === undefined) {
    return "source";
  }

  if (!allowed.includes(value as CostGroupBy)) {
    throw new CliError(2, "invalid_cost_group", `invalid --by value '${value}'; expected one of ${allowed.join(", ")}`);
  }

  return value as CostGroupBy;
}

function buildChunkReview(ref: string, full: boolean): ChunkReview {
  const repoRoot = findRepoRoot();
  const chunkRef = parseChunkRef(ref);
  const task = readTask(repoRoot, chunkRef.taskId);
  const chunk = findTaskChunk(task, chunkRef.chunkId);
  const linkedSessions = withForemanDatabase((db) =>
    listLinkedSessionsForChunk(db, chunkRef.taskId, chunkRef.chunkId, full)
  );

  return {
    kind: "chunk",
    task,
    chunk,
    linkedSessions,
    totalCostUsd: totalDistinctLinkedSessionCost(linkedSessions)
  };
}

function buildTaskReview(taskId: string): TaskReview {
  const repoRoot = findRepoRoot();
  const task = readTask(repoRoot, taskId);
  const linkedSessions = withForemanDatabase((db) => listLinkedSessionsForTask(db, task.id));
  const chunkRollups = task.chunks.map((chunk) => {
    const chunkLinks = linkedSessions.filter((entry) => entry.link.chunk_id === chunk.id);

    return {
      chunk,
      linkedSessionCount: countDistinctSessions(chunkLinks),
      totalCostUsd: totalDistinctLinkedSessionCost(chunkLinks)
    };
  });

  return {
    kind: "task",
    task,
    linkedSessions,
    chunkRollups,
    totalLinkedSessions: countDistinctSessions(linkedSessions),
    totalCostUsd: totalDistinctLinkedSessionCost(linkedSessions)
  };
}

function runCatalogOneShot(ref: string | undefined, options: CatalogOptions): CatalogOneShotResult {
  if (options.link !== undefined && options.unlink !== undefined) {
    throw new CliError(2, "invalid_catalog_command", "use only one of --link or --unlink");
  }

  if (ref === undefined) {
    throw new CliError(2, "missing_chunk_ref", "catalog --link and --unlink require <task>/<chunk>");
  }

  if (options.link !== undefined) {
    return linkCatalogSession(options.link, ref, options.stage);
  }

  if (options.unlink !== undefined) {
    if (options.stage !== undefined) {
      throw new CliError(2, "invalid_catalog_command", "--stage is only valid with --link");
    }

    return unlinkCatalogSession(options.unlink, ref);
  }

  throw new CliError(2, "invalid_catalog_command", "expected --link or --unlink");
}

function linkCatalogSession(prefix: string, ref: string, stageOverride: string | undefined): CatalogOneShotResult {
  const repoRoot = findRepoRoot();
  const chunkRef = parseChunkRef(ref);
  const task = readTask(repoRoot, chunkRef.taskId);
  const chunk = findTaskChunk(task, chunkRef.chunkId);
  let stage = chunk.stage;

  if (stageOverride !== undefined) {
    assertValidChunkStage(stageOverride);
    stage = stageOverride;
  }

  const changed = withForemanDatabase((db) => {
    const sessionId = resolveSessionIdOrThrow(db, prefix);
    const changes = linkSessionChunk(db, {
      sessionId,
      taskId: chunkRef.taskId,
      chunkId: chunkRef.chunkId,
      stage,
      linkedAt: new Date().toISOString(),
      linkedBy: "catalog"
    });

    return { sessionId, changes };
  });

  return {
    action: "link",
    sessionId: changed.sessionId,
    taskId: chunkRef.taskId,
    chunkId: chunkRef.chunkId,
    stage,
    linkedBy: "catalog",
    changed: changed.changes > 0
  };
}

function unlinkCatalogSession(prefix: string, ref: string): CatalogOneShotResult {
  const repoRoot = findRepoRoot();
  const chunkRef = parseChunkRef(ref);
  const task = readTask(repoRoot, chunkRef.taskId);
  findTaskChunk(task, chunkRef.chunkId);

  const changed = withForemanDatabase((db) => {
    const sessionId = resolveSessionIdOrThrow(db, prefix);
    const changes = unlinkSessionChunk(db, {
      sessionId,
      taskId: chunkRef.taskId,
      chunkId: chunkRef.chunkId
    });

    return { sessionId, changes };
  });

  return {
    action: "unlink",
    sessionId: changed.sessionId,
    taskId: chunkRef.taskId,
    chunkId: chunkRef.chunkId,
    stage: null,
    linkedBy: null,
    changed: changed.changes > 0
  };
}

function buildCatalogListing(options: CatalogOptions): CatalogListing {
  const startedAtSince = parseSinceOption(options.since) ?? null;
  const scope = resolveCatalogScope(options.all === true);
  const candidates = withForemanDatabase((db) =>
    listSessions(db, {
      startedAtSince: startedAtSince ?? undefined,
      unattached: true
    })
  ).filter((session) => catalogScopeIncludesSession(scope, session));

  return { scope, startedAtSince, candidates };
}

function resolveCatalogScope(all: boolean): CatalogScope {
  const repoRoot = findRepoRoot();
  const repoRemote = getGitOriginRemote(repoRoot);

  return {
    all,
    repoRoot,
    repoRemote,
    normalizedRepoRemote: repoRemote === null ? null : normalizeGitRemoteUrl(repoRemote),
    pathOnly: !all && repoRemote === null
  };
}

function catalogScopeIncludesSession(scope: CatalogScope, session: SessionOverview): boolean {
  if (scope.all) {
    return true;
  }

  if (scope.normalizedRepoRemote !== null) {
    return (
      session.repo_remote !== null &&
      normalizeGitRemoteUrl(session.repo_remote) === scope.normalizedRepoRemote
    );
  }

  return session.project_path === scope.repoRoot;
}

function runInteractiveCatalog(listing: CatalogListing, io: CliIo): void {
  io.stdout(renderCatalogListing(listing));
  if (listing.candidates.length === 0) {
    return;
  }

  for (const candidate of listing.candidates) {
    io.stdout(`Catalog candidate ${candidate.id}\n`);

    while (true) {
      io.stdout("Link to <task>/<chunk>, skip, or quit: ");
      const line = readCatalogLine(io);
      if (line === null) {
        io.stdout("\n");
        return;
      }

      const answer = line.trim();
      if (answer.length === 0) {
        io.stdout("Enter a chunk ref, skip, or quit.\n");
        continue;
      }

      if (answer.toLowerCase() === "skip") {
        io.stdout(`Skipped ${candidate.id}.\n`);
        break;
      }

      if (answer.toLowerCase() === "quit") {
        io.stdout("Stopped catalog.\n");
        return;
      }

      try {
        const result = linkCatalogSession(candidate.id, answer, undefined);
        io.stdout(renderCatalogOneShotResult(result));
        break;
      } catch (error) {
        if (error instanceof CliError) {
          io.stdout(`Invalid selection: ${error.message}\n`);
          continue;
        }

        throw error;
      }
    }
  }
}

function readCatalogLine(io: CliIo): string | null {
  return io.readLine?.() ?? readLineFromStdin();
}

function readLineFromStdin(): string | null {
  const buffer = Buffer.alloc(1);
  let line = "";

  while (true) {
    const bytesRead = readSync(0, buffer, 0, 1, null);
    if (bytesRead === 0) {
      return line.length === 0 ? null : line;
    }

    const char = buffer.toString("utf8", 0, bytesRead);
    if (char === "\n") {
      return line;
    }

    if (char !== "\r") {
      line += char;
    }
  }
}

function buildSessionCostReport(input: { since: string | undefined; by: CostGroupBy }): SessionCostReport {
  const sessions = withForemanDatabase((db) => listSessions(db, { startedAtSince: input.since }));
  const groups = new Map<string, { group: Omit<SessionCostGroup, "sessionCount" | "totalCostUsd">; sessionIds: Set<string>; totalCostUsd: number }>();

  for (const session of sessions) {
    for (const group of costGroupsForSession(session, input.by)) {
      const key = costGroupKey(input.by, group);
      const accumulator =
        groups.get(key) ??
        {
          group,
          sessionIds: new Set<string>(),
          totalCostUsd: 0
        };

      if (!accumulator.sessionIds.has(session.id)) {
        accumulator.sessionIds.add(session.id);
        accumulator.totalCostUsd += sessionCostUsd(session);
      }

      groups.set(key, accumulator);
    }
  }

  const costGroups = [...groups.values()]
    .map((entry) => ({
      ...entry.group,
      sessionCount: entry.sessionIds.size,
      totalCostUsd: roundCost(entry.totalCostUsd)
    }))
    .sort((left, right) => costGroupSortKey(input.by, left).localeCompare(costGroupSortKey(input.by, right)));

  return {
    by: input.by,
    since: input.since ?? null,
    groups: costGroups,
    overall: {
      sessionCount: sessions.length,
      totalCostUsd: roundCost(sessions.reduce((total, session) => total + sessionCostUsd(session), 0))
    }
  };
}

function costGroupsForSession(
  session: SessionOverview,
  by: CostGroupBy
): Omit<SessionCostGroup, "sessionCount" | "totalCostUsd">[] {
  if (by === "source") {
    return [{ source: session.source }];
  }

  if (by === "project") {
    return [{ projectPath: session.project_path }];
  }

  if (by === "model") {
    return [{ model: session.model }];
  }

  if (by === "day") {
    return [{ day: session.started_at.slice(0, 10) }];
  }

  if (session.linked_chunks.length === 0) {
    return by === "task" ? [{ taskId: null }] : [{ taskId: null, chunkId: null }];
  }

  if (by === "task") {
    return [...new Set(session.linked_chunks.map((link) => link.task_id))].map((taskId) => ({ taskId }));
  }

  const chunkKeys = new Map<string, { taskId: string; chunkId: string }>();
  for (const link of session.linked_chunks) {
    chunkKeys.set(`${link.task_id}/${link.chunk_id}`, { taskId: link.task_id, chunkId: link.chunk_id });
  }

  return [...chunkKeys.values()];
}

function costGroupKey(by: CostGroupBy, group: Omit<SessionCostGroup, "sessionCount" | "totalCostUsd">): string {
  return `${by}:${JSON.stringify(group)}`;
}

function costGroupSortKey(by: CostGroupBy, group: SessionCostGroup): string {
  if (by === "source") {
    return group.source ?? "";
  }

  if (by === "project") {
    return group.projectPath ?? "";
  }

  if (by === "model") {
    return group.model ?? "";
  }

  if (by === "day") {
    return group.day ?? "";
  }

  if (by === "task") {
    return group.taskId ?? "";
  }

  return `${group.taskId ?? ""}/${group.chunkId ?? ""}`;
}

function resolveSessionIdOrThrow(db: Database, prefix: string): string {
  const resolved = resolveSessionPrefix(db, prefix);

  if (resolved.kind === "missing") {
    throw new CliError(1, "session_not_found", `session '${prefix}' was not found`);
  }

  if (resolved.kind === "ambiguous") {
    throw new CliError(
      1,
      "ambiguous_session_prefix",
      `session prefix '${prefix}' is ambiguous; candidates: ${resolved.candidates.join(", ")}`
    );
  }

  return resolved.id;
}

function findTaskChunk(task: ForemanTask, chunkId: string): ForemanChunk {
  const chunk = task.chunks.find((candidate) => candidate.id === chunkId);

  if (chunk === undefined) {
    throw new CliError(2, "chunk_not_found", `chunk '${task.id}/${chunkId}' was not found`);
  }

  return chunk;
}

function countDistinctSessions(entries: LinkedSessionDetail[]): number {
  return new Set(entries.map((entry) => entry.session.id)).size;
}

function totalDistinctLinkedSessionCost(entries: LinkedSessionDetail[]): number {
  const seen = new Set<string>();
  let total = 0;

  for (const entry of entries) {
    if (seen.has(entry.session.id)) {
      continue;
    }

    seen.add(entry.session.id);
    total += sessionCostUsd(entry.session);
  }

  return roundCost(total);
}

function sessionCostUsd(session: SessionOverview): number {
  return session.usage?.cost_usd ?? 0;
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function toJsonChunkReview(review: ChunkReview) {
  return {
    type: review.kind,
    task: toJsonTask(review.task),
    chunk: toJsonChunk(review.chunk),
    linked_sessions_by_stage: groupLinkedSessionsByStage(review.linkedSessions).map((group) => ({
      stage: group.stage,
      total_cost_usd: totalDistinctLinkedSessionCost(group.entries),
      sessions: group.entries.map(toJsonLinkedSession)
    })),
    total_cost_usd: review.totalCostUsd
  };
}

function toJsonTaskReview(review: TaskReview) {
  return {
    type: review.kind,
    task: toJsonTask(review.task),
    chunk_rollups: review.chunkRollups.map((rollup) => ({
      chunk: toJsonChunk(rollup.chunk),
      linked_session_count: rollup.linkedSessionCount,
      total_cost_usd: rollup.totalCostUsd
    })),
    linked_sessions: review.linkedSessions.map(toJsonLinkedSession),
    total_linked_sessions: review.totalLinkedSessions,
    total_cost_usd: review.totalCostUsd
  };
}

function toJsonLinkedSession(entry: LinkedSessionDetail) {
  return {
    link: toJsonSessionChunkLink(entry.link),
    session: toJsonSessionDetail(entry.session)
  };
}

function toJsonCatalogListing(listing: CatalogListing) {
  return {
    scope: toJsonCatalogScope(listing.scope),
    started_at_since: listing.startedAtSince,
    candidates: listing.candidates.map(toJsonSessionOverview)
  };
}

function toJsonCatalogOneShotResult(result: CatalogOneShotResult) {
  return {
    action: result.action,
    session_id: result.sessionId,
    task_id: result.taskId,
    chunk_id: result.chunkId,
    stage: result.stage,
    linked_by: result.linkedBy,
    changed: result.changed
  };
}

function toJsonCatalogScope(scope: CatalogScope) {
  return {
    all: scope.all,
    repo_root: scope.repoRoot,
    repo_remote: scope.repoRemote,
    normalized_repo_remote: scope.normalizedRepoRemote,
    path_only: scope.pathOnly
  };
}

function toJsonSessionCostReport(report: SessionCostReport) {
  return {
    by: report.by,
    since: report.since,
    overall: {
      session_count: report.overall.sessionCount,
      total_cost_usd: report.overall.totalCostUsd
    },
    groups: report.groups.map((group) => toJsonSessionCostGroup(report.by, group))
  };
}

function toJsonSessionCostGroup(by: CostGroupBy, group: SessionCostGroup) {
  const base = {
    session_count: group.sessionCount,
    total_cost_usd: group.totalCostUsd
  };

  if (by === "source") {
    return { source: group.source ?? null, ...base };
  }

  if (by === "project") {
    return { project_path: group.projectPath ?? null, ...base };
  }

  if (by === "model") {
    return { model: group.model ?? null, ...base };
  }

  if (by === "day") {
    return { day: group.day ?? null, ...base };
  }

  if (by === "task") {
    return { task_id: group.taskId ?? null, ...base };
  }

  return { task_id: group.taskId ?? null, chunk_id: group.chunkId ?? null, ...base };
}

function toJsonTask(task: ForemanTask) {
  return {
    schema_version: task.schema_version,
    id: task.id,
    title: task.title,
    source_ref: task.source_ref,
    description: task.description,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    chunks: task.chunks.map(toJsonChunk)
  };
}

function toJsonChunk(chunk: ForemanChunk) {
  return {
    id: chunk.id,
    title: chunk.title,
    spec: chunk.spec,
    status: chunk.status,
    stage: chunk.stage,
    created_at: chunk.created_at,
    updated_at: chunk.updated_at,
    notes: chunk.notes.map(toJsonNote)
  };
}

function toJsonNote(note: ChunkNote) {
  return {
    ts: note.ts,
    author: note.author,
    body: note.body
  };
}

function toJsonSessionOverview(session: SessionOverview) {
  return {
    id: session.id,
    source: session.source,
    source_session_id: session.source_session_id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    project_path: session.project_path,
    repo_remote: session.repo_remote,
    model: session.model,
    machine: session.machine,
    user_email: session.user_email,
    created_at: session.created_at,
    usage: session.usage === null ? null : toJsonSessionUsage(session.usage),
    summary: session.summary === null ? null : toJsonSessionSummary(session.summary),
    linked_chunks: session.linked_chunks.map(toJsonSessionChunkLink)
  };
}

function toJsonSessionDetail(session: SessionDetail) {
  const detail: Record<string, unknown> = toJsonSessionOverview(session);

  if (session.prompts !== undefined) {
    detail.prompts = session.prompts.map(toJsonSessionPrompt);
  }

  if (session.tool_calls !== undefined) {
    detail.tool_calls = session.tool_calls.map(toJsonSessionToolCall);
  }

  return detail;
}

function toJsonSessionUsage(usage: SessionUsage) {
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_creation_tokens: usage.cache_creation_tokens,
    cost_usd: usage.cost_usd
  };
}

function toJsonSessionSummary(summary: SessionSummary) {
  return {
    summary_md: summary.summary_md,
    model_used: summary.model_used,
    generated_at: summary.generated_at
  };
}

function toJsonSessionChunkLink(link: SessionChunkLink) {
  return {
    task_id: link.task_id,
    chunk_id: link.chunk_id,
    stage: link.stage,
    linked_at: link.linked_at,
    linked_by: link.linked_by
  };
}

function toJsonSessionPrompt(prompt: SessionPrompt) {
  return {
    id: prompt.id,
    ts: prompt.ts,
    content: prompt.content,
    content_hash: prompt.content_hash
  };
}

function toJsonSessionToolCall(toolCall: SessionToolCall) {
  return {
    id: toolCall.id,
    ts: toolCall.ts,
    tool_name: toolCall.tool_name,
    params_json: toolCall.params_json,
    result_json: toolCall.result_json,
    is_error: toolCall.is_error,
    params_hash: toolCall.params_hash
  };
}

function resolveNoteAuthor(repoRoot: string, explicitAuthor: string | undefined): string {
  if (explicitAuthor !== undefined) {
    const author = explicitAuthor.trim();

    if (author.length === 0) {
      throw new CliError(2, "invalid_input", "author must not be empty");
    }

    return author;
  }

  const gitAuthor = getGitUserEmail(repoRoot);
  if (gitAuthor === null) {
    throw new CliError(
      2,
      "author_not_found",
      "note author was not provided and git config user.email is not set; use --author <email>"
    );
  }

  return gitAuthor;
}

function renderTaskList(tasks: ForemanTask[]): string {
  if (tasks.length === 0) {
    return "No tasks found.\n";
  }

  return `${tasks.map((task) => `${task.id}  ${task.status}  ${task.title}`).join("\n")}\n`;
}

function renderTaskShow(task: ForemanTask): string {
  const lines = [
    `Task ${task.id}`,
    `Title: ${task.title}`,
    `Status: ${task.status}`,
    `Source: ${task.source_ref ?? "null"}`,
    "Description:",
    ...renderIndentedBlock(task.description),
    `Created: ${task.created_at}`,
    `Updated: ${task.updated_at}`,
    "Chunks:"
  ];

  if (task.chunks.length === 0) {
    lines.push("  none");
  } else {
    lines.push(...task.chunks.map((chunk) => `  ${formatChunkSummary(chunk)}`));
  }

  return `${lines.join("\n")}\n`;
}

function renderChunkList(chunks: ForemanChunk[]): string {
  if (chunks.length === 0) {
    return "No chunks found.\n";
  }

  return `${chunks.map(formatChunkSummary).join("\n")}\n`;
}

function renderSessionList(sessions: SessionOverview[]): string {
  if (sessions.length === 0) {
    return "No sessions found.\n";
  }

  return `${sessions.map(formatSessionListRow).join("\n")}\n`;
}

function renderSessionShow(session: SessionDetail): string {
  const lines = [
    `Session ${session.id}`,
    `Source: ${session.source}`,
    `Source session: ${session.source_session_id}`,
    `Started: ${session.started_at}`,
    `Ended: ${session.ended_at}`,
    `Project: ${session.project_path}`,
    `Repo remote: ${session.repo_remote ?? "null"}`,
    `Model: ${session.model ?? "null"}`,
    `Machine: ${session.machine}`,
    `User: ${session.user_email}`,
    `Created: ${session.created_at}`,
    `Usage: ${formatSessionUsage(session.usage)}`,
    "Summary:",
    ...renderSessionSummary(session.summary),
    "Linked chunks:",
    ...renderSessionChunkLinks(session.linked_chunks)
  ];

  if (session.prompts !== undefined) {
    lines.push("Prompts:", ...renderSessionPrompts(session.prompts));
  }

  if (session.tool_calls !== undefined) {
    lines.push("Tool calls:", ...renderSessionToolCalls(session.tool_calls));
  }

  return `${lines.join("\n")}\n`;
}

function renderChunkReview(review: ChunkReview): string {
  const lines = [
    `Chunk Review ${review.task.id}/${review.chunk.id}`,
    `Task title: ${review.task.title}`,
    `Chunk title: ${review.chunk.title}`,
    `Status: ${review.chunk.status}`,
    `Stage: ${review.chunk.stage}`,
    `Created: ${review.chunk.created_at}`,
    `Updated: ${review.chunk.updated_at}`,
    "Spec:",
    ...renderIndentedBlock(review.chunk.spec),
    "Notes:",
    ...renderChunkNotes(review.chunk.notes),
    "Linked sessions:"
  ];

  if (review.linkedSessions.length === 0) {
    lines.push("  none");
  } else {
    for (const group of groupLinkedSessionsByStage(review.linkedSessions)) {
      lines.push(`  Stage ${group.stage}:`);
      lines.push(...group.entries.flatMap((entry) => renderLinkedSession(entry, "    ")));
    }
  }

  lines.push(`Total linked cost_usd: ${formatCostUsd(review.totalCostUsd)}`);
  return `${lines.join("\n")}\n`;
}

function renderTaskReview(review: TaskReview): string {
  const lines = [
    `Task Review ${review.task.id}`,
    `Title: ${review.task.title}`,
    `Status: ${review.task.status}`,
    `Source: ${review.task.source_ref ?? "null"}`,
    "Description:",
    ...renderIndentedBlock(review.task.description),
    `Created: ${review.task.created_at}`,
    `Updated: ${review.task.updated_at}`,
    "Chunks:"
  ];

  if (review.chunkRollups.length === 0) {
    lines.push("  none");
  } else {
    lines.push(
      ...review.chunkRollups.map(
        (rollup) =>
          `  ${formatChunkSummary(rollup.chunk)}  linked_sessions=${rollup.linkedSessionCount}  cost_usd=${formatCostUsd(rollup.totalCostUsd)}`
      )
    );
  }

  lines.push(
    "Linked sessions:",
    ...renderTaskLinkedSessions(review.linkedSessions),
    `Total linked sessions: ${review.totalLinkedSessions}`,
    `Total linked cost_usd: ${formatCostUsd(review.totalCostUsd)}`
  );

  return `${lines.join("\n")}\n`;
}

function renderCatalogListing(listing: CatalogListing): string {
  const lines = [
    "Catalog candidates",
    `Scope: ${formatCatalogScope(listing.scope)}`,
    `Since: ${listing.startedAtSince ?? "null"}`
  ];

  if (listing.scope.pathOnly) {
    lines.push("No origin remote found; catalog is limited to this worktree path. Use --all to include other projects.");
  }

  if (listing.candidates.length === 0) {
    lines.push("No catalog candidates found.");
  } else {
    for (const candidate of listing.candidates) {
      lines.push(...renderCatalogCandidate(candidate));
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderCatalogOneShotResult(result: CatalogOneShotResult): string {
  if (result.action === "link") {
    return [
      `${result.changed ? "Linked" : "Already linked"} session ${result.sessionId} to ${result.taskId}/${result.chunkId}.`,
      `Stage: ${result.stage}`,
      `Linked by: ${result.linkedBy}`,
      ""
    ].join("\n");
  }

  return `${result.changed ? "Unlinked" : "No existing link for"} session ${result.sessionId} from ${result.taskId}/${result.chunkId}.\n`;
}

function renderSessionCostReport(report: SessionCostReport): string {
  const lines = [
    `Session cost by ${report.by}`,
    `Since: ${report.since ?? "null"}`,
    `Overall: sessions=${report.overall.sessionCount} cost_usd=${formatCostUsd(report.overall.totalCostUsd)}`,
    "Groups:"
  ];

  if (report.groups.length === 0) {
    lines.push("  none");
  } else {
    lines.push(
      ...report.groups.map(
        (group) =>
          `  ${formatCostGroupLabel(report.by, group)}  sessions=${group.sessionCount}  cost_usd=${formatCostUsd(group.totalCostUsd)}`
      )
    );
  }

  return `${lines.join("\n")}\n`;
}

function formatChunkSummary(chunk: ForemanChunk): string {
  return `${chunk.id}  ${chunk.status}  ${chunk.stage}  ${chunk.title}`;
}

function formatSessionListRow(session: SessionOverview): string {
  return [
    session.id,
    session.source,
    session.started_at,
    session.project_path,
    `cost_usd=${formatSessionCost(session.usage)}`,
    `chunks=${formatSessionChunksInline(session.linked_chunks)}`,
    `summary=${firstLine(session.summary?.summary_md ?? "null")}`
  ].join("  ");
}

function formatSessionUsage(usage: SessionUsage | null): string {
  if (usage === null) {
    return "null";
  }

  return [
    `input=${usage.input_tokens}`,
    `output=${usage.output_tokens}`,
    `cache_read=${usage.cache_read_tokens}`,
    `cache_creation=${usage.cache_creation_tokens}`,
    `cost_usd=${formatSessionCost(usage)}`
  ].join(" ");
}

function formatSessionCost(usage: SessionUsage | null): string {
  return usage === null ? "null" : usage.cost_usd.toFixed(4);
}

function renderSessionSummary(summary: SessionSummary | null): string[] {
  if (summary === null) {
    return ["  null"];
  }

  return [
    `  Model: ${summary.model_used}`,
    `  Generated: ${summary.generated_at}`,
    ...renderIndentedBlock(summary.summary_md)
  ];
}

function renderSessionChunkLinks(links: SessionChunkLink[]): string[] {
  if (links.length === 0) {
    return ["  none"];
  }

  return links.map((link) => `  ${formatSessionChunkLink(link)}`);
}

function formatSessionChunkLink(link: SessionChunkLink): string {
  return `${link.task_id}/${link.chunk_id}  ${link.stage}  ${link.linked_by}  ${link.linked_at}`;
}

function formatSessionChunksInline(links: SessionChunkLink[]): string {
  if (links.length === 0) {
    return "none";
  }

  return links.map((link) => `${link.task_id}/${link.chunk_id}`).join(",");
}

function renderSessionPrompts(prompts: SessionPrompt[]): string[] {
  if (prompts.length === 0) {
    return ["  none"];
  }

  return prompts.flatMap((prompt) => [
    `  ${prompt.id}  ${prompt.ts}  ${prompt.content_hash}`,
    ...renderIndentedBlock(prompt.content).map((line) => `  ${line}`)
  ]);
}

function renderSessionToolCalls(toolCalls: SessionToolCall[]): string[] {
  if (toolCalls.length === 0) {
    return ["  none"];
  }

  return toolCalls.flatMap((toolCall) => [
    `  ${toolCall.id}  ${toolCall.ts}  ${toolCall.tool_name}  error=${toolCall.is_error}  ${toolCall.params_hash}`,
    `    params: ${toolCall.params_json}`,
    `    result: ${toolCall.result_json ?? "null"}`
  ]);
}

function groupLinkedSessionsByStage(entries: LinkedSessionDetail[]): { stage: string; entries: LinkedSessionDetail[] }[] {
  const groups = new Map<string, LinkedSessionDetail[]>();

  for (const entry of entries) {
    const group = groups.get(entry.link.stage) ?? [];
    group.push(entry);
    groups.set(entry.link.stage, group);
  }

  return [...groups.entries()].map(([stage, groupEntries]) => ({ stage, entries: groupEntries }));
}

function renderChunkNotes(notes: ChunkNote[]): string[] {
  if (notes.length === 0) {
    return ["  none"];
  }

  return notes.flatMap((note) => [
    `  ${note.ts}  ${note.author}`,
    ...renderIndentedBlock(note.body).map((line) => `  ${line}`)
  ]);
}

function renderLinkedSession(entry: LinkedSessionDetail, prefix: string): string[] {
  const session = entry.session;
  const lines = [
    `${prefix}Session ${session.id}`,
    `${prefix}  Source: ${session.source}`,
    `${prefix}  Started: ${session.started_at}`,
    `${prefix}  Ended: ${session.ended_at}`,
    `${prefix}  Project: ${session.project_path}`,
    `${prefix}  Repo remote: ${session.repo_remote ?? "null"}`,
    `${prefix}  Model: ${session.model ?? "null"}`,
    `${prefix}  Usage: ${formatSessionUsage(session.usage)}`,
    `${prefix}  Link: ${formatSessionChunkLink(entry.link)}`,
    `${prefix}  Summary:`,
    ...renderSessionSummary(session.summary).map((line) => `${prefix}${line}`)
  ];

  if (session.prompts !== undefined) {
    lines.push(`${prefix}  Prompts:`, ...renderSessionPrompts(session.prompts).map((line) => `${prefix}${line}`));
  }

  if (session.tool_calls !== undefined) {
    lines.push(`${prefix}  Tool calls:`, ...renderSessionToolCalls(session.tool_calls).map((line) => `${prefix}${line}`));
  }

  return lines;
}

function renderTaskLinkedSessions(entries: LinkedSessionDetail[]): string[] {
  if (entries.length === 0) {
    return ["  none"];
  }

  return entries.map(
    (entry) =>
      `  ${entry.session.id}  ${entry.link.task_id}/${entry.link.chunk_id}  ${entry.link.stage}  cost_usd=${formatCostUsd(sessionCostUsd(entry.session))}  summary=${firstLine(entry.session.summary?.summary_md ?? "null")}`
  );
}

function renderCatalogCandidate(session: SessionOverview): string[] {
  return [
    `Session ${session.id}`,
    `  Source: ${session.source}`,
    `  Started: ${session.started_at}`,
    `  Ended: ${session.ended_at}`,
    `  Project: ${session.project_path}`,
    `  Repo remote: ${session.repo_remote ?? "null"}`,
    `  Model: ${session.model ?? "null"}`,
    `  Cost_usd: ${formatSessionCost(session.usage)}`,
    "  Summary:",
    ...renderSessionSummary(session.summary).map((line) => `  ${line}`)
  ];
}

function formatCatalogScope(scope: CatalogScope): string {
  if (scope.all) {
    return "all projects";
  }

  if (scope.repoRemote !== null) {
    return `origin ${scope.repoRemote} (${scope.normalizedRepoRemote})`;
  }

  return `project path ${scope.repoRoot}`;
}

function formatCostGroupLabel(by: CostGroupBy, group: SessionCostGroup): string {
  if (by === "source") {
    return `source=${group.source ?? "null"}`;
  }

  if (by === "project") {
    return `project=${group.projectPath ?? "null"}`;
  }

  if (by === "model") {
    return `model=${group.model ?? "null"}`;
  }

  if (by === "day") {
    return `day=${group.day ?? "null"}`;
  }

  if (by === "task") {
    return `task=${group.taskId ?? "null"}`;
  }

  return `chunk=${group.taskId === null || group.chunkId === null ? "null" : `${group.taskId}/${group.chunkId}`}`;
}

function formatCostUsd(value: number): string {
  return value.toFixed(4);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function renderIndentedBlock(value: string | null): string[] {
  if (value === null) {
    return ["  null"];
  }

  if (value.length === 0) {
    return ["  "];
  }

  return value.split(/\r?\n/).map((line) => `  ${line}`);
}
