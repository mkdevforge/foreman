# Phase 6c: Real Tool Verification

Backlog review: Reviewed.

## Goal

Record manual end-to-end verification against the installed Claude Code and Codex tools.

## Scope

- Verify Claude Code Stop hook ingestion and active chunk linkage with `foreman work <task>/<chunk>`.
- Verify Codex Stop hook ingestion and active chunk linkage with `foreman work <task>/<chunk>`.
- Verify hook errors still log and exit `0` under real-tool invocation shape.
- Record exact verification date, local tool versions, commands run, and observed behavior in the repo.
- Note any current hook contract observations that differ from the original PRD assumptions.

## Out Of Scope

- Automated fake-harness tests.
- User workflow documentation beyond the verification record.
- Clean-checkout release verification.
- New feature work.

## Implementation Notes

- Use a temporary HOME and temporary Git repos where practical, but real tools may require controlled local config.
- Do not mutate the user's real hook configs unless the verification explicitly calls `foreman install` and records the effect.
- Keep the verification record reproducible enough that another developer can repeat it.

## Test Checkpoint

The phase is complete when the repo contains a dated manual verification record covering:

- Claude Code active Stop hook capture and link.
- Codex active Stop hook capture and link.
- Tool versions.
- Commands and observed database/review output.
- Any limitations or skipped checks.

Manual smoke test:

```sh
bun run build
bun test
```

## Done Criteria

- Phase 6c checkpoint passes.
- `docs/backlog/progress.md` marks Phase 6c as `Done`.
