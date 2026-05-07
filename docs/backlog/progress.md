# Foreman v0 Backlog Progress

Source PRD: [Foreman POC PRD](../foreman-poc-prd.md)

This tracker is the single status file for the v0 backlog. Update it whenever a phase starts, finishes, changes scope, or records a decision. Phase files contain the implementation details and test checkpoints.

## Status Legend

- `Not started`: No implementation work has begun.
- `In progress`: Work has started but the phase checkpoint has not passed.
- `Blocked`: Work cannot continue without a decision or dependency.
- `Done`: The phase checkpoint passed and the result is committed.

## Backlog Review Legend

- `Reviewed`: The backlog slice has been discussed and is ready to implement after any listed decision gates are closed.
- `Unreviewed`: The backlog slice still needs a planning review before implementation starts.

## Phase Progress

| Phase | File | Status | Backlog review | Checkpoint |
| --- | --- | --- | --- | --- |
| 0 | [Project foundation](phase-0-project-foundation.md) | Done | Reviewed | Bun/TypeScript project builds, tests run, CLI dispatch exists. |
| 1a | [Repo task store](phase-1a-repo-task-store.md) | Done | Reviewed | `.foreman/tasks/*.yaml` can be initialized, created, listed, and shown. |
| 1c | [YAML extensibility guardrail](phase-1c-yaml-extensibility.md) | Done | Reviewed | v0 task/chunk mutations preserve unknown YAML fields for future dispatch metadata. |
| 1b | [Chunk lifecycle](phase-1b-chunk-lifecycle.md) | Done | Reviewed | Chunks can change status/stage and append review notes. |
| 2a | [SQLite schema](phase-2a-sqlite-schema.md) | Done | Reviewed | SQLite schema, migrations, indexes, and constraints work. |
| 2b | [Session query CLI](phase-2b-session-query-cli.md) | Done | Reviewed | Seeded session data can be listed, shown, filtered, and resolved by prefix. |
| 3a | [Transcript fixtures and parsers](phase-3a-transcript-fixtures-parsers.md) | Done | Reviewed | Claude Code and Codex fixture transcripts parse into normalized sessions. |
| 3b | [Common ingestion](phase-3b-common-ingestion.md) | Done | Reviewed | Parsed sessions persist idempotently into SQLite. |
| 3c | [Summary, truncation, and pricing](phase-3c-summary-truncation-pricing.md) | Done | Reviewed | Mocked summaries, truncation, pricing, and opt-in real harness smoke tests work. |
| 4 | [Hooks and active linkage](phase-4-hooks-active-linkage.md) | Done | Reviewed | Active context, Stop hooks, active linkage, and idempotent hook install work. |
| 5a | [Review CLI](phase-5a-review-cli.md) | Not started | Reviewed | Review commands join repo YAML with linked session summaries and costs. |
| 5b | [Catalog listing and one-shot linking](phase-5b-catalog-one-shot.md) | Not started | Reviewed | Unattached sessions can be listed, linked, and unlinked non-interactively. |
| 5c | [Interactive catalog](phase-5c-interactive-catalog.md) | Not started | Reviewed | Catalog prompt loop supports link, skip, and quit paths. |
| 5d | [Session cost CLI](phase-5d-session-cost.md) | Not started | Reviewed | Session cost reports group estimates by source, project, task, chunk, model, and day. |
| 6 | [v0 hardening](phase-6-v0-hardening.md) | Not started | Unreviewed | All v0 acceptance criteria pass in automated and manual end-to-end checks. |

## Post-v0 Backlog Seeds

These are intentionally outside v0, but v0 should avoid design choices that make them harder.

| Topic | File | Status | Notes |
| --- | --- | --- | --- |
| Dispatch and human gates | [future dispatch and human gates](future-dispatch-human-gates.md) | Seeded | Add a Symphony-style dispatch surface over Foreman chunks, with first-class questions, approvals, and blocked outcomes. |

## Decision Gates

Track implementation-blocking decisions here. Close each decision before implementing the dependent phase.

