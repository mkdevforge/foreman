# Phase 5a: Review CLI

Backlog review: Reviewed.

## Goal

Implement supervisor review commands that join repo-scoped task YAML with linked session data from SQLite. This phase proves the review surface before adding retroactive catalog linking or cost grouping commands.

## Scope

- Implement `foreman review <task>/<chunk> [--full] [--json]`.
- Implement `foreman review <task> [--json]`.
- Chunk review shows title, spec, status, stage, notes, linked sessions grouped by recorded link stage, summaries inline, and total linked-session cost.
- Task review shows task metadata, chunk roll-up, linked session counts, and total linked-session cost across the task.
- Default text output follows the PRD style: stable Markdown-ish sections, no ANSI colors, no relative timestamps, full UUIDs at least once per object, and enough detail to avoid obvious follow-up commands.
- JSON output uses `schema_version: 1`, snake_case keys, full UUIDs, and explicit `null` fields.

## Out Of Scope

- Catalog listing, linking, unlinking, and interactive prompts.
- `foreman session cost`.
- LLM-powered suggestions, search, Avalonia/TUI/web/MCP surfaces, and tracker API integrations.

## Implementation Notes

- Review commands read task/chunk YAML from the current Foreman control repo.
- Review commands only show sessions already linked in `session_chunks`; they do not infer links from `project_path` or `repo_remote`.
- `--full` on chunk review should include the same prompt/tool-call detail style as `foreman session show --full` for linked sessions.
- Task review should avoid double-counting a session cost if the same session is linked to multiple chunks in the same task.

## Test Checkpoint

The phase is complete when automated tests cover:

- Chunk review with no linked sessions.
- Chunk review with linked sessions grouped by stage.
- Chunk review JSON output.
- Chunk review `--full` includes session prompt/tool-call details.
- Task review roll-up and cost totals.
- Task review JSON output.
- Missing task/chunk errors follow existing CLI error conventions.

Manual smoke test:

```sh
foreman review FOREMAN-1/yaml-store
foreman review FOREMAN-1/yaml-store --json
foreman review FOREMAN-1
```

## Done Criteria

- Phase 5a checkpoint passes.
- `docs/backlog/progress.md` marks Phase 5a as `Done`.
