import { Command, CommanderError } from "commander";
import { CliError, type ExitCode } from "./errors";
import { formatJsonError, renderTextError } from "./output";

export type WriteFn = (text: string) => void;

export interface CliIo {
  stdout: WriteFn;
  stderr: WriteFn;
}

export interface CliResult {
  exitCode: ExitCode;
}

interface GlobalFlags {
  help: boolean;
  json: boolean;
  argv: string[];
}

export function runForemanCli(argv: string[], io: CliIo): CliResult {
  const globals = extractGlobalFlags(argv);
  const program = createProgram();

  if (globals.help) {
    io.stdout(program.helpInformation());
    return { exitCode: 0 };
  }

  try {
    program.parse(globals.argv, { from: "user" });

    if (globals.argv.length === 0) {
      io.stdout(program.helpInformation());
      return { exitCode: 0 };
    }

    return { exitCode: 0 };
  } catch (error) {
    const cliError = normalizeError(error, globals.argv);
    writeError(cliError, globals.json, io);
    return { exitCode: cliError.exitCode };
  }
}

function createProgram(): Command {
  return new Command()
    .name("foreman")
    .description("Supervisor-first CLI for managing AI coding agents.")
    .helpOption(false)
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });
}

function extractGlobalFlags(argv: string[]): GlobalFlags {
  const remaining: string[] = [];
  let help = false;
  let json = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    remaining.push(arg);
  }

  return { help, json, argv: remaining };
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
