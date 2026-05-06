export type ParsedSessionSource = "claude-code" | "codex";

export interface ParsedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface ParsedPrompt {
  ts: string;
  content: string;
}

export interface ParsedToolCall {
  ts: string;
  tool_name: string;
  params_json: string;
  result_json: string | null;
  is_error: boolean;
}

export interface ParsedSession {
  source: ParsedSessionSource;
  source_session_id: string;
  started_at: string;
  ended_at: string;
  project_path: string;
  repo_remote: string | null;
  model: string | null;
  prompts: ParsedPrompt[];
  tool_calls: ParsedToolCall[];
  usage: ParsedUsage;
  summary_input: string;
  warnings: string[];
}

export function createEmptyParsedUsage(): ParsedUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0
  };
}
