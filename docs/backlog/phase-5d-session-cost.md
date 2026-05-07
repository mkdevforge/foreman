# Phase 5d: Session Cost CLI

Backlog review: Reviewed.

## Goal

Complete `foreman session cost` so the supervisor can inspect estimated spend across source, project, task, chunk, model, and day dimensions.

## Scope

- Implement `foreman session cost [--since <duration>] [--by project|task|chunk|model|source|day] [--json]`.
- Default grouping is `source`.
- Include total cost and session count per group.
- Include an overall total.
- Support sessions with no task/chunk links.
- JSON output uses `schema_version: 1`, snake_case keys, full IDs where IDs appear, and explicit `null` grouping keys for unlinked/unknown values.

## Out Of Scope

- Exact enterprise billing reconciliation.
- Pricing table updates beyond existing Phase 3c behavior.
- Charts, export formats, search, or UI surfaces.

## Implementation Notes

- Cost is the stored `usage.cost_usd` estimate.
- `--since` reuses the existing compact duration parser behavior.
- `--by task` and `--by chunk` should include unlinked sessions under explicit null task/chunk keys.
- If a session is linked to multiple chunks, task/chunk groupings may count that session in multiple linked groups, but the overall total should be computed from distinct sessions.
- `--by day` groups by the UTC date prefix of `sessions.started_at`.

## Test Checkpoint

The phase is complete when automated tests cover:

- Cost grouped by source.
- Cost grouped by project.
- Cost grouped by task.
- Cost grouped by chunk.
- Cost grouped by model.
- Cost grouped by day.
- Cost grouping with sessions that have no task/chunk links.
- JSON output for at least one linked and one unlinked grouping mode.
- Invalid `--by` values fail with exit 2.

Manual smoke test:

```sh
foreman session cost --by source
foreman session cost --by source --json
foreman session cost --by task
```

## Done Criteria

- Phase 5d checkpoint passes.
- `docs/backlog/progress.md` marks Phase 5d as `Done`.
- Phase 5 is considered complete after 5a, 5b, 5c, and 5d are all `Done`.
