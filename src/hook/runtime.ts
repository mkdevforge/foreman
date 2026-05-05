import { CliError, type ExitCode } from "../cli/errors";
import { formatJsonError, renderTextError } from "../cli/output";

export type HookName = "foreman-hook-stop-claude-code" | "foreman-hook-stop-codex";
type WriteFn = (text: string) => void;

export interface HookIo {
  stdout: WriteFn;
  stderr: WriteFn;
}

export interface HookResult {
  exitCode: ExitCode;
}

export function runHookStub(name: HookName, argv: string[], io: HookIo): HookResult {
  const globals = extractGlobalFlags(argv);

  if (globals.help) {
    io.stdout(renderHelp(name));
    return { exitCode: 0 };
  }

  const error = new CliError(2, "not_implemented", `${name} is not implemented in Phase 0.`);
  io.stderr(globals.json ? formatJsonError(error) : renderTextError(error));
  return { exitCode: error.exitCode };
}

function extractGlobalFlags(argv: string[]): { help: boolean; json: boolean } {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json")
  };
}

function renderHelp(name: HookName): string {
  return `${name}\n\nStop hook entry point for Foreman.\n\nUsage:\n  ${name} --help\n\nPhase 0 stub: ingestion is not implemented yet.\n`;
}
