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
- Codex also ensures `[features] hooks = true` in `~/.codex/config.toml`.

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

Questions capture missing context as explicit chunk state. IDs are generated as prefixed UUIDv7 values such as `q_019e0a43-440d-71ab-8a12-d96835bd56f1`.

```sh
foreman question add FOREMAN-1/parser "Which auth boundary owns token refresh?"
foreman question list FOREMAN-1/parser
foreman question answer FOREMAN-1/parser q_019e0a43-440d-71ab-8a12-d96835bd56f1 "Keep refresh handling in the API boundary."
```

Question commands support `--json` and expose stable `task_id`, `chunk_id`, `question`, and `questions` fields for UI clients.

## Decision Workflow

Decisions capture accepted human choices as durable chunk context. IDs are generated as prefixed UUIDv7 values such as `d_019e0a43-440f-729e-8631-8cffb5344450`.

```sh
foreman decision add FOREMAN-1/parser "Keep refresh handling in the API boundary."
foreman decision list FOREMAN-1/parser
```

Decision commands support `--json` and expose stable `task_id`, `chunk_id`, `decision`, and `decisions` fields for UI clients. Decisions do not store author identity in repo YAML.

## Readiness Workflow

Readiness reports whether a chunk has enough shared context for future dispatch. The command is read-only and exits `0` for both ready and not-ready evaluations; invalid refs or malformed YAML still exit `2`.

```sh
foreman chunk ready FOREMAN-1/parser
foreman chunk ready FOREMAN-1/parser --json
```

Readiness blockers include empty specs, open questions, missing dispatch metadata, dispatch metadata that is not `ready`, missing accepted decisions when approval/risk policy requires them, blocked/done chunk status, and discovery-stage chunks.

Dispatch run state is local SQLite state, not repo YAML. See `docs/dispatch-run-model.md` for the storage boundary around runner commands.

## Dispatch Runs

Persisted dispatch runs are local SQLite records. Dispatch commands require `remote.origin.url` so local runs can be tied to a repo name. `foreman dispatch create` queues a ready chunk in SQLite only; it does not launch agents, create worktrees, create attempts, or mutate task YAML.

```sh
foreman dispatch start FOREMAN-1/parser --tool codex
foreman dispatch start FOREMAN-1/parser --tool claude-code --stage review
foreman dispatch create FOREMAN-1/parser
foreman dispatch create FOREMAN-1/parser --stage review
foreman dispatch claim <run-id-or-prefix> --tool codex
foreman dispatch claim <run-id-or-prefix> --tool claude-code
foreman dispatch prepare <run-id-or-prefix>
foreman dispatch prompt <run-id-or-prefix>
foreman dispatch launch <run-id-or-prefix>
foreman dispatch workspace <run-id-or-prefix>
foreman dispatch diff <run-id-or-prefix>
foreman dispatch diff <run-id-or-prefix> --stat
foreman dispatch diff <run-id-or-prefix> --name-only
foreman dispatch merge <run-id-or-prefix>
foreman dispatch cleanup <run-id-or-prefix>
foreman dispatch cleanup <run-id-or-prefix> --force
foreman dispatch reconcile <run-id-or-prefix>
foreman dispatch reconcile --all
foreman dispatch reconcile --all --older-than 48h
foreman dispatch finish <run-id-or-prefix> --status succeeded
foreman dispatch finish <run-id-or-prefix> --status failed --message "Tests failed"
foreman dispatch finish <run-id-or-prefix> --status failed --message "Agent exited before hook capture" --allow-missing-session
foreman dispatch cancel <run-id-or-prefix>
foreman dispatch list
foreman dispatch list --task FOREMAN-1 --chunk parser --status queued
foreman dispatch show <run-id-or-prefix>
foreman dispatch show <run-id-or-prefix> --json
```

