# Phase 5: Review and Catalog CLI

Backlog review: Unreviewed. Review this phase before implementation starts.

## Goal

Implement the supervisor-facing commands that join repo-scoped task YAML with user-scoped session capture. By the end of this phase, Foreman can review chunk work, retroactively link sessions, and report costs.

## Scope

- Implement chunk review:
  - `foreman review <task>/<chunk> [--full] [--json]`
  - show chunk title, spec, status, stage, notes
  - show linked sessions grouped by stage
  - include summaries inline
  - total costs
- Implement task review:
  - `foreman review <task> [--json]`
  - show chunk roll-up
  - total session cost across the task
- Implement catalog commands:
  - `foreman catalog [--all] [--since <duration>] [--json]`
  - `foreman catalog --link <session-prefix> <task>/<chunk> [--stage ...]`
  - `foreman catalog --unlink <session-prefix> <task>/<chunk>`
- Implement interactive catalog flow with mocked stdin/stdout tests.
- Complete session cost command:
  - `foreman session cost [--since ...] [--by project|task|chunk|model|source|day] [--json]`
- Ensure default text output follows PRD style:
  - stable Markdown-ish sections
  - no ANSI colors
  - no relative timestamps
  - full UUIDs at least once per object
  - dense enough for agent consumption
- Ensure JSON output follows PRD style:
  - `schema_version: 1`
  - snake_case keys
  - full UUIDs only
  - explicit `null` fields

## Out of Scope

- LLM-powered catalog suggestions.
- Search.
- Avalonia, TUI, web, or MCP surfaces.
- Auto-pull from Jira, Linear, or GitHub APIs.

## Implementation Notes

- By default, catalog should include unattached sessions from the current Foreman repo and its sibling worktrees. Prefer repo identity such as `repo_remote` when available; fall back to exact `project_path` only when no reliable repo identity is available.
- `--all` should remove the project-path filter but keep other filters.
- Catalog links should use `linked_by = 'catalog'` for both interactive and one-shot catalog flows.
- Reserve `linked_by = 'manual'` for a future explicit manual-link surface unless the PRD is updated.
- `--stage` on catalog linking sets the stage recorded in the join row and should not mutate chunk YAML.
- Review output should avoid requiring follow-up commands for obvious details.

## Test Checkpoint

The phase is complete when automated tests cover:

- Chunk review with no linked sessions.
- Chunk review with linked sessions grouped by stage.
- Task review roll-up and cost totals.
- JSON output for chunk and task review.
- Catalog listing unattached current-repo sessions.
- Catalog listing unattached sessions from sibling worktrees that share the current repo identity.
- Catalog `--all` including other projects.
- Interactive catalog link and skip paths with mocked stdin.
- Catalog one-shot link and unlink.
- Session cost grouped by source, project, task, chunk, model, and day.
- Cost grouping with sessions that have no task/chunk links.

Manual smoke test:

```sh
foreman review FOREMAN-1/yaml-store
foreman catalog --since 7d
foreman session cost --by source
foreman session cost --by source --json
```

## Done Criteria

- Phase 5 checkpoint passes.
- `docs/backlog/progress.md` marks Phase 5 as `Done`.
- Review output examples are added to README or command help if the implementation has user docs by this point.
