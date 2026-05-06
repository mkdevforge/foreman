import { Command, CommanderError } from "commander";
import { readFileSync } from "node:fs";
import { CliError, type ExitCode } from "./errors";
import { formatJsonData, formatJsonError, renderTextError } from "./output";
import { findRepoRoot, getGitUserEmail } from "../store/repo";
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
import { parseChunkRef, type ChunkNote, type ForemanChunk, type ForemanTask } from "../store/schema";

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

  program.addCommand(createTaskCommand(json, io));
  program.addCommand(createChunkCommand(json, io));

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

function formatChunkSummary(chunk: ForemanChunk): string {
  return `${chunk.id}  ${chunk.status}  ${chunk.stage}  ${chunk.title}`;
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
