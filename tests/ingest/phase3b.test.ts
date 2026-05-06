import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionById, getSessionUsage, listSessionPrompts, listSessionToolCalls } from "../../src/db/session-queries";
import { openForemanDatabase } from "../../src/db/client";
import {
  hashPromptContent,
  hashToolCallParams,
  ingestParsedSession,
  parseClaudeCodeStopPayload,
  parseClaudeCodeTranscriptFile,
  parseCodexTranscriptFile,
  type ParsedSession
} from "../../src/ingest";

const fixturesDir = fileURLToPath(new URL("../fixtures/ingest/", import.meta.url));
const claudeTranscriptPath = join(fixturesDir, "claude-code-session.jsonl");
const codexTranscriptPath = join(fixturesDir, "codex", "sessions", "2026", "05", "codex-session.jsonl");
const tempDirs: string[] = [];

describe("Phase 3b common ingestion", () => {
  test("persists a parsed Claude Code session with hashes, origin stamps, usage, and interrupted tool calls", () => {
    const { db } = openTempDatabase();
    const parsed = parseClaudeCodeTranscriptFile(claudeTranscriptPath, {
      stopPayload: parseClaudeCodeStopPayload({
        session_id: "claude-worktree-1",
        transcript_path: claudeTranscriptPath,
        cwd: "/Users/example/foreman-worktrees/claude-feature",
        hook_event_name: "Stop"
      })
    });

    try {
      const result = ingestParsedSession(db, parsed, testIngestOptions());
      const session = getSessionById(db, result.session_id, true);
      const usage = getSessionUsage(db, result.session_id);
      const prompts = listSessionPrompts(db, result.session_id);
      const toolCalls = listSessionToolCalls(db, result.session_id);

      expect(result).toEqual({
        session_id: "00000000-0000-7000-8000-000000000001",
        session_created: true,
        prompts_inserted: 1,
        tool_calls_inserted: 2,
        usage_upserted: true,
        warnings: []
      });
      expect(session?.source).toBe("claude-code");
      expect(session?.source_session_id).toBe("claude-worktree-1");
      expect(session?.project_path).toBe("/Users/example/foreman-worktrees/claude-feature");
      expect(session?.machine).toBe("devbox");
      expect(session?.user_email).toBe("dev@example.com");
      expect(session?.created_at).toBe("2026-05-06T12:00:00.000Z");
      expect(usage).toEqual({
        input_tokens: 1500,
        output_tokens: 300,
        cache_read_tokens: 50,
        cache_creation_tokens: 10,
        cost_usd: 0
      });
      expect(prompts[0].content_hash).toBe(hashPromptContent("Implement parser fixtures."));
      expect(toolCalls[0].params_hash).toBe(
        hashToolCallParams({
          tool_name: "Read",
          params_json: "{\"file_path\":\"src/cli/runtime.ts\"}"
        })
      );
      expect(toolCalls[1].result_json).toBeNull();
      expect(toolCalls[1].is_error).toBe(false);
    } finally {
      db.close();
    }
  });

  test("persists a parsed Codex session and preserves the actual worktree project path", () => {
    const { db } = openTempDatabase();
    const parsed = parseCodexTranscriptFile(codexTranscriptPath);

    try {
      const result = ingestParsedSession(db, parsed, testIngestOptions());
      const session = getSessionById(db, result.session_id, true);

      expect(result.session_created).toBe(true);
      expect(session?.source).toBe("codex");
      expect(session?.source_session_id).toBe("codex-worktree-1");
      expect(session?.project_path).toBe("/Users/example/foreman-worktrees/codex-feature");
      expect(session?.repo_remote).toBe("git@example.com:mkdevforge/foreman.git");
      expect(session?.model).toBe("gpt-5.3-codex");
    } finally {
      db.close();
    }
  });

  test("re-running ingestion reuses the session and does not duplicate prompts or tool calls", () => {
    const { db } = openTempDatabase();
    const idGenerator = deterministicIds();
    const parsed = parseClaudeCodeTranscriptFile(claudeTranscriptPath, {
      stopPayload: parseClaudeCodeStopPayload({
        session_id: "claude-worktree-1",
        transcript_path: claudeTranscriptPath,
        cwd: "/Users/example/foreman-worktrees/claude-feature",
        hook_event_name: "Stop"
      })
    });

    try {
      const first = ingestParsedSession(db, parsed, testIngestOptions({ idGenerator }));
      const second = ingestParsedSession(db, parsed, testIngestOptions({ idGenerator }));

      expect(second.session_id).toBe(first.session_id);
      expect(second.session_created).toBe(false);
      expect(second.prompts_inserted).toBe(0);
      expect(second.tool_calls_inserted).toBe(0);
      expect(countRows(db, "sessions")).toBe(1);
      expect(countRows(db, "prompts")).toBe(1);
      expect(countRows(db, "tool_calls")).toBe(2);
      expect(countRows(db, "usage")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("deduplicates prompts and tool calls within one parsed session by content hashes and timestamps", () => {
    const { db } = openTempDatabase();
    const parsed = duplicatePromptAndToolCall(parsedSessionFixture());

    try {
      const result = ingestParsedSession(db, parsed, testIngestOptions());

      expect(result.prompts_inserted).toBe(1);
      expect(result.tool_calls_inserted).toBe(1);
      expect(countRows(db, "prompts")).toBe(1);
      expect(countRows(db, "tool_calls")).toBe(1);
    } finally {
      db.close();
    }
  });

  test("hashes tool-call parameters with stable JSON object key ordering", () => {
    const first = hashToolCallParams({
      tool_name: "exec_command",
      params_json: "{\"b\":1,\"a\":2}"
    });
    const second = hashToolCallParams({
      tool_name: "exec_command",
      params_json: "{\"a\":2,\"b\":1}"
    });
    const differentTool = hashToolCallParams({
      tool_name: "read_file",
      params_json: "{\"a\":2,\"b\":1}"
    });

    expect(first).toBe(second);
    expect(first).not.toBe(differentTool);
  });

  test("upserts usage totals on an existing session", () => {
    const { db } = openTempDatabase();
    const parsed = parsedSessionFixture();
    const updated: ParsedSession = {
      ...parsed,
      usage: {
        input_tokens: 900,
        output_tokens: 100,
        cache_read_tokens: 80,
        cache_creation_tokens: 70
      }
    };

    try {
      const first = ingestParsedSession(db, parsed, testIngestOptions());
      ingestParsedSession(db, updated, testIngestOptions());

      expect(getSessionUsage(db, first.session_id)).toEqual({
        input_tokens: 900,
        output_tokens: 100,
        cache_read_tokens: 80,
        cache_creation_tokens: 70,
        cost_usd: 0
      });
    } finally {
      db.close();
    }
  });

  test("returns parser and ingestion warnings without failing ingestion", () => {
    const { db } = openTempDatabase();
    const parsed: ParsedSession = {
      ...parsedSessionFixture(),
      warnings: ["parser warning"],
      tool_calls: [
        {
          ts: "2026-05-06T12:01:00.000Z",
          tool_name: "broken",
          params_json: "{not-json",
          result_json: null,
          is_error: false
        }
      ]
    };

    try {
      const result = ingestParsedSession(db, parsed, testIngestOptions());

      expect(result.session_created).toBe(true);
      expect(result.tool_calls_inserted).toBe(1);
      expect(result.warnings).toEqual([
        "parser warning",
        "tool call broken has invalid params_json; hashed raw params_json"
      ]);
    } finally {
      db.close();
    }
  });
});

function openTempDatabase(): { db: Database; homeDir: string } {
  const homeDir = mkdtempSync(join(tmpdir(), "foreman-ingest-test-"));
  tempDirs.push(homeDir);
  return { db: openForemanDatabase({ homeDir }), homeDir };
}

function testIngestOptions(overrides: { idGenerator?: () => string } = {}) {
  return {
    userEmail: "dev@example.com",
    machine: "devbox",
    idGenerator: overrides.idGenerator ?? deterministicIds(),
    now: () => "2026-05-06T12:00:00.000Z"
  };
}

function deterministicIds(): () => string {
  let next = 1;
  return () => `00000000-0000-7000-8000-${String(next++).padStart(12, "0")}`;
}

function parsedSessionFixture(): ParsedSession {
  return {
    source: "codex",
    source_session_id: "dedupe-session",
    started_at: "2026-05-06T12:00:00.000Z",
    ended_at: "2026-05-06T12:02:00.000Z",
    project_path: "/Users/example/foreman-worktrees/dedupe",
    repo_remote: null,
    model: "gpt-5.3-codex",
    prompts: [
      {
        ts: "2026-05-06T12:00:10.000Z",
        content: "Do one thing."
      }
    ],
    tool_calls: [
      {
        ts: "2026-05-06T12:01:00.000Z",
        tool_name: "exec_command",
        params_json: "{\"cmd\":\"bun test\"}",
        result_json: "{\"exit_code\":0}",
        is_error: false
      }
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_creation_tokens: 0
    },
    summary_input: "Do one thing.",
    warnings: []
  };
}

function duplicatePromptAndToolCall(parsed: ParsedSession): ParsedSession {
  return {
    ...parsed,
    prompts: [parsed.prompts[0], { ...parsed.prompts[0] }],
    tool_calls: [parsed.tool_calls[0], { ...parsed.tool_calls[0] }]
  };
}

function countRows(db: Database, table: string): number {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});
