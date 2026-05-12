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
- `foreman dispatch claim <run-id-or-prefix> --tool <claude-code|codex>`
- `foreman dispatch prepare <run-id-or-prefix>`
- `foreman dispatch prompt <run-id-or-prefix>`
- `foreman dispatch launch <run-id-or-prefix>`
- `foreman dispatch cancel <run-id-or-prefix>`
- `foreman dispatch list [--task <id>] [--chunk <id>] [--status <status>]`
- `foreman dispatch show <run-id-or-prefix>`

`foreman dispatch create` requires an origin remote, validates readiness from control-repo YAML first, then atomically inserts one `queued` `dispatch_runs` row and one run-level `queued` event. Requested dispatch stages are `plan`, `implement`, or `review`; `discovery` remains a pre-dispatch stage. The command does not launch agents, create worktrees, create attempts, mutate chunk status, or write run state to YAML.

`foreman dispatch claim` resolves exact IDs or unique prefixes, changes queued runs to `claimed`, and appends one run-level `claimed` event with the selected tool. This is only a local queue ownership step; it does not create attempts, create worktrees, launch agents, mutate task YAML, or attach sessions.

`foreman dispatch prepare` resolves exact IDs or unique prefixes, verifies the current control repo's derived `repo_name` matches the run, creates or reuses the task-level sibling worktree, changes the run from `claimed` to `running`, inserts the first `preparing_workspace` attempt, and appends one attempt-level `attempt_prepared` event. It still does not launch agents, stream output, attach sessions, mutate task YAML, or clean up worktrees.

`foreman dispatch prompt` resolves exact IDs or unique prefixes, verifies the run belongs to the current control repo, loads task/chunk context from repo YAML, and renders the prompt that a later launch command should pass to the selected agent. The command is read-only: it does not append dispatch events, change attempt status, launch agents, attach sessions, mutate task YAML, or clean up worktrees.

`foreman dispatch launch` resolves exact IDs or unique prefixes, verifies the run belongs to the current control repo, loads the same task/chunk prompt context, requires exactly one `preparing_workspace` attempt, and starts the selected local tool from the attempt workspace. Codex launches as `codex exec --ask-for-approval never --sandbox workspace-write --color never -`; Claude Code launches as `claude --print --input-format text --output-format stream-json --permission-mode acceptEdits`. The prompt is passed on stdin. The command records `prompt_built` and `agent_launched` events, moves the attempt through `building_prompt` to `launching_agent`, stores `process_id`, and returns immediately. Event JSON stores command metadata plus prompt size/hash, not the full prompt. The command does not wait for completion, parse transcripts, attach sessions, infer success, mutate task YAML, retry, cancel live processes, or clean up worktrees.

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
