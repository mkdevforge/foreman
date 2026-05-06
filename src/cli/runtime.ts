import { Command, CommanderError } from "commander";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CliError, type ExitCode } from "./errors";
import { formatJsonData, formatJsonError, renderTextError } from "./output";
import { openForemanDatabase } from "../db/client";
import {
  SESSION_SOURCES,
  getLastSession,
  getSessionById,
  listSessions,
  resolveSessionPrefix,
  type SessionChunkLink,
  type SessionDetail,
  type SessionOverview,
  type SessionPrompt,
  type SessionSource,
  type SessionSummary,
  type SessionToolCall,
  type SessionUsage
} from "../db/session-queries";
import { findRepoRoot, getGitUserEmail } from "../store/repo";
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
}

export interface CliResult {
  exitCode: ExitCode;
}

interface GlobalFlags {
  json: boolean;
  argv: string[];
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
