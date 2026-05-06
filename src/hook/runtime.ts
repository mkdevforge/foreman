import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { CliError, type ExitCode } from "../cli/errors";
import { openForemanDatabase } from "../db/client";
import { linkSessionChunk, updateSessionCost, upsertSessionSummary } from "../db/session-writes";
import {
  getActiveContextStatus,
  getDefaultForemanHome,
  type ActiveContext
} from "../store/active";
import { findRepoRoot, getGitUserEmail } from "../store/repo";
import { readTask } from "../store/task-store";
import {
  buildSummaryRequest,
  createHarnessSummaryProvider,
  FOREMAN_SUMMARY_CHILD_ENV,
  truncateSummaryInput,
  type SummaryProvider,
  type SummaryTruncationOptions
} from "../ingest/summarize";
import { ingestParsedSession, type IngestParsedSessionOptions, type IngestParsedSessionResult } from "../ingest/common";
import { estimateUsageCost } from "../ingest/pricing";
import type { ParsedSession } from "../ingest/types";
import {
  parseClaudeCodeStopPayload,
  parseClaudeCodeTranscriptFile,
  type ClaudeCodeStopPayload
} from "../ingest/claude-code";
import {
  findCodexTranscriptPath,
  parseCodexStopPayload,
  parseCodexTranscriptFile,
  type CodexStopPayload
} from "../ingest/codex";

export type HookName = "foreman-hook-stop-claude-code" | "foreman-hook-stop-codex";
export type HookSource = "claude-code" | "codex";
type WriteFn = (text: string) => void;
type StdinReader = () => string | Promise<string>;
type NowGenerator = () => string;

export interface HookIo {
  stdout: WriteFn;
  stderr: WriteFn;
}

export interface HookResult {
  exitCode: ExitCode;
}

export interface HookRuntimeOptions {
  stdin?: StdinReader;
  homeDir?: string;
  databasePath?: string;
  summaryProvider?: SummaryProvider;
  summaryTruncation?: SummaryTruncationOptions;
  userEmail?: string;
  machine?: string;
  idGenerator?: () => string;
  now?: NowGenerator;
  codexSessionsRoot?: string;
  env?: Record<string, string | undefined>;
}

interface HookLogInput {
  source: HookSource;
  phase: string;
  error: unknown;
  payload?: unknown;
}

interface StopPayloadResolution {
  source: HookSource;
  payload: ClaudeCodeStopPayload | CodexStopPayload;
  transcriptPath: string;
}

export async function runForemanHook(name: HookName, argv: string[], io: HookIo, options: HookRuntimeOptions = {}): Promise<HookResult> {
  const globals = extractGlobalFlags(argv);

  if (globals.help) {
    io.stdout(renderHelp(name));
    return { exitCode: 0 };
  }

  const source = hookSource(name);
  if ((options.env ?? process.env)[FOREMAN_SUMMARY_CHILD_ENV] === "1") {
    return { exitCode: 0 };
  }

  let rawPayload = "";
  let payload: unknown;
  try {
    rawPayload = await (options.stdin ?? defaultReadStdin)();
    payload = JSON.parse(rawPayload.trim());
  } catch (error) {
    appendHookError(options.homeDir, { source, phase: "parse_payload_json", error });
    return { exitCode: 0 };
  }

  let resolution: StopPayloadResolution;
  try {
    resolution = resolveStopPayload(source, payload, options);
  } catch (error) {
    appendHookError(options.homeDir, { source, phase: "parse_payload", error, payload });
    return { exitCode: 0 };
  }

  let parsed: ParsedSession;
  try {
    parsed = parseStopTranscript(resolution);
  } catch (error) {
    appendHookError(options.homeDir, { source, phase: "parse_transcript", error, payload });
    return { exitCode: 0 };
  }

  let db: Database | null = null;
  let baseResult: IngestParsedSessionResult;
  try {
    db = openForemanDatabase({ homeDir: options.homeDir, databasePath: options.databasePath });
    baseResult = ingestParsedSession(db, parsed, ingestOptions(parsed, options));
    updateDerivedCost(db, parsed, baseResult.session_id);
    linkActiveContextIfEligible(db, parsed, baseResult.session_id, source, payload, options);
  } catch (error) {
    appendHookError(options.homeDir, { source, phase: "ingest", error, payload });
    db?.close();
    return { exitCode: 0 };
  }

  try {
    await upsertSummary(db, parsed, baseResult.session_id, options);
  } catch (error) {
    appendHookError(options.homeDir, { source, phase: "summary", error, payload });
  } finally {
    db.close();
  }

  return { exitCode: 0 };
}

export const runHookStub = runForemanHook;

function resolveStopPayload(source: HookSource, payload: unknown, options: HookRuntimeOptions): StopPayloadResolution {
  if (source === "claude-code") {
    const parsedPayload = parseClaudeCodeStopPayload(payload);
    return {
      source,
      payload: parsedPayload,
      transcriptPath: parsedPayload.transcript_path
    };
  }

  const parsedPayload = parseCodexStopPayload(payload);
  const transcriptPath =
    parsedPayload.transcript_path ?? findCodexTranscriptPath(parsedPayload.source_session_id, options.codexSessionsRoot);
  if (transcriptPath === null) {
    throw new Error(`Codex transcript was not found for session ${parsedPayload.source_session_id}`);
  }

  return {
    source,
    payload: parsedPayload,
    transcriptPath
  };
}

