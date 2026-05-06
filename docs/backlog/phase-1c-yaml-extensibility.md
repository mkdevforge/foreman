# Phase 1c: YAML Extensibility Guardrail

## Goal

Make the repo-scoped task YAML safe for future dispatch metadata before later v0 phases add more mutations. Foreman v0 should validate and mutate the fields it owns without dropping unknown task-level or chunk-level fields.

This is a compatibility guardrail for post-v0 dispatch and human-gate metadata. It does not add dispatch behavior.

## Scope

- Update task YAML read/write behavior to preserve unknown task-level fields.
- Update task YAML read/write behavior to preserve unknown chunk-level fields.
- Ensure existing v0 commands keep their current output contract while preserving unknown storage fields:
  - `foreman task status`
  - `foreman chunk add`
  - any existing command that rewrites a task file
- Add tests using representative future metadata fields:
  - `questions`
  - `decisions`
  - `dispatch`
  - `risk_level`
  - `approval_required`
  - `run_attempts`

## Out of Scope

- Interpreting or rendering dispatch metadata.
- Adding question, decision, approval, dispatch, or runner commands.
- Changing v0 JSON output to include unknown fields.
- Byte-for-byte YAML formatting preservation.
- Comment preservation.

## Resolved Decisions

- v0 validates and mutates known fields, but preserves unknown task-level and chunk-level fields.
- Unknown fields are a storage compatibility contract, not a v0 output contract.
- New task and chunk creation writes only v0-owned fields unless a future command owns more fields.

## Implementation Notes

- Preserve unknown fields semantically. Exact formatting and comments do not need to round-trip.
- Avoid schema code that strips unrecognized object keys as a side effect of validation.
- Mutations should load the full task document, update only the owned field paths, validate the known-field invariants, and rewrite atomically.
- Unknown fields inside future objects can be treated opaquely.
- Unknown top-level file fields outside the task object should also be preserved if the parser naturally supports it, but task-level and chunk-level preservation is the required v0 contract.
- Implemented readers/writers validate known task, chunk, and note fields, then carry unknown object keys forward before atomic rewrite.
- v0 JSON output intentionally serializes only documented v0 task, chunk, and note fields. Future dispatch metadata remains in YAML storage but is not part of the v0 output contract.
- New task and chunk creation still writes only v0-owned fields; future metadata appears only when manually added or when a future command owns it.

## Test Checkpoint

The phase is complete when automated tests cover:

- Updating task status preserves unknown task-level fields.
- Adding a chunk preserves unknown task-level fields.
- Adding a chunk preserves unknown fields on existing chunks.
- Listing and showing tasks still expose only the documented v0 text and JSON shapes.
- Invalid known fields still fail validation even when unknown fields are present.
- Semantic YAML round-trip retains representative future metadata fields.

Manual smoke test:

```sh
foreman task show FOREMAN-1 --json
foreman task status FOREMAN-1 doing
foreman chunk add FOREMAN-1/next-chunk --title "Next chunk" --spec-file /tmp/spec.md
```

Expected behavior:

- v0 output remains stable.
- Manually added future metadata under the task or existing chunks remains present in `.foreman/tasks/FOREMAN-1.yaml`.

## Done Criteria

- Phase 1c checkpoint passes.
- `docs/backlog/progress.md` marks Phase 1c as `Done`.
- Any implementation details that affect later dispatch metadata are recorded in this file.
