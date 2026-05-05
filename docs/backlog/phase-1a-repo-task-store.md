# Phase 1a: Repo Task Store

## Goal

Implement the first usable repo-scoped orchestration slice: initialize `.foreman/`, create task YAML files, add initial chunks, and read the result back in text and JSON. This phase should prove the file model before adding chunk lifecycle mutations or notes.

## Scope

- Implement repo root detection and `.foreman/` path helpers.
- Implement `foreman init`.
- Implement task YAML read/write with atomic temp-file-and-rename behavior.
- Validate the task YAML schema needed for initial task and chunk creation:
  - `schema_version`
  - task id, title, source reference, description, status, timestamps
  - chunk id, title, spec, status, stage, timestamps
  - chunk `notes` as an empty list on creation
- Implement task commands:
  - `foreman task add <id> --title "..." [--source-ref ...] [--description ...]`
  - `foreman task list [--status ...] [--json]`
  - `foreman task show <id> [--json]`
  - `foreman task status <id> <todo|doing|review|done|blocked>`
- Implement initial chunk commands:
  - `foreman chunk add <task>/<chunk-slug> --title "..." [--spec-file path]`
  - `foreman chunk list <task> [--json]`
- Add text and JSON output for the above commands.

## Out of Scope

- `foreman chunk status`.
- `foreman chunk stage`.
- `foreman chunk note`.
- Git author lookup.
- `foreman work`, `foreman stop`, and `foreman status` active-context commands.
- SQLite.
- Session, review, catalog, and hook behavior.
- Jira, Linear, or GitHub API imports.

## Resolved Decisions

- Optional YAML field representation: absent `source_ref` and `description` are written as explicit YAML `null`. JSON output must expose explicit nullable fields.
- Task ID rules: task IDs match `[A-Za-z0-9][A-Za-z0-9._-]*`, preserve case, and are used as file names.
- Chunk ID rules: chunk IDs match `[a-z0-9][a-z0-9-]*` and are unique within a task.

## Implementation Notes

- Detect repo root with `git rev-parse --show-toplevel`.
- Fail clearly when a command requiring a repo is run outside a Git repository.
- `foreman init` creates `.foreman/tasks/` at the repo root and a small `.foreman/README.md`; it should not create sample tasks.
- Do not add `.foreman/` to `.gitignore`; the PRD says task files are commit-friendly.
- Use ISO 8601 UTC timestamps.
- Task IDs are file names. Reject anything that does not match `[A-Za-z0-9][A-Za-z0-9._-]*`.
- Chunk IDs are slugs unique within a task. Reject anything that does not match `[a-z0-9][a-z0-9-]*`.
- Omitted `--source-ref` and `--description` are written as explicit YAML `null`.
- Default new task status to `todo`.
- Default new chunk status to `todo` and stage to `discovery`.
- `--description` is a plain string. No editor, stdin, or markdown file support in this phase.
- `--spec-file` reads UTF-8 text from the given file. No stdin/editor support in this phase.
- Writes should load the full file, mutate the in-memory object, validate, and rewrite atomically.
- Atomic writes use a temp file in the same directory followed by rename.
- Use the `yaml` package. Semantic round-trip is required; byte-for-byte formatting preservation is not.
- Configure multiline strings for descriptions and specs where practical so diffs remain readable.

## Test Checkpoint

The phase is complete when automated tests cover:

- Initializing a temporary Git repo.
- Failing clearly outside a Git repo.
- Creating `.foreman/tasks/` and `.foreman/README.md`.
- Adding a task and reading the YAML back.
- Rejecting invalid task IDs.
- Writing omitted optional task fields as explicit YAML `null`.
- Updating task status.
- Adding a chunk with a spec file.
- Rejecting duplicate chunk IDs.
- Rejecting invalid chunk IDs.
- Listing tasks and chunks.
- Text output shape for list/show commands.
- JSON output shape with `schema_version: 1`, snake_case keys, full timestamps, and explicit nullable fields.

Manual smoke test:

```sh
foreman init
foreman task add FOREMAN-1 --title "Implement repo task store"
foreman chunk add FOREMAN-1/yaml-store --title "Build YAML task store" --spec-file /tmp/spec.md
foreman task show FOREMAN-1
foreman task show FOREMAN-1 --json
foreman chunk list FOREMAN-1
```

## Done Criteria

- Phase 1a checkpoint passes.
- `docs/backlog/progress.md` marks Phase 1a as `Done`.
- Any schema or output shape refinements are reflected in tests.
