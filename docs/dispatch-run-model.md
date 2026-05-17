# Dispatch Run Model

This document records the storage stance for Foreman dispatch work. It is a storage contract, not an implemented runner.

## Decision

Dispatch run state belongs in the user-scoped SQLite database at `~/.foreman/foreman.db`.

Repo YAML under `.foreman/tasks/*.yaml` remains shared task context:

- task and chunk definitions
- specs and review notes
- human questions and answers
- accepted decisions
- dispatch readiness policy

Repo YAML must not become a live process ledger. The runner should not write machine-specific run attempts, process ids, workspace paths, local user identity, transient errors, retry timers, or token/cost totals into committed task files.

## Rationale

Dispatch attempts are local execution facts. They vary by machine, worktree, installed agent harness, credentials, environment variables, network state, and user identity. Storing that in YAML would create merge noise, expose local details, and make sibling-worktree dispatch awkward.

SQLite is already the source of truth for captured sessions, costs, summaries, and chunk links. Future dispatch runs should use the same local store so queries can join:

- planned run attempt
- launched agent session
- linked chunk
- usage/cost
- summary and tool-call evidence

YAML is still the right place for data that should follow the task through Git history. Human decisions and answered questions are durable project context; process state is not.

## Reference Inputs

- `docs/foreman-poc-prd.md` defines SQLite as the v0 store for sessions and local identity, while YAML is repo-scoped task metadata.
- `docs/dispatch-readiness-schema.md` defines dispatch readiness as a chunk-level gate and explicitly keeps future run state out of readiness metadata.
- `references/symphony/SPEC.md` was used as product/design reference for orchestration concepts such as claimed/running/retry states and explicit run-attempt phases. Foreman should borrow those operational primitives, not copy Symphony's tracker-driven architecture.

## SQLite Shape

Database schema versions 2 through 4 add the dispatch persistence foundation. The runner is still future work, but the dispatch CLI creates queued run records, prepares local attempts, and queries these entities rather than adding run-attempt fields to YAML.

### `dispatch_runs`

One logical user request to dispatch a chunk.

Fields:

- `id` prefixed UUIDv7, for example `run_<uuidv7>`
- `repo_name`: derived from `remote.origin.url`, for example `foreman`
- `task_id`
- `chunk_id`
- `requested_stage`
- `status`: `queued`, `claimed`, `running`, `succeeded`, `failed`, `canceled`
- `requested_by`: local user identifier if available
- `created_at`
- `updated_at`
- `finished_at`
- `source`: `cli`, future UI, or future scheduler

### `dispatch_attempts`

One concrete agent launch attempt for a dispatch run.

Fields:

- `id` prefixed UUIDv7, for example `attempt_<uuidv7>`
- `run_id`
- `attempt_number`
- `status`: `preparing_workspace`, `building_prompt`, `launching_agent`, `initializing_session`, `streaming_turn`, `finishing`, `succeeded`, `failed`, `timed_out`, `stalled`, `canceled`
- `tool`: `claude-code`, `codex`, or future agent source
- `workspace_path`
- `worktree_branch`
- `process_id`
- `started_at`
- `ended_at`
- `error_message`
- `session_id`: nullable FK to `sessions.id` once known

### `dispatch_events`

Append-only audit events for debugging and UI timelines.

Fields:

- `id` prefixed UUIDv7, for example `evt_<uuidv7>`
- `run_id`
- `attempt_id`: nullable for run-level events before an attempt exists
- `ts`
- `type`
- `message`
- `data_json`

## Invariants

- A dispatch run references exactly one task/chunk.
- A dispatch attempt belongs to exactly one dispatch run.
- A dispatch event with an `attempt_id` must reference an attempt that belongs to the same `run_id`.
- A dispatch attempt with existing events must not be moved to another run.
- A captured agent session can be linked to a dispatch attempt after hooks ingest it.
- The existing `session_chunks` table remains the source of truth for chunk/session linkage.
- Re-running ingestion must not duplicate sessions, prompts, tool calls, chunk links, runs, attempts, or events.
- Runner state changes should be transactional where possible. A runner crash should leave enough local state for reconciliation.
- YAML should only be updated for deliberate shared-context changes, such as a human adding a question, answer, decision, or readiness policy.

## Worktrees

Dispatch requires `remote.origin.url` on the control repo. Foreman derives a repo name from that remote and uses it as the local relationship key for dispatch runs and workspace paths.

Future dispatch should prefer sibling worktrees for implementation attempts. Worktree paths, branches, and cleanup state are local execution details and therefore belong in SQLite attempt rows, not YAML.

Readiness evaluation should run against the control repo's YAML before a dispatch run is created. The attempt workspace can then be created from the same repo remote/branch context. Workspace ownership is task-level: the default path is `../foreman-worktrees/<repo-name>/<task-id>` from the control repo root, on branch `foreman/<task-id>`, and later chunks in the same task should reuse that workspace.

## CLI Surface

The current user-facing dispatch surface reaches the first process-launch slice but still keeps completion and reconciliation separate:

