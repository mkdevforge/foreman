import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCodexTranscriptPath,
  parseClaudeCodeStopPayload,
  parseClaudeCodeTranscriptFile,
  parseCodexStopPayload,
  parseCodexTranscriptFile
} from "../../src/ingest";

const fixturesDir = fileURLToPath(new URL("../fixtures/ingest/", import.meta.url));
const claudeTranscriptPath = join(fixturesDir, "claude-code-session.jsonl");
const codexSessionsRoot = join(fixturesDir, "codex", "sessions");
const codexTranscriptPath = join(codexSessionsRoot, "2026", "05", "codex-session.jsonl");

/*
 * Codex fixture assumptions for Phase 3a:
 * - Session metadata arrives as top-level `type: "session_meta"` with `payload.id`.
 * - Later `type: "turn_context"` events can update the session cwd.
 * - User, assistant, tool-use, and tool-result records are distinguished by `payload.type`.
 * - Tool-use/result pairing is keyed by `payload.call_id`.
 */

describe("Phase 3a Claude Code transcript parsing", () => {
  test("parses Claude Code Stop payload fields", () => {
    const payload = parseClaudeCodeStopPayload({
      session_id: "claude-worktree-1",
      transcript_path: claudeTranscriptPath,
      cwd: "/Users/example/foreman-worktrees/claude-feature",
      hook_event_name: "Stop"
    });

    expect(payload.source_session_id).toBe("claude-worktree-1");
    expect(payload.transcript_path).toBe(claudeTranscriptPath);
    expect(payload.cwd).toBe("/Users/example/foreman-worktrees/claude-feature");
    expect(payload.hook_event_name).toBe("Stop");
  });

  test("normalizes prompts, tool calls, usage, and worktree cwd", () => {
    const stopPayload = parseClaudeCodeStopPayload({
      session_id: "claude-worktree-1",
      transcript_path: claudeTranscriptPath,
      cwd: "/Users/example/foreman-worktrees/claude-feature",
      hook_event_name: "Stop"
    });

    const parsed = parseClaudeCodeTranscriptFile(stopPayload.transcript_path, { stopPayload });

    expect(parsed.source).toBe("claude-code");
    expect(parsed.source_session_id).toBe("claude-worktree-1");
    expect(parsed.started_at).toBe("2026-05-06T09:00:00.000Z");
    expect(parsed.ended_at).toBe("2026-05-06T09:03:00.000Z");
    expect(parsed.project_path).toBe("/Users/example/foreman-worktrees/claude-feature");
    expect(parsed.model).toBe("claude-sonnet-4-20250514");
    expect(parsed.repo_remote).toBeNull();

    expect(parsed.prompts).toEqual([
      {
        ts: "2026-05-06T09:00:00.000Z",
        content: "Implement parser fixtures."
      }
    ]);

    expect(parsed.tool_calls).toHaveLength(2);
    expect(parsed.tool_calls[0]).toEqual({
      ts: "2026-05-06T09:01:00.000Z",
      tool_name: "Read",
      params_json: "{\"file_path\":\"src/cli/runtime.ts\"}",
      result_json: "{\"content\":\"runtime contents\",\"is_error\":false}",
      is_error: false
    });
    expect(parsed.tool_calls[1]).toEqual({
      ts: "2026-05-06T09:03:00.000Z",
      tool_name: "Bash",
      params_json: "{\"command\":\"bun test tests/ingest\"}",
      result_json: null,
      is_error: false
    });

    expect(parsed.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 300,
      cache_read_tokens: 50,
      cache_creation_tokens: 10
    });
    expect(parsed.summary_input).toContain("Implement parser fixtures.");
    expect(parsed.summary_input).toContain("Tool result Read");
    expect(parsed.summary_input).toContain("bun test tests/ingest");
    expect(parsed.warnings).toEqual([]);
  });
});

describe("Phase 3a Codex transcript parsing", () => {
  test("parses Codex Stop payload fields", () => {
    const payload = parseCodexStopPayload({
      session_meta: {
        payload: {
          id: "codex-worktree-1"
        }
      },
      cwd: "/Users/example/foreman-worktrees/codex-stop",
      last_assistant_message: "done"
    });

    expect(payload.source_session_id).toBe("codex-worktree-1");
    expect(payload.cwd).toBe("/Users/example/foreman-worktrees/codex-stop");
    expect(payload.last_assistant_message).toBe("done");
  });

  test("locates Codex transcript fixtures by session id", () => {
    const found = findCodexTranscriptPath("codex-worktree-1", codexSessionsRoot);

    expect(found).toBe(codexTranscriptPath);
    expect(dirname(found ?? "")).toBe(join(codexSessionsRoot, "2026", "05"));
  });

  test("normalizes Codex prompts, call_id-paired tool calls, usage, and Stop cwd precedence", () => {
    const found = findCodexTranscriptPath("codex-worktree-1", codexSessionsRoot);
    if (found === null) {
      throw new Error("missing Codex transcript fixture");
    }

    const stopPayload = parseCodexStopPayload({
      session_id: "codex-worktree-1",
      cwd: "/Users/example/foreman-worktrees/codex-stop"
    });
    const parsed = parseCodexTranscriptFile(found, { stopPayload });

    expect(parsed.source).toBe("codex");
    expect(parsed.source_session_id).toBe("codex-worktree-1");
    expect(parsed.started_at).toBe("2026-05-06T10:00:00.000Z");
    expect(parsed.ended_at).toBe("2026-05-06T10:03:00.000Z");
    expect(parsed.project_path).toBe("/Users/example/foreman-worktrees/codex-stop");
    expect(parsed.repo_remote).toBe("git@example.com:mkdevforge/foreman.git");
    expect(parsed.model).toBe("gpt-5.3-codex");

    expect(parsed.prompts).toEqual([
      {
        ts: "2026-05-06T10:00:10.000Z",
        content: "Parse Codex events."
      }
    ]);

    expect(parsed.tool_calls).toHaveLength(2);
    expect(parsed.tool_calls[0]).toEqual({
      ts: "2026-05-06T10:01:00.000Z",
      tool_name: "exec_command",
      params_json: "{\"cmd\":\"rg parser src\"}",
      result_json: "{\"output\":{\"exit_code\":0,\"stdout\":\"src/ingest/codex.ts\"},\"is_error\":false}",
      is_error: false
    });
    expect(parsed.tool_calls[1]).toEqual({
      ts: "2026-05-06T10:02:00.000Z",
      tool_name: "web_search",
      params_json: "{\"query\":\"Codex hooks JSONL\"}",
      result_json: null,
      is_error: false
    });

    expect(parsed.usage).toEqual({
      input_tokens: 700,
      output_tokens: 300,
      cache_read_tokens: 20,
      cache_creation_tokens: 5
    });
    expect(parsed.summary_input).toContain("Parse Codex events.");
    expect(parsed.summary_input).toContain("Tool result exec_command");
    expect(parsed.summary_input).toContain("Codex transcript parsing is ready.");
    expect(parsed.warnings).toEqual([]);
  });

  test("falls back to the latest Codex turn_context cwd when Stop payload cwd is absent", () => {
    const parsed = parseCodexTranscriptFile(codexTranscriptPath);

    expect(parsed.project_path).toBe("/Users/example/foreman-worktrees/codex-feature");
  });
});
