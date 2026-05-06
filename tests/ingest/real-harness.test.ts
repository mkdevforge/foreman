import { describe, expect, test } from "bun:test";
import { createHarnessSummaryProvider, type SummaryRequest } from "../../src/ingest";

const runRealHarnessTests = process.env.FOREMAN_REAL_HARNESS_TESTS === "1";
const realHarnessTest = runRealHarnessTests ? test : test.skip;

describe("Phase 3c real summary harness smoke", () => {
  realHarnessTest("summarizes through the installed Claude Code CLI", async () => {
    const result = await createHarnessSummaryProvider({ timeoutMs: 180_000 }).summarize(
      realHarnessRequest("claude-code", "FOREMAN_CLAUDE_SMOKE_OK")
    );

    expect(result.summary_md).toContain("FOREMAN_CLAUDE_SMOKE_OK");
    expect(result.model_used).toBe("haiku");
  });

  realHarnessTest("summarizes through the installed Codex CLI", async () => {
    const result = await createHarnessSummaryProvider({ timeoutMs: 180_000 }).summarize(
      realHarnessRequest("codex", "FOREMAN_CODEX_SMOKE_OK")
    );

    expect(result.summary_md).toContain("FOREMAN_CODEX_SMOKE_OK");
    expect(result.model_used).toBe("gpt-5.4-mini");
  });
});

function realHarnessRequest(source: SummaryRequest["source"], sentinel: string): SummaryRequest {
  return {
    source,
    source_session_id: `${source}-real-harness-smoke`,
    project_path: process.cwd(),
    model: null,
    prompt: `Return exactly this text and nothing else: ${sentinel}`,
    transcript: "Local smoke test for Foreman's summary harness provider.",
    truncated: false,
    elided_chars: 0
  };
}
