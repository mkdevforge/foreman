# Phase 1b: Chunk Lifecycle

## Goal

Complete the repo-scoped chunk lifecycle on top of the Phase 1a YAML store. By the end of this phase, chunks can move through status and stage changes, and review notes can be appended with authorship metadata.

## Scope

- Implement chunk mutation commands:
  - `foreman chunk status <task>/<chunk> <todo|doing|review|done|blocked>`
  - `foreman chunk stage <task>/<chunk> <discovery|plan|implement|review>`
  - `foreman chunk note <task>/<chunk> "..." [--author <email>]`
- Validate full task YAML schema from the PRD, including notes:
  - note timestamp
  - note author
  - note body
- Preserve task and chunk timestamp semantics:
  - changing a task updates task `updated_at`
  - changing a chunk updates that chunk `updated_at`
  - changing a chunk also updates task `updated_at`
- Add text and JSON output for the new commands.
- Add tests for YAML round-trip after repeated mutations.

## Out of Scope

- Active-context commands.
- SQLite.
- Session, review, catalog, and hook behavior.
- Multi-user review workflows or assignments.
- Workflow automation, such as auto-advancing status from stage changes.

## Resolved Decisions

- Note author fallback: `foreman chunk note` uses `git config user.email` by default, allows `--author <email>`, and errors if neither is available.

## Implementation Notes

- `foreman chunk status` mutates only chunk status and timestamps.
- `foreman chunk stage` mutates only chunk stage and timestamps.
- `foreman chunk note` appends a note and does not edit or reorder existing notes.
- Author comes from `--author <email>` when provided; otherwise use `git config user.email`.
- If author cannot be resolved, fail with a clear CLI error.
- Notes use ISO 8601 UTC timestamps.
- Note body is a plain string argument in this phase. No editor, stdin, or file support.
- Preserve the same atomic write behavior and YAML formatting stance from Phase 1a.

## Test Checkpoint

The phase is complete when automated tests cover:

- Updating chunk status.
- Updating chunk stage independently from status.
- Appending a note with timestamp, git-config author, and body.
- Appending a note with an explicit `--author` override.
- Preserving existing notes when appending another note.
- Updating task and chunk `updated_at` correctly.
- Failing clearly when the chunk reference does not exist.
- Failing clearly when note author cannot be resolved under the chosen policy.
- Text output for each mutation command.
- JSON output shape for each mutation command.
- Semantic YAML round-trip after repeated chunk mutations.

Manual smoke test:

```sh
foreman chunk status FOREMAN-1/yaml-store doing
foreman chunk stage FOREMAN-1/yaml-store implement
foreman chunk note FOREMAN-1/yaml-store "Initial implementation checkpoint reviewed."
foreman task show FOREMAN-1
foreman task show FOREMAN-1 --json
```

## Done Criteria

- Phase 1b checkpoint passes.
- `docs/backlog/progress.md` marks Phase 1b as `Done`.
- Any schema or output shape refinements are reflected in tests.
