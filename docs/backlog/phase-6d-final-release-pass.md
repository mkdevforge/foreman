# Phase 6d: Final Release Pass

Backlog review: Reviewed.

## Goal

Verify the v0 release-ready state from a clean checkout and close the PRD acceptance checklist.

## Scope

- Verify `bun install && bun run build` from a clean checkout.
- Verify `bun test` from a clean checkout.
- Verify hook and CLI scripts are runnable from the package bin entries.
- Check that out-of-scope PRD items were not implemented accidentally.
- Consolidate the final acceptance checklist and mark v0 status accurately in `docs/backlog/progress.md`.
- Apply only small release-blocking fixes found by this pass.

## Out Of Scope

- New feature work.
- Broad refactors.
- Additional manual real-tool exploration beyond verifying the Phase 6c record is present.

## Implementation Notes

- Prefer a temporary clone or worktree for the clean-checkout check.
- Record exact commands and results in a repo document.
- Keep any final fixes tightly scoped to release readiness.

## Test Checkpoint

The phase is complete when this passes from a clean checkout:

```sh
bun install
bun run build
bun test
```

and the manual end-to-end verification record for Claude Code and Codex exists in the repo.

## Done Criteria

- Phase 6d checkpoint passes.
- `docs/backlog/progress.md` marks Phase 6d as `Done`.
- v0 acceptance criteria in `docs/backlog/progress.md` are marked accurately.
- The release-ready state is committed.
