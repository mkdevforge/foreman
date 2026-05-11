export type ExitCode = 0 | 1 | 2;

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(exitCode: ExitCode, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}
