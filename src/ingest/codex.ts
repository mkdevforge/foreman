import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedPrompt, ParsedSession, ParsedToolCall } from "./types";
import { createEmptyParsedUsage } from "./types";
import {
  asObject,
  collectUsage,
  extractTextContent,
  firstPresent,
  firstString,
  getPath,
  optionalRecordTimestamp,
  parseJsonl,
  readUtf8File,
  timestampBounds,
  toJson,
  type JsonObject
} from "./parser-utils";

const CODEX_TOOL_USE_TYPES = new Set(["function_call", "custom_tool_call", "web_search_call"]);
const CODEX_TOOL_RESULT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

export interface CodexStopPayload {
  source_session_id: string;
  transcript_path: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  repo_remote: string | null;
}

interface ParseCodexOptions {
  stopPayload?: CodexStopPayload;
}

interface PendingCodexToolCall extends ParsedToolCall {
  callId: string;
}

export function parseCodexStopPayload(payload: unknown): CodexStopPayload {
  const object = asObject(payload);
  if (object === null) {
    throw new Error("Codex Stop payload must be a JSON object");
  }

  const sourceSessionId = firstString(object, [
    "session_id",
    "sessionId",
    "id",
    "session_meta.payload.id",
    "sessionMeta.payload.id"
  ]);

  if (sourceSessionId === null) {
    throw new Error("Codex Stop payload is missing session_id");
  }

  return {
    source_session_id: sourceSessionId,
    transcript_path: firstString(object, ["transcript_path", "transcriptPath"]),
    cwd: firstString(object, ["cwd"]),
    last_assistant_message: firstString(object, ["last_assistant_message", "lastAssistantMessage"]),
    repo_remote: firstString(object, ["repo_remote", "repoRemote"])
  };
}

export function parseCodexTranscriptFile(path: string, options: ParseCodexOptions = {}): ParsedSession {
  return parseCodexTranscript(readUtf8File(path), options);
}

export function parseCodexTranscript(text: string, options: ParseCodexOptions = {}): ParsedSession {
  const records = parseJsonl(text, "Codex transcript");
  const prompts: ParsedPrompt[] = [];
  const toolCallsById = new Map<string, PendingCodexToolCall>();
  const toolCallOrder: string[] = [];
  const usage = createEmptyParsedUsage();
  const warnings: string[] = [];
  const timestamps: string[] = [];
  const summaryParts: string[] = [];
  let sessionMetaId: string | null = null;
  let sessionMetaCwd: string | null = null;
  let latestTurnContextCwd: string | null = null;
  let repoRemote: string | null = options.stopPayload?.repo_remote ?? null;
  let model: string | null = null;

  for (const record of records) {
    const entry = record.value;
    const ts = optionalRecordTimestamp(record);
    if (ts !== null) {
      timestamps.push(ts);
    }

    const rootType = firstString(entry, ["type"]);
    const payloadType = firstString(entry, ["payload.type"]);
    const eventType = payloadType ?? rootType;

    if (rootType === "session_meta") {
      sessionMetaId ??= firstString(entry, ["payload.id", "session_id", "sessionId"]);
      sessionMetaCwd ??= firstString(entry, ["payload.cwd", "cwd"]);
      repoRemote ??= firstString(entry, ["payload.repo_remote", "payload.repoRemote", "repo_remote", "repoRemote"]);
      model = firstString(entry, ["payload.model", "model"]) ?? model;
    } else if (rootType === "turn_context") {
      latestTurnContextCwd = firstString(entry, ["payload.cwd", "cwd"]) ?? latestTurnContextCwd;
      model = firstString(entry, ["payload.model", "model"]) ?? model;
    }

    model = firstString(entry, ["payload.model", "payload.response.model", "model"]) ?? model;
    collectUsage(usage, entry);

    if (eventType === "user_message") {
      parseCodexUserMessage(entry, ts, prompts, summaryParts);
    } else if (eventType === "agent_message") {
      parseCodexAgentMessage(entry, ts, summaryParts);
    } else if (eventType !== null && CODEX_TOOL_USE_TYPES.has(eventType)) {
      parseCodexToolUse(entry, eventType, ts, toolCallsById, toolCallOrder, summaryParts, warnings);
    } else if (eventType !== null && CODEX_TOOL_RESULT_TYPES.has(eventType)) {
      parseCodexToolResult(entry, ts, toolCallsById, summaryParts, warnings);
    }
  }

  const sourceSessionId = options.stopPayload?.source_session_id ?? sessionMetaId;
  if (sourceSessionId === null) {
    throw new Error("Codex transcript is missing session id");
  }

  if (options.stopPayload?.source_session_id !== undefined && sessionMetaId !== null && sessionMetaId !== options.stopPayload.source_session_id) {
    warnings.push(
      `transcript session id ${sessionMetaId} does not match Stop payload session id ${options.stopPayload.source_session_id}`
    );
  }

  const projectPath = options.stopPayload?.cwd ?? latestTurnContextCwd ?? sessionMetaCwd;
  if (projectPath === null) {
    throw new Error("Codex transcript is missing project cwd");
  }

  const { startedAt, endedAt } = timestampBounds(timestamps, "Codex transcript");

  return {
    source: "codex",
    source_session_id: sourceSessionId,
    started_at: startedAt,
    ended_at: endedAt,
    project_path: projectPath,
    repo_remote: repoRemote,
    model,
    prompts,
    tool_calls: toolCallOrder.map((callId) => stripCallId(toolCallsById.get(callId))).filter(isParsedToolCall),
    usage,
    summary_input: summaryParts.join("\n\n"),
    warnings
  };
}