function parseStopTranscript(resolution: StopPayloadResolution): ParsedSession {
  if (resolution.source === "claude-code") {
    return parseClaudeCodeTranscriptFile(resolution.transcriptPath, {
      stopPayload: resolution.payload as ClaudeCodeStopPayload
    });
  }

  return parseCodexTranscriptFile(resolution.transcriptPath, {
    stopPayload: {
      ...(resolution.payload as CodexStopPayload),
      transcript_path: resolution.transcriptPath
    }
  });
}

function updateDerivedCost(db: Database, parsed: ParsedSession, sessionId: string): void {
  const costEstimate = estimateUsageCost(parsed.model, parsed.usage);
  updateSessionCost(db, sessionId, costEstimate.cost_usd);
}

async function upsertSummary(
  db: Database,
  parsed: ParsedSession,
  sessionId: string,
  options: HookRuntimeOptions
): Promise<void> {
  const truncation = truncateSummaryInput(parsed.summary_input, options.summaryTruncation);
  const summaryRequest = buildSummaryRequest(parsed, truncation);
  const provider = options.summaryProvider ?? createHarnessSummaryProvider();
  const summaryResult = await provider.summarize(summaryRequest);

  upsertSessionSummary(db, {
    sessionId,
    summaryMd: summaryResult.summary_md,
    modelUsed: summaryResult.model_used,
    generatedAt: now(options)
  });
}

function linkActiveContextIfEligible(
  db: Database,
  parsed: ParsedSession,
  sessionId: string,
  source: HookSource,
  payload: unknown,
  options: HookRuntimeOptions
): void {
  const activeStatus = getActiveContextStatus(options.homeDir, new Date(now(options)));
  if (activeStatus.read.kind === "missing" || activeStatus.stale) {
    return;
  }

  if (activeStatus.read.kind === "invalid") {
    appendHookError(options.homeDir, {
      source,
      phase: "active_context",
      error: new Error(activeStatus.read.error),
      payload
    });
    return;
  }

  const active = activeStatus.read.context;
  if (!activeChunkStillExists(active)) {
    return;
  }

  const activeProjectRoot = canonicalGitRoot(active.project_path);
  const sessionProjectRoot = canonicalGitRoot(parsed.project_path);
  if (activeProjectRoot === null || sessionProjectRoot === null || activeProjectRoot !== sessionProjectRoot) {
    return;
  }

  linkSessionChunk(db, {
    sessionId,
    taskId: active.task_id,
    chunkId: active.chunk_id,
    stage: active.stage,
    linkedAt: now(options),
    linkedBy: "hook"
  });
}

function activeChunkStillExists(active: ActiveContext): boolean {
  try {
    const task = readTask(active.control_repo_root, active.task_id);
    return task.chunks.some((chunk) => chunk.id === active.chunk_id);
  } catch {
    return false;
  }
}

function canonicalGitRoot(path: string): string | null {
  try {
    return realpathSync(findRepoRoot(path));
  } catch {
    return null;
  }
}

function ingestOptions(parsed: ParsedSession, options: HookRuntimeOptions): IngestParsedSessionOptions {
  return {
    userEmail: options.userEmail ?? resolveUserEmail(parsed.project_path),
    machine: options.machine,
    idGenerator: options.idGenerator,
    now: options.now
  };
}

function resolveUserEmail(cwd: string): string {
  try {
    return getGitUserEmail(cwd) ?? process.env.USER ?? "unknown";
  } catch {
    return process.env.USER ?? "unknown";
  }
}

function appendHookError(homeDir: string | undefined, input: HookLogInput): void {
  const record = {
    ts: new Date().toISOString(),
    source: input.source,
    phase: input.phase,
    error: errorMessage(input.error),
    stack: input.error instanceof Error ? input.error.stack ?? null : null,
    ...extractPayloadLogFields(input.payload)
  };

  try {
    const logPath = join(getDefaultForemanHome(homeDir ?? homedir()), "logs", "hook-errors.log");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Hooks must never block the agent because logging failed.
  }
}

function extractPayloadLogFields(payload: unknown): {
  session_id: string | null;
  cwd: string | null;
  transcript_path: string | null;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { session_id: null, cwd: null, transcript_path: null };
  }

  const record = payload as Record<string, unknown>;
  return {
    session_id: stringField(record, "session_id") ?? stringField(record, "sessionId") ?? stringField(record, "id"),
    cwd: stringField(record, "cwd"),
    transcript_path: stringField(record, "transcript_path") ?? stringField(record, "transcriptPath")
  };
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function defaultReadStdin(): string {
  if (process.stdin.isTTY) {
    return "";
  }

  return readFileSync(0, "utf8");
}

function now(options: HookRuntimeOptions): string {
  return (options.now ?? defaultNow)();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function extractGlobalFlags(argv: string[]): { help: boolean } {
  return {
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function hookSource(name: HookName): HookSource {
  return name === "foreman-hook-stop-claude-code" ? "claude-code" : "codex";
}

function renderHelp(name: HookName): string {
  return `${name}\n\nStop hook entry point for Foreman.\n\nUsage:\n  ${name} --help\n\nReads one Stop hook JSON payload from stdin, ingests the session, and exits 0.\n`;
}

function errorMessage(error: unknown): string {
  if (error instanceof CliError) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}
