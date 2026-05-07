# Phase 6b: User Documentation

Backlog review: Reviewed.

## Goal

Add the user-facing documentation needed for someone to install Foreman, run the v0 workflow, and understand the JSON contract and limitations.

## Scope

- Add or update user documentation for:
  - setup
  - hook install
  - task/chunk workflow
  - active work context workflow
  - review workflow
  - catalog workflow
  - session cost workflow
  - `--json` contract
  - known v0 limitations
- Document user-level hook config side effects for Claude Code and Codex.
- Document the catalog repo identity policy:
  - origin remote match when available
  - exact project path fallback when no origin exists
  - `--all` removes repo/project filtering
- Document that `cost_usd` is an estimate based on the stored usage/pricing table.

## Out Of Scope

- New CLI behavior.
- Real-tool manual verification results.
- Clean-checkout release verification.

## Implementation Notes

- Keep docs concrete and command-oriented.
- Avoid over-promising dispatch, search, UI, tracker integrations, or exact enterprise billing.
- Prefer one clear README-level workflow over scattered notes.

## Test Checkpoint

The phase is complete when documentation includes:

- Setup from a local checkout.
- Hook installation for both supported tools.
- A complete task/chunk/work/review/catalog/cost workflow.
- JSON envelope and error envelope examples.
- Known v0 limitations and out-of-scope items.

Manual smoke test:

```sh
bun run build
bun test
```

## Done Criteria

- Phase 6b checkpoint passes.
- `docs/backlog/progress.md` marks Phase 6b as `Done`.