export function findCodexTranscriptPath(
  sessionId: string,
  sessionsRoot = join(homedir(), ".codex", "sessions")
): string | null {
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  const candidates = listJsonlFiles(sessionsRoot).sort();
  for (const candidate of candidates) {
    const text = readUtf8File(candidate);
    if (codexTranscriptContainsSession(text, sessionId)) {
      return candidate;
    }
  }

  return null;
}

function parseCodexUserMessage(
  entry: JsonObject,
  ts: string | null,
  prompts: ParsedPrompt[],
  summaryParts: string[]
): void {
  if (ts === null) {
    return;
  }

  const content = firstPresent(entry, ["payload.message", "payload.content", "message", "content"]);
  const promptText = extractTextContent(content).trim();
  if (promptText.length === 0) {
    return;
  }

  prompts.push({ ts, content: promptText });
  summaryParts.push(renderSummaryPart(ts, "User", promptText));
}

function parseCodexAgentMessage(entry: JsonObject, ts: string | null, summaryParts: string[]): void {
  if (ts === null) {
    return;
  }

  const content = firstPresent(entry, ["payload.message", "payload.content", "message", "content"]);
  const assistantText = extractTextContent(content).trim();
  if (assistantText.length > 0) {
    summaryParts.push(renderSummaryPart(ts, "Assistant", assistantText));
  }
}

function parseCodexToolUse(
  entry: JsonObject,
  eventType: string,
  ts: string | null,
  toolCallsById: Map<string, PendingCodexToolCall>,
  toolCallOrder: string[],
  summaryParts: string[],
  warnings: string[]
): void {
  const callId = firstString(entry, ["payload.call_id", "call_id"]);
  if (callId === null) {
    warnings.push(`ignored Codex ${eventType} without payload.call_id`);
    return;
  }

  if (ts === null) {
    warnings.push(`ignored Codex ${eventType} ${callId} without timestamp`);
    return;
  }

  let toolName = firstString(entry, ["payload.name", "name"]);
  if (toolName === null && eventType === "web_search_call") {
    toolName = "web_search";
  }

  if (toolName === null) {
    warnings.push(`ignored Codex ${eventType} ${callId} without payload.name`);
    return;
  }

  const input = firstPresent(entry, ["payload.arguments", "payload.input", "payload.action"]);
  const pending: PendingCodexToolCall = {
    callId,
    ts,
    tool_name: toolName,
    params_json: toJson(input, {}),
    result_json: null,
    is_error: false
  };

  toolCallsById.set(callId, pending);
  toolCallOrder.push(callId);
  summaryParts.push(renderSummaryPart(ts, `Tool use ${toolName}`, pending.params_json));
}

function parseCodexToolResult(
  entry: JsonObject,
  ts: string | null,
  toolCallsById: Map<string, PendingCodexToolCall>,
  summaryParts: string[],
  warnings: string[]
): void {
  const callId = firstString(entry, ["payload.call_id", "call_id"]);
  if (callId === null) {
    warnings.push("ignored Codex tool result without payload.call_id");
    return;
  }

  const pending = toolCallsById.get(callId);
  if (pending === undefined) {
    warnings.push(`ignored Codex tool result for unknown call_id ${callId}`);
    return;
  }

  pending.result_json = toJson({
    output: firstPresent(entry, ["payload.output", "output"]) ?? null,
    is_error: getPath(entry, "payload.is_error") === true || getPath(entry, "payload.error") === true
  });
  pending.is_error = getPath(entry, "payload.is_error") === true || getPath(entry, "payload.error") === true;
  summaryParts.push(renderSummaryPart(ts ?? pending.ts, `Tool result ${pending.tool_name}`, pending.result_json));
}

function codexTranscriptContainsSession(text: string, sessionId: string): boolean {
  try {
    return parseJsonl(text, "Codex transcript candidate").some((record) => {
      const rootType = firstString(record.value, ["type"]);
      return rootType === "session_meta" && firstString(record.value, ["payload.id"]) === sessionId;
    });
  } catch {
    return false;
  }
}

function listJsonlFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }

  return files;
}

function stripCallId(toolCall: PendingCodexToolCall | undefined): ParsedToolCall | null {
  if (toolCall === undefined) {
    return null;
  }

  return {
    ts: toolCall.ts,
    tool_name: toolCall.tool_name,
    params_json: toolCall.params_json,
    result_json: toolCall.result_json,
    is_error: toolCall.is_error
  };
}

function isParsedToolCall(toolCall: ParsedToolCall | null): toolCall is ParsedToolCall {
  return toolCall !== null;
}

function renderSummaryPart(ts: string, label: string, body: string): string {
  return `[${ts}] ${label}\n${body}`;
}
