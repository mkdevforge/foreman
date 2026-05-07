import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openForemanDatabase } from "../../src/db/client";
import { getSessionSummary, getSessionUsage } from "../../src/db/session-queries";
import {
  FOREMAN_SUMMARY_CHILD_ENV,
  createHarnessSummaryProvider,
  estimateUsageCost,
  ingestParsedSessionWithDerivedData,
  parseCodexTranscriptFile,
  truncateSummaryInput,
  type HarnessCommand,
  type ParsedSession,
  type SummaryProvider,
  type SummaryRequest
} from "../../src/ingest";

const fixturesDir = fileURLToPath(new URL("../fixtures/ingest/", import.meta.url));
const codexTranscriptPath = join(fixturesDir, "codex", "sessions", "2026", "05", "codex-session.jsonl");
const tempDirs: string[] = [];

describe("Phase 3c summary, truncation, and pricing", () => {
  test("uses a mocked summary provider, upserts summary, and stores known model cost", async () => {
    const { db } = openTempDatabase();
    const parsed = parseCodexTranscriptFile(codexTranscriptPath);
    const requests: SummaryRequest[] = [];
    const summaryProvider = fakeSummaryProvider((request) => {
      requests.push(request);
      return {
        summary_md: `# Summary\n\n${request.source} ${request.source_session_id}`,
        model_used: "fake-summary-model"
      };
    });

    try {
      const result = await ingestParsedSessionWithDerivedData(db, parsed, {
        ...testIngestOptions(),
        summaryProvider
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].prompt).toContain("Summarize this completed Foreman coding session.");
      expect(requests[0].transcript).toContain("Parse Codex events.");
      expect(result.summary_upserted).toBe(true);
      expect(result.summary_truncated).toBe(false);
      expect(result.cost_usd).toBeCloseTo(0.00543725, 12);
      expect(result.pricing_model).toBe("gpt-5.3-codex");
      expect(result.warnings).toEqual([]);
      expect(getSessionUsage(db, result.session_id)?.cost_usd).toBeCloseTo(0.00543725, 12);
      expect(getSessionSummary(db, result.session_id)).toEqual({
        summary_md: "# Summary\n\ncodex codex-worktree-1",
        model_used: "fake-summary-model",
        generated_at: "2026-05-06T12:00:00.000Z"
      });
    } finally {
      db.close();
    }
  });

  test("re-running derived ingestion overwrites one summary row instead of duplicating summaries", async () => {
    const { db } = openTempDatabase();
    const parsed = parseCodexTranscriptFile(codexTranscriptPath);
    let next = 1;
    const summaryProvider = fakeSummaryProvider(() => ({
      summary_md: `summary ${next++}`,
      model_used: "fake-summary-model"
    }));

    try {
      const first = await ingestParsedSessionWithDerivedData(db, parsed, {
        ...testIngestOptions(),
        summaryProvider
      });
      const second = await ingestParsedSessionWithDerivedData(db, parsed, {
        ...testIngestOptions(),
        summaryProvider
      });

      expect(second.session_id).toBe(first.session_id);
      expect(second.session_created).toBe(false);
      expect(countRows(db, "summaries")).toBe(1);
      expect(getSessionSummary(db, first.session_id)?.summary_md).toBe("summary 2");
    } finally {
      db.close();
    }
  });

  test("truncates summary input with deterministic head and tail preservation", () => {
    const input = `HEAD-${"a".repeat(200)}-TAIL`;
    const result = truncateSummaryInput(input, { maxTokens: 80, charsPerToken: 1 });

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(80);
    expect(result.text).toStartWith("HEAD-");
    expect(result.text).toEndWith("-TAIL");
    expect(result.text).toContain("[... ");
    expect(result.text).toContain(" chars elided ...]");
    expect(result.elided_chars).toBe(input.length - result.kept_chars);
  });

  test("returns warning and stores cost zero for unknown pricing models", async () => {
    const { db } = openTempDatabase();
    const parsed: ParsedSession = {
      ...parseCodexTranscriptFile(codexTranscriptPath),
      model: "unknown-model"
    };

    try {
      const result = await ingestParsedSessionWithDerivedData(db, parsed, {
        ...testIngestOptions(),
        summaryProvider: fakeSummaryProvider(() => ({
          summary_md: "summary",
          model_used: "fake-summary-model"
        }))
      });

      expect(result.cost_usd).toBe(0);
      expect(result.pricing_model).toBeNull();
      expect(result.warnings).toContain("no v0 pricing entry for model unknown-model; stored cost_usd = 0");
      expect(getSessionUsage(db, result.session_id)?.cost_usd).toBe(0);
    } finally {
      db.close();
    }
  });

  test("warns when known model usage has no token counts", () => {
    const estimate = estimateUsageCost("gpt-5.4-mini", {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0
    });

    expect(estimate).toEqual({
      cost_usd: 0,
      pricing_model: "gpt-5.4-mini",
      warnings: ["cannot estimate cost for model gpt-5.4-mini because usage tokens are all zero"]
    });
  });

  test("harness summary provider builds guarded Claude and Codex subprocess commands", async () => {
    const commands: HarnessCommand[] = [];
    const provider = createHarnessSummaryProvider({
      claudeCommand: "claude-bin",
      claudeModel: "haiku",
      codexCommand: "codex-bin",
      codexModel: "gpt-5.4-mini",
      timeoutMs: 1234,
      runner: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout:
            command.stdoutFormat === "codex-json"
              ? '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Harness summary"}}\n'
              : "Harness summary\n",
          stderr: ""
        };
      }
    });

    await provider.summarize(summaryRequestFixture("claude-code"));
    await provider.summarize(summaryRequestFixture("codex"));

    expect(commands[0].command).toBe("claude-bin");
    expect(commands[0].args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--input-format",
      "text",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--tools",
      ""
    ]);
    expect(commands[0].stdoutFormat).toBe("plain-text");
    expect(commands[0].env[FOREMAN_SUMMARY_CHILD_ENV]).toBe("1");
    expect(commands[0].timeoutMs).toBe(1234);
    expect(commands[0].stdin).toContain("Summary prompt");

    expect(commands[1].command).toBe("codex-bin");
    expect(commands[1].args).toEqual([
      "--disable",
      "plugins",
      "--ask-for-approval",
      "never",
      "exec",
      "--model",
      "gpt-5.4-mini",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "-"
    ]);
    expect(commands[1].stdoutFormat).toBe("codex-json");
    expect(commands[1].env[FOREMAN_SUMMARY_CHILD_ENV]).toBe("1");
    expect(commands[1].cwd).toBe("/tmp/project");
  });

  test("harness summary provider finds Claude in user bin dirs when PATH misses it", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "foreman-harness-home-"));
    tempDirs.push(homeDir);
    const userBinDir = join(homeDir, ".local", "bin");
    const claudeBin = join(userBinDir, "claude");
    mkdirSync(userBinDir, { recursive: true });
    writeFileSync(claudeBin, "#!/bin/sh\n");
    chmodSync(claudeBin, 0o755);

    const commands: HarnessCommand[] = [];
    const provider = createHarnessSummaryProvider({
      env: { HOME: homeDir, PATH: "" },
      runner: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: "Harness summary\n",
          stderr: ""
        };
      }
    });

    await provider.summarize(summaryRequestFixture("claude-code"));

    expect(commands[0].command).toBe(claudeBin);
    expect(commands[0].env.HOME).toBe(homeDir);
    expect(commands[0].env[FOREMAN_SUMMARY_CHILD_ENV]).toBe("1");
  });

  test("harness summary provider extracts Codex agent messages from JSONL stdout", async () => {
    const provider = createHarnessSummaryProvider({
      runner: async (command) => ({
        exitCode: 0,
        stdout: [
          "non-json diagnostic line",
          '{"type":"thread.started","thread_id":"thread-1"}',
          '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"First summary"}}',
          '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Final summary"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
        ].join("\n"),
        stderr: ""
      })
    });

    const result = await provider.summarize(summaryRequestFixture("codex"));

    expect(result.summary_md).toBe("Final summary");
  });
});

function openTempDatabase(): { db: Database; homeDir: string } {
  const homeDir = mkdtempSync(join(tmpdir(), "foreman-summary-test-"));
  tempDirs.push(homeDir);
  return { db: openForemanDatabase({ homeDir }), homeDir };
}

function testIngestOptions() {
  return {
    userEmail: "dev@example.com",
    machine: "devbox",
    idGenerator: deterministicIds(),
    now: () => "2026-05-06T12:00:00.000Z"
  };
}

function deterministicIds(): () => string {
  let next = 1;
  return () => `00000000-0000-7000-8000-${String(next++).padStart(12, "0")}`;
}

function fakeSummaryProvider(
  summarize: (request: SummaryRequest) => { summary_md: string; model_used: string; warnings?: string[] }
): SummaryProvider {
  return {
    async summarize(request) {
      return summarize(request);
    }
  };
}

function summaryRequestFixture(source: "claude-code" | "codex"): SummaryRequest {
  return {
    source,
    source_session_id: `${source}-session`,
    project_path: "/tmp/project",
    model: null,
    prompt: "Summary prompt",
    transcript: "Transcript",
    truncated: false,
    elided_chars: 0
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
