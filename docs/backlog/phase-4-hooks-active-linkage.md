# Phase 4: Hooks and Active Linkage

Backlog review: Unreviewed. Review this phase before implementation starts.

## Goal

Connect ingestion to real Stop hook entry points and the soft active-context file. By the end of this phase, Claude Code and Codex Stop hooks can ingest sessions, log failures without blocking, and link sessions to active chunks when the project path matches.

## Decision Gates

Close these in `docs/backlog/progress.md` before implementation starts:

- Codex hook config location.
- Active context staleness policy.

## Scope

- Implement active-context storage at `~/.foreman/active.json`.
- Implement active-context commands:
  - `foreman work <task>/<chunk> [--stage ...]`
  - `foreman stop`
  - `foreman status`
- Validate active context against existing repo task/chunk YAML.
- Include active context fields needed by hooks:
  - task id
  - chunk id
  - stage override, if provided
  - project path
  - timestamp
- Implement hook binaries:
  - `foreman-hook-stop-claude-code`
  - `foreman-hook-stop-codex`
- Implement hook error handling:
  - catch malformed payloads
  - catch missing transcripts
  - catch DB and parser failures
  - append to `~/.foreman/logs/hook-errors.log`
  - exit `0`
- Link ingested sessions to active chunks when:
  - active context exists
  - active context is not stale under the recorded policy
  - hook project path matches active `project_path`
- Implement `foreman install [--tool claude-code|codex|all]`.
- Preserve unrelated existing hook config entries during installation.

## Out of Scope

- SessionStart hooks.
- Wrapping `claude` or `codex` invocations.
- Auto-advance workflow behavior.
- Multi-user review workflow.

## Implementation Notes

- `foreman work` may accept `--stage` as a session-only override; it should not mutate the chunk YAML stage unless the user separately calls `foreman chunk stage`.
- Hook linkage should write `linked_by = 'hook'`.
- If `project_path` does not match, ingestion should still store the session and skip only the chunk link.
- Hook config installation must be idempotent and avoid duplicate commands.
- Tests should write hook config files under temporary home directories.

## Test Checkpoint

The phase is complete when automated tests cover:

- `foreman work` writes valid active context.
- `foreman stop` clears active context.
- `foreman status` reads active context without DB writes.
- Active context rejects missing task/chunk references.
- Stale active context behavior matches the recorded policy.
- Hook entry points ingest valid mocked Stop payloads.
- Hook failures log and exit `0`.
- Matching active context creates one `session_chunks` row.
- Re-running the same hook does not duplicate the link.
- Mismatched project paths skip only linkage.
- Claude Code install is idempotent and preserves unrelated settings.
- Codex install is idempotent and preserves unrelated settings.

Manual smoke test:

```sh
foreman work FOREMAN-1/yaml-store --stage implement
foreman status
foreman install --tool all
```

## Done Criteria

- Phase 4 checkpoint passes.
- `docs/backlog/progress.md` marks Phase 4 as `Done`.
- The chosen Codex hook config format is documented in user-facing help or README content.
