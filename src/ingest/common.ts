import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { v7 as uuidv7 } from "uuid";
import type { ParsedSession, ParsedToolCall } from "./types";

type IdGenerator = () => string;
type NowGenerator = () => string;

export interface IngestParsedSessionOptions {
  userEmail: string;
  machine?: string;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export interface IngestParsedSessionResult {
  session_id: string;
  session_created: boolean;
  prompts_inserted: number;
  tool_calls_inserted: number;
  usage_upserted: boolean;
  warnings: string[];
}

interface SessionIdRow {
  id: string;
}

interface SqlRunResult {
  changes: number;
}

export function ingestParsedSession(
  db: Database,
  parsed: ParsedSession,
  options: IngestParsedSessionOptions
): IngestParsedSessionResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;
  const machine = options.machine ?? hostname();

  const ingest = db.transaction(() => {
    const existingSessionId = findSessionId(db, parsed);
    const sessionId = existingSessionId ?? idGenerator();
    const sessionCreated = existingSessionId === null;

    if (sessionCreated) {
      insertSession(db, parsed, {
        id: sessionId,
        machine,
        userEmail: options.userEmail,
        createdAt: now()
      });
    } else {
      updateSessionMetadata(db, parsed, sessionId);
    }

    let promptsInserted = 0;
    for (const prompt of parsed.prompts) {
      promptsInserted += insertPrompt(db, {
        id: idGenerator(),
        sessionId,
        ts: prompt.ts,
        content: prompt.content,
        contentHash: hashPromptContent(prompt.content)
      });
    }

    const warnings = [...parsed.warnings];
    let toolCallsInserted = 0;
    for (const toolCall of parsed.tool_calls) {
      const { hash, warnings: hashWarnings } = hashToolCallParamsWithWarnings(toolCall);
      warnings.push(...hashWarnings);
      toolCallsInserted += insertToolCall(db, {
        id: idGenerator(),
        sessionId,
        ts: toolCall.ts,
        toolName: toolCall.tool_name,
        paramsJson: toolCall.params_json,
        resultJson: toolCall.result_json,
        isError: toolCall.is_error,
        paramsHash: hash
      });
    }

    upsertUsage(db, sessionId, parsed);

    return {
      session_id: sessionId,
      session_created: sessionCreated,
      prompts_inserted: promptsInserted,
      tool_calls_inserted: toolCallsInserted,
      usage_upserted: true,
      warnings
    };
  });

  return ingest.immediate();
}

export function hashPromptContent(content: string): string {
  return sha256(content);
}

export function hashToolCallParams(toolCall: Pick<ParsedToolCall, "tool_name" | "params_json">): string {
  return hashToolCallParamsWithWarnings(toolCall).hash;
}

function hashToolCallParamsWithWarnings(
  toolCall: Pick<ParsedToolCall, "tool_name" | "params_json">
): { hash: string; warnings: string[] } {
  const warnings: string[] = [];
  let params: unknown;

  try {
    params = JSON.parse(toolCall.params_json);
  } catch {
    params = toolCall.params_json;
    warnings.push(`tool call ${toolCall.tool_name} has invalid params_json; hashed raw params_json`);
  }

  return {
    hash: sha256(stableJson({ tool_name: toolCall.tool_name, params })),
    warnings
  };
}

function findSessionId(db: Database, parsed: ParsedSession): string | null {
  const row = db
    .query<SessionIdRow, [string, string]>(
      "SELECT id FROM sessions WHERE source = ? AND source_session_id = ?"
    )
    .get(parsed.source, parsed.source_session_id);

  return row?.id ?? null;
}

function insertSession(
  db: Database,
  parsed: ParsedSession,
  input: { id: string; machine: string; userEmail: string; createdAt: string }
): void {
  runSql(
    db,
    `INSERT INTO sessions (
      id,
      source,
      source_session_id,
      started_at,
      ended_at,
      project_path,
      repo_remote,
      model,
      machine,
      user_email,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      parsed.source,
      parsed.source_session_id,
      parsed.started_at,
      parsed.ended_at,
      parsed.project_path,
      parsed.repo_remote,
      parsed.model,
      input.machine,
      input.userEmail,
      input.createdAt
    ]
  );
}

function updateSessionMetadata(db: Database, parsed: ParsedSession, sessionId: string): void {
  runSql(
    db,
    `UPDATE sessions
      SET started_at = ?,
          ended_at = ?,
          project_path = ?,
          repo_remote = ?,
          model = ?
      WHERE id = ?`,
    [parsed.started_at, parsed.ended_at, parsed.project_path, parsed.repo_remote, parsed.model, sessionId]
  );
}

function insertPrompt(
  db: Database,
  input: { id: string; sessionId: string; ts: string; content: string; contentHash: string }
): number {
  return runSql(
    db,
    `INSERT INTO prompts (
      id,
      session_id,
      ts,
      content,
      content_hash
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`,
    [input.id, input.sessionId, input.ts, input.content, input.contentHash]
  );
}

function insertToolCall(
  db: Database,
  input: {
    id: string;
    sessionId: string;
    ts: string;
    toolName: string;
    paramsJson: string;
    resultJson: string | null;
    isError: boolean;
    paramsHash: string;
  }
): number {
  return runSql(
    db,
    `INSERT INTO tool_calls (
      id,
      session_id,
      ts,
      tool_name,
      params_json,
      result_json,
      is_error,
      params_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`,
    [
      input.id,
      input.sessionId,
      input.ts,
      input.toolName,
      input.paramsJson,
      input.resultJson,
      input.isError ? 1 : 0,
      input.paramsHash
    ]
  );
}

function upsertUsage(db: Database, sessionId: string, parsed: ParsedSession): void {
  runSql(
    db,
    `INSERT INTO usage (
      session_id,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_creation_tokens,
      cost_usd
    ) VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(session_id) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cost_usd = excluded.cost_usd`,
    [
      sessionId,
      parsed.usage.input_tokens,
      parsed.usage.output_tokens,
      parsed.usage.cache_read_tokens,
      parsed.usage.cache_creation_tokens
    ]
  );
}

function runSql(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const result = db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params) as SqlRunResult;
  return result.changes;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
