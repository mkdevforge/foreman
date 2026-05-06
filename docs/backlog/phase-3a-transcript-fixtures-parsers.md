# Phase 3a: Transcript Fixtures And Parsers

Backlog review: Reviewed.

## Goal

Turn source-specific Stop payloads and transcript files into one normalized in-memory parsed session. This phase proves Foreman can understand Claude Code and Codex transcripts without SQLite writes, summary generation, pricing, hook installation, or active chunk linkage.

## Decision Gates

Close these in `docs/backlog/progress.md` before implementation starts:

- Codex tool-call pairing format.

## Normalized Parsed Session

The parser output should stay source-agnostic and persistence-free:

```ts
interface ParsedSession {
  source: "claude-code" | "codex";
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
```

`project_path` is the actual session worktree path from the payload or transcript. Do not collapse sibling Git worktrees to a single control repo path during parsing.

Internal UUIDs, content hashes, machine/user origin stamps, and database row IDs belong in Phase 3b.

## Scope

- Add small first-party fixtures under `tests/fixtures/ingest/`.
- Implement a source-agnostic parsed session type.
- Implement Claude Code Stop payload parsing.
- Implement Claude Code JSONL transcript parsing from fixtures.
- Extract Claude user prompts.
- Extract Claude assistant `tool_use` blocks.
- Pair Claude `tool_use` and `tool_result` blocks by `tool_use_id`.
- Preserve interrupted Claude tool calls with `result_json = null` and `is_error = false`.
- Implement Codex Stop payload parsing.
- Locate or load Codex JSONL transcript fixtures by session id in tests.
- Parse Codex JSONL events from observed fixtures.
- Extract Codex prompts, tool calls, usage, model, and session metadata.
- Document Codex JSONL format assumptions near the parser tests.

## Out Of Scope

- SQLite writes.
- Idempotent persistence.
- UUIDv7 helpers.
- SHA-256 content hashes.
- Summary provider calls.
- Summary truncation.
- Pricing.
- Real hook binaries reading stdin and swallowing errors.
- Active chunk linkage.
- Hook installation.
- Worktree task metadata resolution beyond preserving the actual session `project_path`.

## Implementation Notes

- Do not import, copy, or vendor code from `references/claude-mem/`, `references/symphony/`, or external repositories.
- It is acceptable to study reference transcript shapes, then write first-party parser code.
- Keep parser fixtures small but representative.
- Include at least one interrupted tool call case per source where the source format can represent it.
- Treat unknown optional transcript fields as parser warnings where useful, not hard failures, unless they make required v0 fields impossible to produce.
- Codex pairing behavior must be based on actual observed JSONL fixtures, not guessed.

## Worktree Stance

Foreman v0 must support sessions run from Git worktrees. Phase 3a should preserve the actual agent/session worktree path as `project_path`. Later phases may resolve task YAML from a different Foreman control worktree; sibling worktrees are the preferred layout.

## Test Checkpoint

The phase is complete when automated tests cover:

- Claude Code fixture transcript parsing.
- Codex fixture transcript parsing.
- Claude tool-call pairing.
- Codex tool-call pairing.
- Interrupted tool calls.
- Usage/model extraction where available.
- Worktree-shaped `project_path` values round-trip through parser output.
- Codex format assumptions documented near tests.

Manual smoke test:

```sh
bun test tests/ingest
```

## Done Criteria

- Phase 3a checkpoint passes.
- `docs/backlog/progress.md` marks Phase 3a as `Done`.
- Parser behavior that depends on current Codex format is documented near the Codex parser tests.