- `foreman dispatch create <task>/<chunk> [--stage <stage>]`
- `foreman dispatch start <task>/<chunk> --tool <claude-code|codex> [--stage <stage>]`
- `foreman dispatch claim <run-id-or-prefix> --tool <claude-code|codex>`
- `foreman dispatch prepare <run-id-or-prefix>`
- `foreman dispatch prompt <run-id-or-prefix>`
- `foreman dispatch launch <run-id-or-prefix>`
- `foreman dispatch workspace <run-id-or-prefix>`
- `foreman dispatch diff <run-id-or-prefix> [--stat] [--name-only]`
- `foreman dispatch merge <run-id-or-prefix>`
- `foreman dispatch cleanup <run-id-or-prefix> [--force]`
- `foreman dispatch reconcile <run-id-or-prefix> [--older-than <duration>]`
- `foreman dispatch reconcile --all [--older-than <duration>]`
- `foreman dispatch cancel <run-id-or-prefix>`
- `foreman dispatch list [--task <id>] [--chunk <id>] [--status <status>]`
- `foreman dispatch show <run-id-or-prefix>`

`foreman dispatch create` requires an origin remote, validates readiness from control-repo YAML first, then atomically inserts one `queued` `dispatch_runs` row and one run-level `queued` event. Requested dispatch stages are `plan`, `implement`, or `review`; `discovery` remains a pre-dispatch stage. The command does not launch agents, create worktrees, create attempts, mutate chunk status, or write run state to YAML.

`foreman dispatch start` is the composed normal path for a ready chunk. It requires an origin remote, validates readiness, creates a queued run, claims it for the selected tool, prepares the task-level sibling worktree, builds the deterministic prompt, launches the local agent, and returns immediately. It persists the same event sequence as the lower-level commands: `queued`, `claimed`, `attempt_prepared`, `prompt_built`, and `agent_launched`. If a later step fails, already-completed state remains in SQLite for inspection and recovery; not-ready chunks fail before any dispatch rows are inserted. The command does not wait for completion, attach sessions, infer success, retry, merge, mutate task YAML, or clean up worktrees.

`foreman dispatch claim` resolves exact IDs or unique prefixes, changes queued runs to `claimed`, and appends one run-level `claimed` event with the selected tool. This is only a local queue ownership step; it does not create attempts, create worktrees, launch agents, mutate task YAML, or attach sessions.

`foreman dispatch prepare` resolves exact IDs or unique prefixes, verifies the current control repo's derived `repo_name` matches the run, creates or reuses the task-level sibling worktree, changes the run from `claimed` to `running`, inserts the first `preparing_workspace` attempt, and appends one attempt-level `attempt_prepared` event. It still does not launch agents, stream output, attach sessions, mutate task YAML, or clean up worktrees.

`foreman dispatch prompt` resolves exact IDs or unique prefixes, verifies the run belongs to the current control repo, loads task/chunk context from repo YAML, and renders the prompt that a later launch command should pass to the selected agent. The command is read-only: it does not append dispatch events, change attempt status, launch agents, attach sessions, mutate task YAML, or clean up worktrees.

`foreman dispatch launch` resolves exact IDs or unique prefixes, verifies the run belongs to the current control repo, loads the same task/chunk prompt context, requires exactly one `preparing_workspace` attempt, and starts the selected local tool from the attempt workspace. Codex launches as `codex --ask-for-approval never exec --sandbox workspace-write --color never -`; Claude Code launches as `claude --print --input-format text --output-format stream-json --verbose --permission-mode acceptEdits`. The prompt is passed on stdin. The command records `prompt_built` and `agent_launched` events, moves the attempt through `building_prompt` to `launching_agent`, stores `process_id`, passes dispatch IDs through the child environment, and returns immediately. Event JSON stores command metadata plus prompt size/hash, not the full prompt.

When a launched child later triggers a Foreman Stop hook, the hook captures the base session first, then attaches the captured `session_id` to the matching `launching_agent` attempt and appends one `session_attached` event. Missing or malformed dispatch env, missing rows, status mismatches, and conflicting existing links are logged as degraded hook failures; they do not undo session capture or active chunk linkage. This attachment does not infer success, update run completion, retry, cancel live processes, mutate task YAML, or clean up worktrees.

`foreman dispatch workspace` resolves exact IDs or unique prefixes and inspects the recorded attempt worktree without mutating SQLite, YAML, branches, or files. It requires exactly one attempt with a workspace path and recorded worktree branch, verifies the workspace exists, is the Git root, and is on the recorded branch, then reports dirty state, porcelain file statuses, untracked files, upstream/ahead/behind counts when available, and recent commits. Unsupported states such as no attempt, multiple attempts, missing workspace path, missing workspace, or branch mismatch fail as command errors with structured JSON details.

`foreman dispatch diff` performs the same workspace validation and then prints `git diff HEAD --` for tracked changes. `--stat` maps to `git diff --stat HEAD --`; `--name-only` maps to `git diff --name-only HEAD --`. The command intentionally follows Git diff semantics, so untracked files are visible through `dispatch workspace` but are not included in tracked diff output.

