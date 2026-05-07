# Foreman

Foreman is a local supervisor CLI for tracking AI coding-agent work against repo-scoped tasks and chunks. It stores task metadata in the control repo under `.foreman/tasks/*.yaml` and stores captured Claude Code/Codex sessions in a user-scoped SQLite database at `~/.foreman/foreman.db`.

## Setup

Requirements:

- Bun
- Git
- Claude Code and/or Codex if you want automatic Stop hook capture

From a local checkout:

```sh
bun install
bun run build
bun test
```

The package exposes three bin entries:

```sh
bun run foreman --help
bun run foreman-hook-stop-claude-code --help
bun run foreman-hook-stop-codex --help
```

The workflow examples below use `foreman` directly. From an unlinked checkout, run the same commands as `bun run foreman -- <args>`, for example `bun run foreman -- init`. To use the shorter `foreman ...` form from a checkout, run `bun link` once or put the repo root on PATH.

## Hook Install

Install both supported Stop hooks:

```sh
foreman install
```

Install one tool only:

```sh
foreman install --tool claude-code
foreman install --tool codex
```

Hook install is user-level in v0:

- Claude Code writes `~/.claude/settings.json` under `hooks.Stop`.
- Codex writes `~/.codex/hooks.json` under `hooks.Stop`.
- Codex also ensures `[features] codex_hooks = true` in `~/.codex/config.toml`.

Foreman preserves unrelated config entries and avoids duplicate Foreman Stop hooks.

## Task And Chunk Workflow

Initialize Foreman metadata in a Git repo:

```sh
foreman init
```

Create a task and chunk:

```sh
foreman task add FOREMAN-1 --title "Ship v0"
foreman chunk add FOREMAN-1/parser --title "Parser fixtures" --spec-file parser-spec.md
```

Inspect and update work:

```sh
foreman task list
foreman task show FOREMAN-1
foreman task status FOREMAN-1 doing

foreman chunk list FOREMAN-1
foreman chunk status FOREMAN-1/parser doing
foreman chunk stage FOREMAN-1/parser implement
foreman chunk note FOREMAN-1/parser "Ready for review."
```

Task YAML is intended to be committed with the repo. v0 validates known fields but preserves unknown task-level and chunk-level fields so future dispatch metadata can round-trip. Notes do not store author metadata; use Git history for repo-visible authorship and local session data for local identity.

## Question Workflow

Questions capture missing context as explicit chunk state. IDs are generated per chunk as `q1`, `q2`, and so on.

```sh
foreman question add FOREMAN-1/parser "Which auth boundary owns token refresh?"
foreman question list FOREMAN-1/parser
foreman question answer FOREMAN-1/parser q1 "Keep refresh handling in the API boundary."
```

Question commands support `--json` and expose stable `task_id`, `chunk_id`, `question`, and `questions` fields for UI clients.

## Active Work Context

Tell Foreman what task/chunk the next agent session should link to:

```sh
foreman work FOREMAN-1/parser
foreman work FOREMAN-1/parser --stage implement
foreman work FOREMAN-1/parser --project ../sibling-worktree
```

`foreman work` validates task/chunk YAML in the current control repo. `--project` resolves to the Git root for a sibling worktree and is used by hooks to decide whether an agent session belongs to the active chunk.

Check or clear active context:

```sh
foreman status
foreman stop
```

Active contexts older than 24 hours are stale for hook linkage but still visible in `foreman status`.

## Session Review

Hooks ingest Claude Code and Codex Stop payloads, parse transcripts, estimate cost, store summaries, and link eligible sessions to the active chunk.

Show captured sessions:

```sh
foreman session list
foreman session show <session-prefix>
foreman session show <session-prefix> --full
foreman session last
```

Review task/chunk progress with linked session data:

```sh
foreman review FOREMAN-1/parser
foreman review FOREMAN-1/parser --full
foreman review FOREMAN-1
```

Chunk review shows chunk metadata, notes, linked sessions grouped by link stage, summaries, and total linked-session cost. Task review shows chunk rollups and avoids double-counting session cost across chunks in the same task.

## Catalog Workflow

Use the catalog to find unattached sessions and link them retroactively.

List candidates non-interactively:

```sh
foreman catalog --json
foreman catalog --since 7d --json
foreman catalog --all --json
```

Interactive mode prompts for `<task>/<chunk>`, `skip`, or `quit`:

```sh
foreman catalog --since 7d
```

One-shot link and unlink:

```sh
foreman catalog --link <session-prefix> FOREMAN-1/parser
foreman catalog --link <session-prefix> FOREMAN-1/parser --stage review
foreman catalog --unlink <session-prefix> FOREMAN-1/parser
```

Catalog repo identity policy:

- If the current repo has `remote.origin.url`, catalog candidates default to sessions whose stored `repo_remote` normalizes to the same remote.
- If the current repo has no origin remote, catalog candidates default to sessions whose stored `project_path` exactly matches the current Git root.
- `--all` removes repo/project filtering but keeps other filters such as `--since`.
- Foreman does not guess sibling worktrees unless sessions share a normalized origin remote.

## Cost Reporting

Foreman stores `usage.cost_usd` as an estimate based on the captured token usage and the hardcoded v0 pricing table. It is not guaranteed to match enterprise billing or local harness cost.

```sh
foreman session cost
foreman session cost --by source
foreman session cost --by project
foreman session cost --by task
foreman session cost --by chunk
foreman session cost --by model
foreman session cost --by day
foreman session cost --since 7d --json
```

## JSON Contract

All user-facing CLI commands support global `--json`. The flag may appear before or after the command:

```sh
foreman --json task list
foreman task list --json
```

Successful JSON responses use a top-level envelope:

```json
{
  "schema_version": 1
}
```

Command-specific data is added as snake_case fields. Nullable values are explicit `null` values.

Errors use this envelope on stderr:

```json
{
  "schema_version": 1,
  "error": {
    "code": "invalid_since",
    "message": "invalid --since value; expected compact duration like 30m, 24h, 7d, or 2w",
    "exit_code": 2
  }
}
```

Stable exit-code stance:

- `0`: success
- `1`: runtime failure, missing/ambiguous session prefix, corrupt DB/config, or other non-argument failure
- `2`: invalid CLI usage, unknown command, invalid argument, invalid YAML input, or missing task/chunk

Stop hooks intentionally exit `0` after non-help execution, including parse and ingest failures. Hook failures are logged to `~/.foreman/logs/hook-errors.log`.

## Known v0 Limitations

- Hook install is user-level only, not repo-local.
- Search, tracker integrations, dispatch orchestration, MCP/Avalonia/TUI/web clients, and LLM-powered catalog suggestions are out of scope for v0.
- Session summaries depend on the configured local Claude Code/Codex harness and may be absent if summary generation fails.
- `cost_usd` is an estimate, not a billing source of truth.
- Catalog matching depends on stored `repo_remote` or exact `project_path`; it does not infer related worktrees without a shared remote.
- The SQLite schema has a single v0 migration and no cross-machine sync.
