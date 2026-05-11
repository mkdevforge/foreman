import type { CliError } from "./errors";

export interface JsonErrorResponse {
  schema_version: 1;
  error: {
    code: string;
    message: string;
    exit_code: number;
    details?: Record<string, unknown>;
  };
}

export function renderTextError(error: CliError): string {
  return `error: ${error.message}\n`;
}

export function formatJsonError(error: CliError): string {
  const response: JsonErrorResponse = {
    schema_version: 1,
    error: {
      code: error.code,
      message: error.message,
      exit_code: error.exitCode,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };

  return `${JSON.stringify(response, null, 2)}\n`;
}

export function formatJsonData<T extends Record<string, unknown>>(data: T): string {
  return `${JSON.stringify({ schema_version: 1, ...data }, null, 2)}\n`;
}
