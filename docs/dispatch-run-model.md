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

Database schema versions 2 and 3 add the dispatch persistence foundation. The runner is still future work, but the dispatch CLI creates queued run records and queries these entities rather than adding run-attempt fields to YAML.

### `dispatch_runs`

One logical user request to dispatch a chunk.

Fields:

- `id` prefixed UUIDv7, for example `run_<uuidv7>`
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

Future dispatch should prefer sibling worktrees for implementation attempts. Worktree paths, branches, and cleanup state are local execution details and therefore belong in SQLite attempt rows, not YAML.

Readiness evaluation should run against the control repo's YAML before a dispatch run is created. The attempt workspace can then be created from the same repo remote/branch context.

## CLI Surface

The initial user-facing dispatch surface is deliberately below the runner layer:

- `foreman dispatch create <task>/<chunk> [--stage <stage>]`
- `foreman dispatch cancel <run-id-or-prefix>`
- `foreman dispatch list [--task <id>] [--chunk <id>] [--status <status>]`
- `foreman dispatch show <run-id-or-prefix>`

`foreman dispatch create` validates readiness from control-repo YAML first, then atomically inserts one `queued` `dispatch_runs` row and one run-level `queued` event. Requested dispatch stages are `plan`, `implement`, or `review`; `discovery` remains a pre-dispatch stage. The command does not launch agents, create worktrees, create attempts, mutate chunk status, or write run state to YAML.

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
- No worktree creation.
- No process launching.
- No YAML run-attempt fields.
