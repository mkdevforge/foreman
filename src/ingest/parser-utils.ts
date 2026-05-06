import { readFileSync } from "node:fs";
import type { ParsedUsage } from "./types";

export type JsonObject = Record<string, unknown>;

export interface JsonlRecord {
  lineNumber: number;
  value: JsonObject;
}

export function readUtf8File(path: string): string {
  return readFileSync(path, "utf8");
}

export function parseJsonl(text: string, label: string): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${message}`);
    }

    const object = asObject(parsed);
    if (object === null) {
      throw new Error(`${label} line ${index + 1} must be a JSON object`);
    }

    records.push({ lineNumber: index + 1, value: object });
  }

  if (records.length === 0) {
    throw new Error(`${label} is empty`);
  }

  return records;
}

export function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;

  for (const segment of path.split(".")) {
    const object = asObject(current);
    if (object === null || !(segment in object)) {
      return undefined;
    }

    current = object[segment];
  }

  return current;
}

export function firstString(value: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }

    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return null;
}

export function firstPresent(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const candidate = getPath(value, path);
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

export function normalizeIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} is missing a timestamp`);
  }

  const millis = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`${label} has an invalid timestamp`);
  }

  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} has an invalid timestamp`);
  }

  return date.toISOString();
}

export function optionalRecordTimestamp(record: JsonlRecord): string | null {
  const raw = firstPresent(record.value, [
    "timestamp",
    "ts",
    "time",
    "created_at",
    "payload.timestamp",
    "payload.ts",
    "payload.time",
    "message.timestamp"
  ]);

  if (raw === undefined) {
    return null;
  }

  return normalizeIsoTimestamp(raw, `JSONL line ${record.lineNumber}`);
}

export function timestampBounds(timestamps: string[], label: string): { startedAt: string; endedAt: string } {
  if (timestamps.length === 0) {
    throw new Error(`${label} does not contain any timestamps`);
  }

  const sorted = [...timestamps].sort();
  return {
    startedAt: sorted[0],
    endedAt: sorted[sorted.length - 1]
  };
}

export function extractTextContent(value: unknown, ignoredTypes: string[] = []): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextContent(item, ignoredTypes))
      .filter((part) => part.length > 0)
      .join("\n");
  }

  const object = asObject(value);
  if (object === null) {
    return "";
  }

  const type = typeof object.type === "string" ? object.type : null;
  if (type !== null && ignoredTypes.includes(type)) {
    return "";
  }

  if (typeof object.text === "string") {
    return object.text;
  }

  if (typeof object.message === "string") {
    return object.message;
  }

  if ("content" in object) {
    return extractTextContent(object.content, ignoredTypes);
  }

  return "";
}

export function toJson(value: unknown, fallback: unknown = null): string {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function addUsage(target: ParsedUsage, value: unknown): void {
  const object = asObject(value);
  if (object === null) {
    return;
  }

  target.input_tokens += firstNumber(object, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens"
  ]);
  target.output_tokens += firstNumber(object, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens"
  ]);
  target.cache_read_tokens += firstNumber(object, [
    "cache_read_tokens",
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cacheReadTokens",
    "cacheReadInputTokens",
    "cachedInputTokens"
  ]);
  target.cache_creation_tokens += firstNumber(object, [
    "cache_creation_tokens",
    "cache_creation_input_tokens",
    "cacheCreationTokens",
    "cacheCreationInputTokens"
  ]);
}

export function collectUsage(target: ParsedUsage, entry: unknown): void {
  for (const path of ["usage", "message.usage", "payload.usage", "payload.response.usage"]) {
    addUsage(target, getPath(entry, path));
  }
}

function firstNumber(value: JsonObject, keys: string[]): number {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
  }

  return 0;
}
