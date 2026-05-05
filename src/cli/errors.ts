export type ExitCode = 0 | 1 | 2;

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;

  constructor(exitCode: ExitCode, code: string, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
  }
}
