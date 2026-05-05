# Foreman v0 Backlog Progress

Source PRD: [Foreman POC PRD](../foreman-poc-prd.md)

This tracker is the single status file for the v0 backlog. Update it whenever a phase starts, finishes, changes scope, or records a decision. Phase files contain the implementation details and test checkpoints.

## Status Legend

- `Not started`: No implementation work has begun.
- `In progress`: Work has started but the phase checkpoint has not passed.
- `Blocked`: Work cannot continue without a decision or dependency.
- `Done`: The phase checkpoint passed and the result is committed.

## Phase Progress

| Phase | File | Status | Checkpoint |
| --- | --- | --- | --- |
| 0 | [Project foundation](phase-0-project-foundation.md) | Not started | Bun/TypeScript project builds, tests run, CLI dispatch exists. |
| 1a | [Repo task store](phase-1a-repo-task-store.md) | Not started | `.foreman/tasks/*.yaml` can be initialized, created, listed, and shown. |
| 1b | [Chunk lifecycle](phase-1b-chunk-lifecycle.md) | Not started | Chunks can change status/stage and append review notes. |
| 2 | [Session database](phase-2-session-database.md) | Not started | SQLite schema, migrations, and seeded session reads work. |
| 3 | [Transcript ingestion](phase-3-transcript-ingestion.md) | Not started | Claude Code and Codex fixture transcripts ingest idempotently with mocked summaries. |
| 4 | [Hooks and active linkage](phase-4-hooks-active-linkage.md) | Not started | Stop hooks install idempotently, never block on errors, and link active chunks. |
| 5 | [Review and catalog CLI](phase-5-review-catalog-cli.md) | Not started | Review, catalog, and session cost commands join repo YAML with session DB. |
| 6 | [v0 hardening](phase-6-v0-hardening.md) | Not started | All v0 acceptance criteria pass in automated and manual end-to-end checks. |

## Decision Gates

Track implementation-blocking decisions here. Close each decision before implementing the dependent phase.

| Decision | Needed By | Status | Notes |
| --- | --- | --- | --- |
| Optional task YAML field representation | Phase 1a | Closed 2026-05-05 | Write absent `source_ref` and `description` as explicit YAML `null`; JSON output exposes explicit nullable fields. |
| Task and chunk identifier rules | Phase 1a | Closed 2026-05-05 | Task IDs match `[A-Za-z0-9][A-Za-z0-9._-]*` and preserve case; chunk IDs match `[a-z0-9][a-z0-9-]*`. |
| Note author fallback | Phase 1b | Closed 2026-05-05 | `chunk note` uses `git config user.email` by default, allows `--author <email>`, and errors if neither is available. |
| Summary provider for v0 | Phase 3 | Open | PRD recommends Anthropic Haiku for all summaries, but implementation should record the final choice before coding provider bindings. |
| Codex hook config location | Phase 4 | Open | PRD requires checking current Codex hook docs at implementation time and choosing one consistent config format. |
| Summary truncation strategy details | Phase 3 | Open | PRD recommends head + tail with an elision marker and an approximate 50k-token cap. |
| Codex tool-call pairing format | Phase 3 | Open | Must be documented from actual Codex JSONL fixtures or current docs before parser behavior is finalized. |
| Active context staleness policy | Phase 4 | Open | PRD recommends ignoring active context older than 24 hours. Record final behavior before hook linkage tests are written. |
| Pricing table scope and location | Phase 3 | Open | PRD allows inline hardcoded pricing for v0 with a migration path comment. |

## Acceptance Criteria Map

| PRD AC | Covered By | Status |
| --- | --- | --- |
| 1. `bun install && bun run build` produces working hook + CLI scripts. | Phases 0, 6 | Not started |
| 2. `foreman install` registers Claude Code and Codex Stop hooks idempotently. | Phases 4, 6 | Not started |
| 3. `foreman init` creates `.foreman/` in the current repo. | Phase 1a | Not started |
| 4. `task add` and `chunk add` create well-formed YAML that round-trips. | Phase 1a | Not started |
| 5. Claude Code Stop hook ingests and links an active chunk. | Phases 3, 4, 6 | Not started |
| 6. Codex Stop hook ingests and links an active chunk. | Phases 3, 4, 6 | Not started |
| 7. `foreman review <task>/<chunk>` shows chunk metadata plus linked sessions. | Phase 5 | Not started |
| 8. `foreman catalog` lists unattached sessions and supports interactive linking. | Phase 5 | Not started |
| 9. `foreman session cost --by source` reports a correct source breakdown. | Phase 5 | Not started |
| 10. All commands have valid `--json` mode. | Phases 0, 1a, 1b, 2, 5, 6 | Not started |
| 11. Re-running hooks does not duplicate stored rows or links. | Phases 3, 4 | Not started |
| 12. Hooks log failures and exit 0. | Phase 4 | Not started |
| 13. Basic test suite covers parsers, migrations, dedup, soft linkage, catalog flow, and output shape. | Phases 1a, 1b, 2-6 | Not started |

## Maintenance Rules

- Keep phase files scoped to v0. Move non-v0 ideas to a future backlog only after v0 scope is stable.
- Do not mark a phase `Done` until its checkpoint has passed and the change is committed.
- When scope changes, update this file and the affected phase file in the same commit.
- When a decision gate closes, record the decision and the date in this file before implementing code that depends on it.
