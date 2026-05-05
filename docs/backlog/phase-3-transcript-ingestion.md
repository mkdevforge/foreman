# Phase 3: Transcript Ingestion

## Goal

Implement source-specific transcript parsing and common ingestion so Claude Code and Codex sessions can be stored idempotently in SQLite. Summary generation should be wired through a provider boundary and mocked in tests.

## Decision Gates

Close these in `docs/backlog/progress.md` before implementation starts:

- Summary provider for v0.
- Summary truncation strategy details.
- Codex tool-call pairing format.
- Pricing table scope and location.

## Scope

- Implement `src/ingest/common.ts` for source-agnostic ingest flow:
  - find or create session by `(source, source_session_id)`
  - upsert prompts
  - upsert tool calls
  - upsert usage
  - upsert summaries
  - preserve idempotency on re-run
- Implement `src/ingest/claude-code.ts`:
  - parse Claude Code Stop payload fields
  - parse JSONL transcript from `transcript_path`
  - extract user prompts
  - extract assistant tool-use blocks
  - pair `tool_use` with `tool_result` by `tool_use_id`
  - extract usage totals and model where available
- Implement `src/ingest/codex.ts`:
  - parse Codex Stop payload fields
  - locate matching `~/.codex/sessions/**/*.jsonl` transcript by session id
  - parse Codex JSONL events from fixtures based on current format
  - extract prompts, tool calls, usage, model, and session metadata
- Implement `src/ingest/summarize.ts`:
  - provider boundary
  - transcript truncation
  - mocked summary path for tests
- Implement pricing calculation for known v0 models.
- Log unknown pricing models without failing ingestion.

## Out of Scope

- Hook binaries reading real stdin and swallowing errors.
- Active chunk linkage.
- Hook installation.
- Interactive catalog.

## Implementation Notes

- Do not import, copy, or vendor code from `references/claude-mem/` or external repositories.
- It is acceptable to study reference transcript shapes, then write first-party parser code.
- Store interrupted tool calls with `result_json = null` and `is_error = 0`.
- Use content hashes to deduplicate prompts and tool calls on repeated ingestion.
- Summary overwrite is allowed because summaries are derived data.
- Keep parser fixtures small but representative, including at least one interrupted tool call case.

## Test Checkpoint

The phase is complete when automated tests cover:

- Claude Code fixture transcript parsing.
- Codex fixture transcript parsing.
- Tool-call pairing for both sources.
- Interrupted tool calls.
- Usage and cost extraction.
- Unknown model pricing warning behavior.
- Summary provider mocked without network access.
- Re-running ingestion for the same `(source, source_session_id)` without duplicate prompts, tool calls, usage, summaries, or sessions.

Manual smoke test:

```sh
bun test tests/ingest
```

## Done Criteria

- Phase 3 checkpoint passes.
- `docs/backlog/progress.md` marks Phase 3 as `Done`.
- Parser behavior that depends on current Codex format is documented near the Codex parser tests.
