# Phase 1: Repo Task Management

## Goal

Implement the repo-scoped orchestration tier: `.foreman/tasks/<task-id>.yaml`. By the end of this phase, Foreman can initialize a repo and manage tasks and chunks without touching the user-scoped session database.

## Scope

- Implement repo root detection and `.foreman/` path helpers.
- Implement `foreman init`.
- Implement task YAML read/write with atomic temp-file-and-rename behavior.
- Validate the task YAML schema from the PRD:
  - `schema_version`
  - task metadata
  - task `status`
  - chunk metadata
  - chunk `status`
  - chunk `stage`
  - append-only-style notes
- Implement task commands:
  - `foreman task add <id> --title "..." [--source-ref ...] [--description ...]`
  - `foreman task list [--status ...] [--json]`
  - `foreman task show <id> [--json]`
  - `foreman task status <id> <todo|doing|review|done|blocked>`
- Implement chunk commands:
  - `foreman chunk add <task>/<chunk-slug> --title "..." [--spec-file path]`
  - `foreman chunk list <task> [--json]`
  - `foreman chunk status <task>/<chunk> <todo|doing|review|done|blocked>`
  - `foreman chunk stage <task>/<chunk> <discovery|plan|implement|review>`
  - `foreman chunk note <task>/<chunk> "..."`
- Add text and JSON output for the above commands.

## Out of Scope

- `foreman work`, `foreman stop`, and `foreman status` active-context commands.
- SQLite.
- Session, review, catalog, and hook behavior.
- Jira, Linear, or GitHub API imports.

## Implementation Notes

- YAML must diff cleanly. Preserve block strings for descriptions, specs, and note bodies where practical.
- Writes should load the full file, mutate the in-memory object, validate, and rewrite atomically.
- Use ISO 8601 UTC timestamps.
- Author for chunk notes should come from `git config user.email`; if unavailable, fail with a clear CLI error rather than guessing.
- `foreman init` should create an empty `.foreman/tasks/` directory and a small `.foreman/README.md`. It should not create sample tasks.
- Do not add `.foreman/` to `.gitignore`; the PRD says task files are commit-friendly.

## Test Checkpoint

The phase is complete when automated tests cover:

- Initializing a temporary Git repo.
- Creating `.foreman/tasks/`.
- Adding a task and reading the YAML back.
- Updating task status.
- Adding a chunk with a spec file.
- Updating chunk status and stage independently.
- Appending a chunk note with an author and timestamp.
- Text output shape for list/show commands.
- JSON output shape with `schema_version: 1`, snake_case keys, full timestamps, and explicit nullable fields.

Manual smoke test:

```sh
foreman init
foreman task add FOREMAN-1 --title "Implement repo task management"
foreman chunk add FOREMAN-1/yaml-store --title "Build YAML task store" --spec-file /tmp/spec.md
foreman task show FOREMAN-1
foreman task show FOREMAN-1 --json
```

## Done Criteria

- Phase 1 checkpoint passes.
- `docs/backlog/progress.md` marks Phase 1 as `Done`.
- Any schema or output shape refinements are reflected in tests.
