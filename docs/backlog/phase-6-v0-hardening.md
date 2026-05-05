# Phase 6: v0 Hardening

Backlog review: Unreviewed. Review this phase before implementation starts.

## Goal

Close the gap between feature-complete implementation and the PRD's v0 acceptance criteria. This phase is for integration tests, documentation, manual end-to-end verification, and any small fixes required to make Foreman reliable on a clean machine.

## Scope

- Run the full automated test suite.
- Add missing tests from PRD acceptance criterion 13.
- Verify `bun install && bun run build` from a clean checkout.
- Verify every command that supports `--json` returns valid JSON with the documented shape.
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
- Verify manual end-to-end flows for both supported source tools:
  - Claude Code session with `foreman work <task>/<chunk>` links on Stop
  - Codex session with `foreman work <task>/<chunk>` links on Stop
- Add or update user documentation:
  - setup
  - hook install
  - task/chunk workflow
  - review workflow
  - catalog workflow
  - `--json` contract
  - known v0 limitations
- Check that out-of-scope PRD items were not implemented accidentally.

## Out of Scope

- New feature work not needed for v0 acceptance.
- v0.1 search.
- v1 integrations.
- UI clients.

## Implementation Notes

- Use temporary homes and temporary repos for integration tests where possible.
- Manual checks that require real Claude Code or Codex should be documented with exact dates, tool versions, and observed behavior.
- If a current Codex hook contract changed from the PRD, document the exact source consulted and the implementation choice.
- Keep hardening fixes small and directly tied to a failed test or acceptance criterion.

## Test Checkpoint

The phase is complete when:

```sh
bun install
bun run build
bun test
```

passes from a clean checkout, and the manual end-to-end checklist for Claude Code and Codex is recorded in the repo.

## Acceptance Checklist

- [ ] Build works on a clean machine.
- [ ] Hook and CLI scripts are runnable.
- [ ] Hook installation is idempotent for Claude Code.
- [ ] Hook installation is idempotent for Codex.
- [ ] Repo initialization works.
- [ ] Task YAML round-trips.
- [ ] Chunk YAML round-trips.
- [ ] Claude Code Stop hook ingests and links.
- [ ] Codex Stop hook ingests and links.
- [ ] Review output includes chunk metadata, linked sessions, summaries, and costs.
- [ ] Catalog interactive linking works.
- [ ] Session cost by source is correct.
- [ ] JSON mode is valid for every supported command.
- [ ] Hook re-run deduplication holds.
- [ ] Hook errors log and exit `0`.
- [ ] Required tests exist for both transcript parsers.
- [ ] Required tests exist for schema migrations.
- [ ] Required tests exist for dedup-on-rerun.
- [ ] Required tests exist for soft-link-on-stop.
- [ ] Required tests exist for catalog interactive flow.
- [ ] Required tests exist for CLI output shape.

## Done Criteria

- Phase 6 checkpoint passes.
- `docs/backlog/progress.md` marks Phase 6 as `Done`.
- The release-ready state is committed.