| Decision | Needed By | Status | Notes |
| --- | --- | --- | --- |
| Optional task YAML field representation | Phase 1a | Closed 2026-05-05 | Write absent `source_ref` and `description` as explicit YAML `null`; JSON output exposes explicit nullable fields. |
| Task and chunk identifier rules | Phase 1a | Closed 2026-05-05 | Task IDs match `[A-Za-z0-9][A-Za-z0-9._-]*` and preserve case; chunk IDs match `[a-z0-9][a-z0-9-]*`. |
| Task YAML extensibility policy | Phase 1c | Closed 2026-05-06 | v0 readers/writers validate known fields but preserve unknown task-level and chunk-level YAML fields for future dispatch metadata. |
| Note author fallback | Phase 1b | Closed 2026-05-05 | `chunk note` uses `git config user.email` by default, allows `--author <email>`, and errors if neither is available. |
| Duration filter syntax | Phase 2b | Closed 2026-05-05 | `--since` accepts compact relative durations with units `m`, `h`, `d`, and `w`, such as `30m`, `24h`, `7d`, or `2w`. |
| Worktree support policy | Phases 3a, 3b, 4, 5 | Closed 2026-05-06 | Store the actual session worktree path as `project_path`; task YAML may live in a separate Foreman control worktree, with sibling worktrees preferred. Later linkage/review must not assume session cwd and task metadata root are the same path. |
| UUID generation dependency | Phase 3b | Closed 2026-05-06 | Use the `uuid` package and its `v7()` API for production IDs. Tests inject deterministic ID generation. Do not hand-roll UUIDv7. |
| Summary provider for v0 | Phase 3c | Closed 2026-05-06 | Default to source-specific local harness providers rather than direct API SDK calls: Claude Code sessions through Claude with a lightweight Haiku-class model, Codex sessions through Codex with the configured lightweight model, initially `gpt-5.4-mini` where selectable. CI/default tests use a fake provider; local real harness smoke tests are opt-in. |
| Codex hook config location | Phase 4 | Closed 2026-05-06 | Current Codex docs support `hooks.json` and inline `[hooks]` but recommend one representation per config layer. Use user-level `~/.codex/hooks.json` for Stop hook commands and ensure `[features] codex_hooks = true` in `~/.codex/config.toml`. |
| Catalog repo identity policy | Phase 5b | Closed 2026-05-07 | Do not require remotes globally. Catalog defaults to current repo `remote.origin.url` when present and matches sessions by normalized `repo_remote`; if no remote exists, default scope falls back to exact current Git root path only. `--all` removes repo/project filtering. Hook ingestion should fill missing `repo_remote` from the session project path remote when available. |
| Summary truncation strategy details | Phase 3c | Closed 2026-05-06 | Use deterministic head + tail truncation over rendered summary input with an explicit elision marker and approximate token budgeting via `ceil(chars / 4)`. Claude-mem is precedent for approximate token caps, but its recent-history truncation is not a direct fit. |
| Codex tool-call pairing format | Phase 3a | Closed 2026-05-06 | Pair Codex tool-use/result events by `payload.call_id`. Tool-use event types are `function_call`, `custom_tool_call`, and `web_search_call`; result event types are `function_call_output` and `custom_tool_call_output`. Fixtures must document the observed event shape. |
| Active context staleness policy | Phase 4 | Closed 2026-05-06 | Active context older than 24 hours is stale for hook linkage. `foreman status` still reports stale context instead of hiding or auto-clearing it. |
| Pricing table scope and location | Phase 3c | Closed 2026-05-06 | Keep a hardcoded API-list-price estimate table in a compact pricing module such as `src/ingest/pricing.ts`. Stored `cost_usd` is an estimate, not guaranteed actual enterprise or local harness billing. |

## Acceptance Criteria Map

| PRD AC | Covered By | Status |
| --- | --- | --- |
| 1. `bun install && bun run build` produces working hook + CLI scripts. | Phases 0, 6 | Not started |
| 2. `foreman install` registers Claude Code and Codex Stop hooks idempotently. | Phases 4, 6 | Done |
| 3. `foreman init` creates `.foreman/` in the current repo. | Phase 1a | Done |
| 4. `task add` and `chunk add` create well-formed YAML that round-trips. | Phase 1a | Done |
| 4a. v0 task and chunk mutations preserve unknown YAML fields for future dispatch metadata. | Phases 1c, 1b, 6 | Done |
| 5. Claude Code Stop hook ingests and links an active chunk. | Phases 3a, 3b, 3c, 4, 6 | Done |
| 6. Codex Stop hook ingests and links an active chunk. | Phases 3a, 3b, 3c, 4, 6 | Done |
| 7. `foreman review <task>/<chunk>` shows chunk metadata plus linked sessions. | Phase 5a | Not started |
| 8. `foreman catalog` lists unattached sessions and supports interactive linking. | Phases 5b, 5c | Not started |
| 9. `foreman session cost --by source` reports a correct source breakdown. | Phase 5d | Not started |
| 10. All commands have valid `--json` mode. | Phases 0, 1a, 1b, 2b, 5a-5d, 6 | Not started |
| 11. Re-running hooks does not duplicate stored rows or links. | Phases 3b, 4 | Done |
| 12. Hooks log failures and exit 0. | Phase 4 | Done |
| 13. Basic test suite covers parsers, migrations, dedup, soft linkage, catalog flow, and output shape. | Phases 1a, 1b, 2a, 2b, 3a-6 | Not started |

## Maintenance Rules

- Keep phase files scoped to v0. Move non-v0 ideas to a future backlog only after v0 scope is stable.
- Do not mark a phase `Done` until its checkpoint has passed and the change is committed.
- When scope changes, update this file and the affected phase file in the same commit.
- When a decision gate closes, record the decision and the date in this file before implementing code that depends on it.
