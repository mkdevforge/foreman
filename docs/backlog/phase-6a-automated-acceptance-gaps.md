# Phase 6a: Automated Acceptance Gaps

Backlog review: Reviewed.

## Goal

Close automated coverage gaps between the implemented feature set and the PRD v0 acceptance criteria.

## Scope

- Run the full automated test suite and fix failures directly tied to v0 behavior.
- Add missing tests from PRD acceptance criterion 13.
- Verify every command that supports `--json` returns valid JSON with the expected `schema_version: 1` envelope and stable snake_case fields.
- Verify stable exit codes:
  - unknown command exits `2`
  - invalid args exit `2`
  - ambiguous ID prefix exits `1`
  - DB missing/corrupt exits `1`
  - hook failures exit `0`
- Verify idempotency:
  - hook install does not duplicate entries
  - re-running ingestion does not duplicate rows
  - re-running Stop hook does not duplicate `session_chunks`
- Verify task YAML extensibility:
  - v0 task mutations preserve unknown task-level fields
  - v0 chunk mutations preserve unknown chunk-level fields

## Out Of Scope

- User documentation.
- Real Claude Code or Codex manual checks.
- Clean-checkout release verification.
- New feature work not needed for v0 acceptance.

## Implementation Notes

- Prefer temporary homes and temporary repos for integration tests.
- Keep fixes small and tied to a failed test or acceptance criterion.
- Avoid broad refactors while hardening; this phase is about confidence, not redesign.

## Test Checkpoint

The phase is complete when automated tests cover:

- JSON output shape for all supported commands.
- Stable exit-code behavior listed above.
- Hook install, ingestion, and Stop hook idempotency.
- Parser, migration, dedup, soft-link-on-stop, catalog interactive flow, and CLI output shape requirements from AC13.

Manual smoke test:

```sh
bun run build
bun test
```

## Done Criteria

- Phase 6a checkpoint passes.
- `docs/backlog/progress.md` marks Phase 6a as `Done`.
