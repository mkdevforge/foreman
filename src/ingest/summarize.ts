import { spawnSync } from "node:child_process";
import type { ParsedSession } from "./types";

export const DEFAULT_SUMMARY_MAX_TOKENS = 50_000;
export const DEFAULT_CHARS_PER_TOKEN_ESTIMATE = 4;
export const FOREMAN_SUMMARY_CHILD_ENV = "FOREMAN_SUMMARY_CHILD";

export interface SummaryTruncationOptions {
  maxTokens?: number;
  charsPerToken?: number;
}

export interface TruncatedSummaryInput {
  text: string;
  truncated: boolean;
  original_chars: number;
  kept_chars: number;
  elided_chars: number;
  estimated_tokens: number;
}

export interface SummaryRequest {
  source: ParsedSession["source"];
  source_session_id: string;
  project_path: string;
  model: string | null;
  prompt: string;
  transcript: string;
  truncated: boolean;
  elided_chars: number;
}

export interface SummaryProviderResult {
  summary_md: string;
  model_used: string;
  warnings?: string[];
}

export interface SummaryProvider {
  summarize(request: SummaryRequest): Promise<SummaryProviderResult>;
}

export interface HarnessCommand {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface HarnessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type HarnessRunner = (command: HarnessCommand) => Promise<HarnessRunResult>;

export interface HarnessSummaryProviderOptions {
  runner?: HarnessRunner;
  timeoutMs?: number;
  claudeCommand?: string;
  claudeModel?: string;
  codexCommand?: string;
  codexModel?: string;
}

export function truncateSummaryInput(
  input: string,
  options: SummaryTruncationOptions = {}
): TruncatedSummaryInput {
  const maxTokens = options.maxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
  const charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN_ESTIMATE;

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("summary maxTokens must be a positive finite number");
  }

  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new Error("summary charsPerToken must be a positive finite number");
  }

  const maxChars = Math.floor(maxTokens * charsPerToken);
  if (input.length <= maxChars) {
    return {
      text: input,
      truncated: false,
      original_chars: input.length,
      kept_chars: input.length,
      elided_chars: 0,
      estimated_tokens: estimateTokens(input.length, charsPerToken)
    };
  }

  let marker = buildElisionMarker(input.length);
  let headChars = 0;
  let tailChars = 0;
  let elidedChars = input.length;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const keepBudget = Math.max(0, maxChars - marker.length);
    headChars = Math.ceil(keepBudget / 2);
    tailChars = Math.floor(keepBudget / 2);
    elidedChars = Math.max(0, input.length - headChars - tailChars);
    const nextMarker = buildElisionMarker(elidedChars);
    if (nextMarker === marker) {
      break;
    }
    marker = nextMarker;
  }

  if (maxChars <= marker.length) {
    const text = marker.slice(0, maxChars);
    return {
      text,
      truncated: true,
      original_chars: input.length,
      kept_chars: 0,
      elided_chars: input.length,
      estimated_tokens: estimateTokens(text.length, charsPerToken)
    };
  }

  const text = `${input.slice(0, headChars)}${marker}${input.slice(input.length - tailChars)}`;
  return {
    text,
    truncated: true,
    original_chars: input.length,
    kept_chars: headChars + tailChars,
    elided_chars: elidedChars,
    estimated_tokens: estimateTokens(text.length, charsPerToken)
  };
}

export function buildSummaryRequest(
  parsed: ParsedSession,
  truncation: TruncatedSummaryInput
): SummaryRequest {
  return {
    source: parsed.source,
    source_session_id: parsed.source_session_id,
    project_path: parsed.project_path,
    model: parsed.model,
    prompt: buildSummaryPrompt(parsed, truncation),
    transcript: truncation.text,
    truncated: truncation.truncated,
    elided_chars: truncation.elided_chars
  };
}

export function createHarnessSummaryProvider(
  options: HarnessSummaryProviderOptions = {}
): SummaryProvider {
  const runner = options.runner ?? defaultHarnessRunner;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const claudeCommand = options.claudeCommand ?? "claude";
  const claudeModel = options.claudeModel ?? "haiku";
  const codexCommand = options.codexCommand ?? "codex";
  const codexModel = options.codexModel ?? "gpt-5.4-mini";

  return {
    async summarize(request: SummaryRequest): Promise<SummaryProviderResult> {
      const command =
        request.source === "claude-code"
          ? buildClaudeHarnessCommand(request, {
              command: claudeCommand,
              model: claudeModel,
              timeoutMs
            })
          : buildCodexHarnessCommand(request, {
              command: codexCommand,
              model: codexModel,
              timeoutMs
            });

      const result = await runner(command);
      if (result.error !== undefined) {
        throw result.error;
      }

      if (result.exitCode !== 0) {
        throw new Error(
          `${command.command} summary harness exited ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`
        );
      }

      const summary = result.stdout.trim();
      if (summary.length === 0) {
        throw new Error(`${command.command} summary harness returned an empty summary`);
      }

      return {
        summary_md: summary,
        model_used: request.source === "claude-code" ? claudeModel : codexModel,
        warnings: result.stderr.trim().length === 0 ? [] : [`${command.command} stderr: ${result.stderr.trim()}`]
      };
    }
  };
}

function buildSummaryPrompt(parsed: ParsedSession, truncation: TruncatedSummaryInput): string {
  return [
    "Summarize this completed Foreman coding session.",
    "Return concise Markdown only. Include the user's request, important files or commands, completed work, open risks, and useful next steps.",
    "",
    `Source: ${parsed.source}`,
    `Source session id: ${parsed.source_session_id}`,
    `Project path: ${parsed.project_path}`,
    `Session model: ${parsed.model ?? "unknown"}`,
    `Transcript truncated: ${truncation.truncated ? "yes" : "no"}`,
    `Elided chars: ${truncation.elided_chars}`,
    "",
    "<transcript>",
    truncation.text,
    "</transcript>"
  ].join("\n");
}

function buildClaudeHarnessCommand(
  request: SummaryRequest,
  input: { command: string; model: string; timeoutMs: number }
): HarnessCommand {
  return {
    command: input.command,
    args: [
      "--print",
      "--output-format",
      "text",
      "--input-format",
      "text",
      "--model",
      input.model,
      "--no-session-persistence",
      "--tools",
      ""
    ],
    stdin: request.prompt,
    cwd: request.project_path,
    env: childEnvironment(),
    timeoutMs: input.timeoutMs
  };
}

function buildCodexHarnessCommand(
  request: SummaryRequest,
  input: { command: string; model: string; timeoutMs: number }
): HarnessCommand {
  return {
    command: input.command,
    args: [
      "exec",
      "--model",
      input.model,
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-rules",
      "-"
    ],
    stdin: request.prompt,
    cwd: request.project_path,
    env: childEnvironment(),
    timeoutMs: input.timeoutMs
  };
}

async function defaultHarnessRunner(command: HarnessCommand): Promise<HarnessRunResult> {
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    input: command.stdin,
    encoding: "utf8",
    timeout: command.timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function childEnvironment(): Record<string, string> {
  return {
    ...process.env,
    [FOREMAN_SUMMARY_CHILD_ENV]: "1",
    NO_COLOR: "1"
  };
}

function buildElisionMarker(elidedChars: number): string {
  return `\n[... ${elidedChars} chars elided ...]\n`;
}

function estimateTokens(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}
