import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
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
  stdoutFormat: "plain-text" | "codex-json";
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
  env?: Record<string, string | undefined>;
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
  const env = options.env ?? process.env;
  const claudeCommand = options.claudeCommand ?? resolveHarnessCommand("claude", env);
  const claudeModel = options.claudeModel ?? "haiku";
  const codexCommand = options.codexCommand ?? resolveHarnessCommand("codex", env);
  const codexModel = options.codexModel ?? "gpt-5.4-mini";

  return {
    async summarize(request: SummaryRequest): Promise<SummaryProviderResult> {
      const command =
        request.source === "claude-code"
          ? buildClaudeHarnessCommand(request, {
              command: claudeCommand,
              model: claudeModel,
              timeoutMs,
              env
            })
          : buildCodexHarnessCommand(request, {
              command: codexCommand,
              model: codexModel,
              timeoutMs,
              env
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

      const summary = extractHarnessSummary(command, result.stdout).trim();
      if (summary.length === 0) {
        throw new Error(`${command.command} summary harness returned an empty summary`);
      }

      return {
        summary_md: summary,
        model_used: request.source === "claude-code" ? claudeModel : codexModel,
        warnings: formatStderrWarnings(command.command, result.stderr)
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
  input: { command: string; model: string; timeoutMs: number; env: Record<string, string | undefined> }
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
    env: childEnvironment(input.env),
    timeoutMs: input.timeoutMs,
    stdoutFormat: "plain-text"
  };
}

function buildCodexHarnessCommand(
  request: SummaryRequest,
  input: { command: string; model: string; timeoutMs: number; env: Record<string, string | undefined> }
): HarnessCommand {
  return {
    command: input.command,
    args: [
      "--disable",
      "plugins",
      "--ask-for-approval",
      "never",
      "exec",
      "--model",
      input.model,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "-"
    ],
    stdin: request.prompt,
    cwd: request.project_path,
    env: childEnvironment(input.env),
    timeoutMs: input.timeoutMs,
    stdoutFormat: "codex-json"
  };
}

export function resolveHarnessCommand(
  binaryName: "claude" | "codex",
  env: Record<string, string | undefined> = process.env
): string {
  const pathMatch = findExecutableOnPath(binaryName, env.PATH, env.HOME);
  if (pathMatch !== null) {
    return pathMatch;
  }

  for (const dir of fallbackUserBinDirs(env.HOME)) {
    const candidate = join(dir, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return binaryName;
}

function extractHarnessSummary(command: HarnessCommand, stdout: string): string {
  if (command.stdoutFormat === "plain-text") {
    return stdout;
  }

  let summary: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!isJsonObject(event) || event.type !== "item.completed" || !isJsonObject(event.item)) {
      continue;
    }

    if (event.item.type === "agent_message" && typeof event.item.text === "string") {
      summary = event.item.text;
    }
  }

  if (summary === null) {
    throw new Error(`${command.command} summary harness did not return a Codex agent message`);
  }

  return summary;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatStderrWarnings(command: string, stderr: string): string[] {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const maxLength = 2_000;
  const diagnostic =
    trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}\n[... stderr truncated ...]`;
  return [`${command} stderr: ${diagnostic}`];
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

function childEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      child[key] = value;
    }
  }

  child[FOREMAN_SUMMARY_CHILD_ENV] = "1";
  child.NO_COLOR = "1";
  return child;
}

function findExecutableOnPath(binaryName: string, pathValue: string | undefined, homeDir: string | undefined): string | null {
  if (pathValue === undefined || pathValue.length === 0) {
    return null;
  }

  for (const rawEntry of pathValue.split(delimiter)) {
    if (rawEntry.length === 0) {
      continue;
    }

    const entry = expandHome(rawEntry, homeDir);
    const candidate = join(entry, binaryName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function fallbackUserBinDirs(homeDir: string | undefined): string[] {
  if (homeDir === undefined || homeDir.length === 0) {
    return [];
  }

  return [
    join(homeDir, ".local", "bin"),
    join(homeDir, ".bun", "bin"),
    join(homeDir, ".npm-global", "bin"),
    join(homeDir, "Library", "pnpm")
  ];
}

function expandHome(pathEntry: string, homeDir: string | undefined): string {
  if (pathEntry === "~") {
    return homeDir ?? pathEntry;
  }

  if (pathEntry.startsWith("~/") && homeDir !== undefined && homeDir.length > 0) {
    return join(homeDir, pathEntry.slice(2));
  }

  return pathEntry;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function buildElisionMarker(elidedChars: number): string {
  return `\n[... ${elidedChars} chars elided ...]\n`;
}

function estimateTokens(chars: number, charsPerToken: number): number {
  return Math.ceil(chars / charsPerToken);
}
