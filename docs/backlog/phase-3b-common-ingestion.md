# Phase 3b: Common Ingestion

Backlog review: Reviewed.

## Goal

Persist parsed sessions from Phase 3a into the user SQLite database idempotently. This phase proves the common ingestion path without summary provider complexity, pricing, real hook behavior, active chunk linkage, or catalog/review commands.

## Scope

- Implement `src/ingest/common.ts` for source-agnostic ingestion.
- Find or create sessions by `(source, source_session_id)`.
- Generate internal session, prompt, and tool-call IDs.
- Store session metadata from `ParsedSession`.
- Store `project_path` as the actual session worktree path.
- Store prompts using content hashes.
- Store tool calls using parameter/content hashes.
- Upsert usage totals.
- Preserve idempotency on re-run.
- Capture ingestion warnings for callers/tests.
- Add test-only helpers/fixtures as needed.
- Add `uuid` as the UUID implementation dependency.

## Parsed Input Shape

Phase 3b consumes the Phase 3a `ParsedSession` shape. Prompt and tool-call inputs should be persistence-free:

```ts
interface ParsedPrompt {
  ts: string;
  content: string;
}

interface ParsedToolCall {
  ts: string;
  tool_name: string;
  params_json: string;
  result_json: string | null;
  is_error: boolean;
}
```

Phase 3b derives database IDs and hashes from these records.

## Out Of Scope

- Transcript parsing changes beyond small parser shape adjustments.
- Summary generation or summary upsert.
- Summary truncation.
- Pricing and cost calculation.
- Hook binaries reading real stdin and swallowing errors.
- Active chunk linkage.
- Hook installation.
- Review and catalog commands.
- Interactive worktree creation.

## Implementation Notes

- Use `INSERT ... ON CONFLICT DO NOTHING` for prompt/tool-call dedupe.
- Reuse the existing session row when `(source, source_session_id)` already exists.
- Use the DB unique constraints as the idempotency boundary.
- Keep ingestion helpers shaped by parsed sessions, not future hook assumptions.
- Store interrupted tool calls with `result_json = null` and `is_error = 0`.
- Do not duplicate prompts, tool calls, usage, summaries, or sessions when re-ingesting the same parsed session.
- Default production ID generation uses `uuid`'s `v7()` API.
- Tests should inject deterministic ID generation rather than relying on real UUID randomness.
- Do not implement a first-party UUIDv7 generator.
- Use SHA-256 from `node:crypto` for content hashes.
- Prompt hashes are based on prompt content.
- Tool-call hashes are based on stable JSON for the tool name and parameters.
- Store UUIDs in SQLite as canonical `TEXT` values; SQLite does not need a native UUID type.
- Return warnings from ingestion; hook logging is Phase 4 behavior.

## Worktree Stance

Ingestion records the session's actual worktree path in `sessions.project_path`. It should not require the parsed session to come from the same filesystem root as the Foreman task YAML. Sibling worktrees should therefore ingest normally; linking those sessions to task chunks is Phase 4/5 behavior.

## Test Checkpoint

The phase is complete when automated tests cover:

- Persisting a parsed Claude Code session.
- Persisting a parsed Codex session.
- Re-running ingestion for the same `(source, source_session_id)` without duplicate sessions.
- Prompt deduplication by `(session_id, content_hash, ts)`.
- Tool-call deduplication by `(session_id, params_hash, ts)`.
- Usage upsert.
- Interrupted tool-call persistence.
- Worktree-shaped `project_path` stored exactly.
- Warning capture does not fail ingestion.

Manual smoke test:

```sh
bun test tests/ingest
```

## Done Criteria

- Phase 3b checkpoint passes.
- `docs/backlog/progress.md` marks Phase 3b as `Done`.
- Production summary/provider work is still deferred to Phase 3c.
