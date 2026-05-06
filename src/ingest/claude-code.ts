import type { ParsedPrompt, ParsedSession, ParsedToolCall } from "./types";
import { createEmptyParsedUsage } from "./types";
import {
  asObject,
  collectUsage,
  extractTextContent,
  firstString,
  getPath,
  optionalRecordTimestamp,
  parseJsonl,
  readUtf8File,
  timestampBounds,
  toJson,
  type JsonObject
} from "./parser-utils";

export interface ClaudeCodeStopPayload {
  source_session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string | null;
  repo_remote: string | null;
}

interface ParseClaudeCodeOptions {
  stopPayload?: ClaudeCodeStopPayload;
}

interface PendingClaudeToolCall extends ParsedToolCall {
  toolUseId: string;
}

export function parseClaudeCodeStopPayload(payload: unknown): ClaudeCodeStopPayload {
  const object = asObject(payload);
  if (object === null) {
    throw new Error("Claude Code Stop payload must be a JSON object");
  }

  const sourceSessionId = firstString(object, ["session_id", "sessionId", "id"]);
  const transcriptPath = firstString(object, ["transcript_path", "transcriptPath"]);
  const cwd = firstString(object, ["cwd"]);

  if (sourceSessionId === null) {
    throw new Error("Claude Code Stop payload is missing session_id");
  }

  if (transcriptPath === null) {
    throw new Error("Claude Code Stop payload is missing transcript_path");
  }

  if (cwd === null) {
    throw new Error("Claude Code Stop payload is missing cwd");
  }

  return {
    source_session_id: sourceSessionId,
    transcript_path: transcriptPath,
    cwd,
    hook_event_name: firstString(object, ["hook_event_name", "hookEventName"]),
    repo_remote: firstString(object, ["repo_remote", "repoRemote"])
  };
}

export function parseClaudeCodeTranscriptFile(path: string, options: ParseClaudeCodeOptions = {}): ParsedSession {
  return parseClaudeCodeTranscript(readUtf8File(path), options);
}

export function parseClaudeCodeTranscript(text: string, options: ParseClaudeCodeOptions = {}): ParsedSession {
  const records = parseJsonl(text, "Claude Code transcript");
  const prompts: ParsedPrompt[] = [];
  const toolCallsById = new Map<string, PendingClaudeToolCall>();
  const toolCallOrder: string[] = [];
  const usage = createEmptyParsedUsage();
  const warnings: string[] = [];
  const timestamps: string[] = [];
  const summaryParts: string[] = [];
  let transcriptSessionId: string | null = null;
  let projectPath: string | null = options.stopPayload?.cwd ?? null;
  let repoRemote: string | null = options.stopPayload?.repo_remote ?? null;
  let model: string | null = null;
  let warnedSessionMismatch = false;

  for (const record of records) {
    const entry = record.value;
    const ts = optionalRecordTimestamp(record);
    if (ts !== null) {
      timestamps.push(ts);
    }

    const recordSessionId = firstString(entry, ["sessionId", "session_id"]);
    transcriptSessionId ??= recordSessionId;
    if (
      !warnedSessionMismatch &&
      options.stopPayload?.source_session_id !== undefined &&
      recordSessionId !== null &&
      recordSessionId !== options.stopPayload.source_session_id
    ) {
      warnings.push(
        `transcript session id ${recordSessionId} does not match Stop payload session id ${options.stopPayload.source_session_id}`
      );
      warnedSessionMismatch = true;
    }

    projectPath ??= firstString(entry, ["cwd"]);
    repoRemote ??= firstString(entry, ["repo_remote", "repoRemote"]);
    model = firstString(entry, ["message.model", "model"]) ?? model;
    collectUsage(usage, entry);

    const type = firstString(entry, ["type"]);
    if (type === "user") {
      parseClaudeUserRecord(entry, ts, prompts, toolCallsById, warnings, summaryParts);
    } else if (type === "assistant") {
      parseClaudeAssistantRecord(entry, ts, toolCallsById, toolCallOrder, summaryParts);
    } else if (type !== null) {
      warnings.push(`ignored unsupported Claude Code record type ${type} at line ${record.lineNumber}`);
    }
  }

  const sourceSessionId = options.stopPayload?.source_session_id ?? transcriptSessionId;
  if (sourceSessionId === null) {
    throw new Error("Claude Code transcript is missing session id");
  }

  if (projectPath === null) {
    throw new Error("Claude Code transcript is missing project cwd");
  }

  const { startedAt, endedAt } = timestampBounds(timestamps, "Claude Code transcript");

  return {
    source: "claude-code",
    source_session_id: sourceSessionId,
    started_at: startedAt,
    ended_at: endedAt,
    project_path: projectPath,
    repo_remote: repoRemote,
    model,
    prompts,
    tool_calls: toolCallOrder.map((toolUseId) => stripToolUseId(toolCallsById.get(toolUseId))).filter(isParsedToolCall),
    usage,
    summary_input: summaryParts.join("\n\n"),
    warnings
  };
}

