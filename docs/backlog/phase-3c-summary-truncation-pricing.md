# Phase 3c: Summary, Truncation, And Pricing

Backlog review: Reviewed.

## Goal

Add derived session data on top of parsed and persisted sessions: summary generation through a provider boundary, deterministic transcript truncation, and v0 cost calculation. Tests must not require network access or installed agent harnesses.

## Resolved Decisions

- Summary provider for v0: use a harness-backed provider by default, not direct API SDK calls. Claude Code sessions should summarize through the Claude harness with a lightweight Haiku-class model. Codex sessions should summarize through the Codex harness with the configured lightweight model, initially `gpt-5.4-mini` where explicit model selection is available. Tests use a fake provider.
- Summary truncation strategy details: use deterministic head + tail truncation over the rendered summary input with an explicit elision marker. Use approximate token budgeting based on `ceil(chars / 4)`, following the same broad approach used by the Claude-mem reference, but do not copy Claude-mem's recent-history-only truncation because Foreman needs both session setup and final outcome.
- Pricing table scope and location: keep a hardcoded API-list-price estimate table in a compact pricing module such as `src/ingest/pricing.ts`. The stored `cost_usd` is an estimate based on public/API pricing, not guaranteed actual enterprise or local harness billing.

## Scope

- Implement `src/ingest/summarize.ts` or equivalent summary boundary.
- Add a mocked summary provider path for tests.
- Add a production harness summary provider boundary for Claude and Codex.
- Build summary input from parsed transcript content.
- Implement head + tail truncation with an explicit elision marker.
- Upsert summaries because summaries are derived.
- Implement pricing calculation for known v0 models.
- Log or return warnings for unknown pricing models without failing ingestion.
- Store `cost_usd = 0` for unknown pricing models.
- Keep pricing hardcoded for v0 with a clear migration comment.

## Out Of Scope

- Parser fixture expansion except where needed for summary/pricing tests.
- Hook binaries reading real stdin and swallowing errors.
- Active chunk linkage.
- Hook installation.
- Review and catalog commands.
- User-configurable pricing files.
- Direct Anthropic/OpenAI SDK provider implementations.
- Exact enterprise billing reconciliation.

## Implementation Notes

- External summary providers must be injectable and mocked in automated tests.
- The first production provider adapter should call the corresponding local agent harness, not a provider SDK.
- The provider interface should be small enough that a direct API adapter can be added later without changing ingestion code.
- Harness summary subprocesses must set a recursion guard environment variable, such as `FOREMAN_SUMMARY_CHILD=1`, so Phase 4 hooks can skip Foreman-generated summary sessions.
- If a harness does not expose reliable explicit model selection, use the harness's configured lightweight/default model and record the model returned by the transcript or provider result when available.
- Summary overwrite is allowed because summaries are derived data.
- Keep the truncation algorithm deterministic and easy to test.
- Prefer a compact pricing table module over mixing pricing into parsers.
- Pricing should use input and output token counts where available. If the parsed transcript lacks enough usage detail for a known model, return a warning and store `cost_usd = 0`.

## Test Checkpoint

The phase is complete when automated tests cover:

- Mocked summary provider without network access.
- Summary upsert.
- Head + tail truncation with elision marker.
- Known model cost calculation.
- Unknown model warning behavior.
- Unknown model cost stored as `0`.
- Re-running ingestion does not duplicate summaries.

Manual smoke test:

```sh
bun test tests/ingest
```

## Done Criteria

- Phase 3c checkpoint passes.
- `docs/backlog/progress.md` marks Phase 3c as `Done`.
- Phase 3 is considered complete after 3a, 3b, and 3c are all `Done`.