`foreman dispatch start --json` returns `dispatch_run`, `readiness`, `workspace`, `dispatch_launch`, and `steps`. `foreman dispatch create --json` returns `dispatch_run` and `readiness`. Requested dispatch stages are `plan`, `implement`, or `review`; `discovery` remains a pre-dispatch stage. `foreman dispatch prepare --json` returns the updated `dispatch_run`, `workspace`, and `changed`. `foreman dispatch prompt --json` returns `dispatch_prompt`. `foreman dispatch launch --json` returns the updated `dispatch_run` and `dispatch_launch`. `foreman dispatch workspace --json` returns `dispatch_run` and `workspace`. `foreman dispatch diff --json` returns `dispatch_run`, `workspace`, and `diff`. `foreman dispatch merge --json` returns `dispatch_run`, `merge`, and `changed`. `foreman dispatch cleanup --json` returns `dispatch_run`, `cleanup`, and `changed`. Merge and cleanup JSON include `audit_recovered` and `audit_recovery_reason`; top-level `changed` is true when the command performed the Git side effect or repaired a missing final audit event. `foreman dispatch reconcile <run> --json` returns `dispatch_run`, `reconciliation`, and `changed`; `foreman dispatch reconcile --all --json` returns `reconciliations`, `changed`, and `older_than_ms`. `foreman dispatch finish --json` returns the updated `dispatch_run` and `changed`. `foreman dispatch cancel --json` returns the updated `dispatch_run` and `changed`. Only queued runs can be canceled; already canceled runs are successful no-ops. `foreman dispatch list --json` returns `dispatch_runs`. `foreman dispatch show --json` returns `dispatch_run`. Each run includes run fields, attempts, events, and any attempt-linked session overview.

`foreman dispatch start` is the composed happy path for a ready chunk. It validates readiness, creates a queued run, claims it for the selected tool, prepares the task worktree, builds the prompt, launches the agent, and then returns immediately. It records the same SQLite events as the lower-level commands and stops on the first failure with any completed state still persisted for inspection or recovery.

`foreman dispatch claim` moves a queued run to `claimed` for a selected local tool and records that choice as a run-level event. It does not create attempts, create worktrees, or launch an agent yet.

`foreman dispatch prepare` moves a claimed run to `running`, creates or reuses one sibling worktree for the parent task, and records the first `preparing_workspace` attempt. The default workspace is `../foreman-worktrees/<repo-name>/<task-id>` from the control repo root, on branch `foreman/<task-id>`. It still does not launch Claude/Codex or attach sessions.

`foreman dispatch prompt` builds the deterministic launch prompt for a prepared run. Text output is the prompt body; JSON output includes prompt metadata plus the prompt text. It is read-only and does not launch agents, mutate SQLite, or mutate task YAML.

`foreman dispatch launch` starts the claimed tool from the prepared workspace using that same prompt. Codex launches as `codex --ask-for-approval never exec --sandbox workspace-write --color never -`; Claude Code launches as `claude --print --input-format text --output-format stream-json --verbose --permission-mode acceptEdits`. The command records `building_prompt` and `launching_agent` attempt state, stores the child `process_id`, passes dispatch IDs through the child environment, and returns immediately.

When a launched child later triggers the Foreman Stop hook, the hook ingests the session as usual and attaches the captured `session_id` to the matching dispatch attempt. Attachment appends one `session_attached` event and is idempotent. Foreman still does not infer success, retry, cancel live processes, or clean up worktrees.

`foreman dispatch workspace` is a read-only review command for the recorded attempt worktree. It requires exactly one attempt with a workspace path, verifies the path is the recorded Git root and branch, then reports dirty state, porcelain file statuses, untracked files, upstream/ahead/behind when available, and recent commits. `foreman dispatch diff` prints `git diff HEAD --` for tracked changes from that same workspace; `--stat` and `--name-only` select the corresponding Git diff modes. Untracked files are reported by `dispatch workspace`, not included in tracked diff output.