function parseClaudeUserRecord(
  entry: JsonObject,
  ts: string | null,
  prompts: ParsedPrompt[],
  toolCallsById: Map<string, PendingClaudeToolCall>,
  warnings: string[],
  summaryParts: string[]
): void {
  const content = getPath(entry, "message.content");
  const promptText = extractTextContent(content, ["tool_result"]).trim();
  if (promptText.length > 0 && ts !== null) {
    prompts.push({ ts, content: promptText });
    summaryParts.push(renderSummaryPart(ts, "User", promptText));
  }

  for (const block of contentBlocks(content)) {
    const blockType = firstString(block, ["type"]);
    if (blockType !== "tool_result") {
      continue;
    }

    const toolUseId = firstString(block, ["tool_use_id", "toolUseId"]);
    if (toolUseId === null) {
      warnings.push("ignored Claude Code tool_result without tool_use_id");
      continue;
    }

    const pending = toolCallsById.get(toolUseId);
    if (pending === undefined) {
      warnings.push(`ignored Claude Code tool_result for unknown tool_use_id ${toolUseId}`);
      continue;
    }

    pending.result_json = toJson(normalizeClaudeToolResult(block));
    pending.is_error = getPath(block, "is_error") === true;
    summaryParts.push(renderSummaryPart(ts ?? pending.ts, `Tool result ${pending.tool_name}`, pending.result_json));
  }
}

function parseClaudeAssistantRecord(
  entry: JsonObject,
  ts: string | null,
  toolCallsById: Map<string, PendingClaudeToolCall>,
  toolCallOrder: string[],
  summaryParts: string[]
): void {
  const content = getPath(entry, "message.content");
  const assistantText = extractTextContent(content, ["tool_use"]).trim();
  if (assistantText.length > 0 && ts !== null) {
    summaryParts.push(renderSummaryPart(ts, "Assistant", assistantText));
  }

  for (const block of contentBlocks(content)) {
    const blockType = firstString(block, ["type"]);
    if (blockType !== "tool_use") {
      continue;
    }

    const toolUseId = firstString(block, ["id"]);
    const toolName = firstString(block, ["name"]);
    if (toolUseId === null || toolName === null || ts === null) {
      continue;
    }

    const pending: PendingClaudeToolCall = {
      toolUseId,
      ts,
      tool_name: toolName,
      params_json: toJson(getPath(block, "input"), {}),
      result_json: null,
      is_error: false
    };

    toolCallsById.set(toolUseId, pending);
    toolCallOrder.push(toolUseId);
    summaryParts.push(renderSummaryPart(ts, `Tool use ${toolName}`, pending.params_json));
  }
}

function contentBlocks(content: unknown): JsonObject[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.map(asObject).filter((block): block is JsonObject => block !== null);
}

function normalizeClaudeToolResult(block: JsonObject): JsonObject {
  return {
    content: getPath(block, "content") ?? null,
    is_error: getPath(block, "is_error") === true
  };
}

function stripToolUseId(toolCall: PendingClaudeToolCall | undefined): ParsedToolCall | null {
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