`foreman dispatch merge` resolves exact IDs or unique prefixes, verifies the run belongs to the current control repo, and integrates only explicitly succeeded dispatch work. The run and its single attempt must both be `succeeded`; the recorded dispatch workspace must inspect cleanly; the current control repo worktree must also be clean. The command writes a durable `merge_started` event before the Git side effect, fast-forward merges the recorded worktree branch into the current control branch, then appends one `merged` event with the previous HEAD, new HEAD, merged branch SHA, workspace path, worktree branch, control branch, and `merge_started_event_id`. If the branch is already reachable from the control repo HEAD, merge is a successful no-op without a duplicate event. If the branch is already reachable, a `merge_started` event exists, and no `merged` event exists, rerunning merge repairs the audit trail by appending a recovered `merged` event with `audit_recovered: true` and `audit_recovery_reason: "merge_event_missing_after_git_side_effect"` without running Git merge again. Non-fast-forward histories are rejected for a later rebase/conflict-resolution slice. The command does not commit loose workspace files, resolve conflicts, push, mutate task YAML, mark chunks done, or clean up worktrees.

`foreman dispatch cleanup` resolves exact IDs or unique prefixes, verifies the run belongs to the current control repo, and removes only terminal dispatch worktrees. The run must be `succeeded`, `failed`, or `canceled`, with exactly one recorded attempt and workspace branch. For succeeded runs, the worktree branch must already be reachable from the current control repo HEAD unless `--force` is passed. Any dirty workspace is rejected unless `--force` is passed. The command writes a durable `cleanup_started` event before the Git side effect, removes the recorded worktree, attempts `git branch -d <worktree-branch>`, preserves the branch when Git reports deletion is unsafe, and appends one attempt-level `cleaned_up` event with workspace, branch, force, branch deletion details, and `cleanup_started_event_id`. If the workspace is already gone and a `cleaned_up` event exists, cleanup is a successful no-op. If the workspace is already gone, a `cleanup_started` event exists, and no `cleaned_up` event exists, rerunning cleanup repairs the audit trail by appending a recovered `cleaned_up` event with `audit_recovered: true` and `audit_recovery_reason: "cleanup_event_missing_after_git_side_effect"` without removing a worktree again. When recovery finds the local branch still present, it preserves the branch and records `branch_delete_skipped_reason: "branch_state_unknown_after_recovery"`. The command does not push, mutate task YAML, retry runs, infer task completion, or delete unsafe branches.

`foreman dispatch reconcile` resolves exact IDs or unique prefixes, or scans claimed/running rows with `--all`, and closes stale abandoned local run state. It requires `remote.origin.url` on the current control repo and compares the current repo name to `dispatch_runs.repo_name` when the row has one. The default stale threshold is `24h`; `--older-than` accepts compact `m`, `h`, `d`, and `w` durations. Reconciliation only marks three unrecoverable shapes as failed: claimed runs with no attempts, running runs with one `preparing_workspace` attempt and no launched process, and running runs with one `launching_agent` attempt whose `process_id` is no longer alive and whose attempt has no attached Stop-hook session. It sets terminal timestamps, updates the attempt when one exists, and appends one `reconciled_failed` event with the previous run status, previous attempt status, process id, threshold, checked timestamp, and reason. Terminal rows, live processes, attached sessions, not-yet-stale rows, and unsupported shapes are successful no-ops. The command does not retry, relaunch, merge, clean up worktrees, infer success, mutate task YAML, or harden cross-resource Git/SQLite partial side effects.

`foreman dispatch finish` resolves exact IDs or unique prefixes and requires a `running` run with exactly one `launching_agent` attempt. `--status succeeded` always requires a captured `session_id`. `--status failed` requires a captured `session_id` by default, but `--allow-missing-session` permits closing a launched attempt that exited before Stop-hook capture; this no-session failure path requires `--message`. The command sets terminal timestamps and appends one attempt-level terminal event, including whether the attempt was finished without a session. Repeating the same terminal status is a successful no-op without a duplicate event. This command is explicit human or runner input; Foreman does not infer completion from hook capture alone.

`foreman dispatch cancel` resolves exact IDs or unique prefixes, changes queued runs to `canceled`, sets `finished_at`, and appends one run-level `canceled` event transactionally. Runs already in `canceled` status are successful no-ops. Other statuses are rejected until a later runner slice defines live stop behavior.

JSON output exposes stable snake_case run fields plus `attempts` and `events`. Attempt rows include `session_id` and hydrate `session` with the same overview shape used by `foreman session list` when the referenced session is still present.

## UI Contract

The future UI should use CLI/SQLite-backed JSON surfaces for live run status. It should render YAML-backed context and SQLite-backed run state as separate sections:

- shared context: task, chunk, questions, decisions, readiness
- local execution: runs, attempts, current phase, workspace, linked sessions, costs, errors

That split keeps the UI honest about which facts are committed project knowledge and which facts are local machine state.

## Non-Goals For The Schema Slice

- No agent-running command.
- No background scheduler.
- No Claude/Codex process launching.
- No YAML run-attempt fields.