`foreman dispatch merge` integrates reviewed work from a succeeded dispatch run. It requires the dispatch workspace and the current control repo to be clean, records a local `merge_started` marker, then fast-forward merges the recorded worktree branch into the current control branch and appends a local `merged` event. It does not commit loose workspace files, resolve conflicts, push, mark chunks done, or clean up worktrees. If the branch is already reachable from the control repo HEAD, the command is a successful no-op. If a previous run recorded `merge_started`, applied the Git merge, and failed before writing `merged`, rerunning merge appends a recovered `merged` event with `audit_recovered: true` without merging again.

`foreman dispatch cleanup` removes the recorded sibling worktree for a terminal dispatch run and appends one local `cleaned_up` event. It allows only `succeeded`, `failed`, and `canceled` runs. Successful runs must already have their worktree branch reachable from the current control repo HEAD unless `--force` is passed. Dirty workspaces are rejected unless `--force` is passed. Before removal, Foreman records a local `cleanup_started` marker. After removing the worktree, Foreman deletes the local worktree branch only when `git branch -d` says that deletion is safe; unsafe branches are preserved. Re-running cleanup after the recorded worktree is gone is a successful no-op. If a previous run recorded `cleanup_started`, removed the worktree, and failed before writing `cleaned_up`, rerunning cleanup appends a recovered `cleaned_up` event with `audit_recovered: true` without removing anything again.

`foreman dispatch reconcile` closes abandoned local dispatch rows without retrying agents or touching worktrees. It requires an origin remote, uses repo name matching when a run has `repo_name`, and defaults `--older-than` to `24h`. It marks stale claimed runs with no attempts, stale prepared runs with no launched process, and stale launched runs whose recorded process is gone and whose Stop hook did not attach a session as `failed`. Other shapes are reported as no-op skips.

`foreman dispatch finish` explicitly marks a running dispatch attempt as `succeeded` or `failed`. Successful completion requires a Stop-hook captured session. Failed completion also requires a captured session by default, but `--allow-missing-session` permits `--status failed` when the launched process exited before hook capture; that path requires `--message` so the terminal event explains the no-session failure. The command records terminal timestamps and one terminal event. It does not infer completion from hook capture and still does not retry, cancel live processes, or clean up worktrees.

## Local UI

Start the local web UI:

```sh
foreman ui
foreman ui --host 127.0.0.1 --port 8787
```

By default, `foreman ui` binds to `127.0.0.1` on an OS-selected port and prints the local URL. The browser screens render overview and detail routes for tasks, chunks, dispatch runs, and sessions from specific API endpoints backed by existing `foreman ... --json` commands. Task detail includes compact chunk status/stage controls; chunk detail adds status/stage, notes, question add/answer, and decision controls. Every POST route maps to one allowlisted CLI command with `--json`, requires a same-origin `application/json` request, and does not query SQLite directly or mutate YAML/SQLite outside the CLI boundary. Dispatch start, merge, cleanup, hook install, Git push/pull, daemon behavior, and remote hosting remain outside the UI.

The UI uses hash routes such as `#/task/FOREMAN-1`, `#/chunk/FOREMAN-1/parser`, `#/dispatch/<run-id>`, and `#/session/<session-id>`. It uses Tailwind CSS v4. `bun run build` regenerates `src/ui/ui.css`; use `bun run build:ui` when editing only UI styles. `bun run test:ui-browser` runs behavior-level Playwright smoke coverage without screenshot baselines.

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
- Search, tracker integrations, write-capable UI flows, MCP/Avalonia/TUI clients, and LLM-powered catalog suggestions are out of scope for v0.
- Session summaries depend on the configured local Claude Code/Codex harness and may be absent if summary generation fails.
- `cost_usd` is an estimate, not a billing source of truth.
- Catalog matching depends on stored `repo_remote` or exact `project_path`; it does not infer related worktrees without a shared remote.
- The SQLite schema has local migrations and no cross-machine sync.
