# Dispatch Run Model

This document records the storage stance for future Foreman dispatch work. It is a design contract, not an implemented runner.

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

## Future SQLite Shape

The next dispatch implementation should add a new database migration. The exact DDL can change when implemented, but the model should preserve these entities.

### `dispatch_runs`

One logical user request to dispatch a chunk.

Recommended fields:

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

Recommended fields:

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

Recommended fields:

- `id` prefixed UUIDv7, for example `evt_<uuidv7>`
- `run_id`
- `attempt_id`
- `ts`
- `type`
- `message`
- `data_json`

## Invariants

- A dispatch run references exactly one task/chunk.
- A dispatch attempt belongs to exactly one dispatch run.
- A captured agent session can be linked to a dispatch attempt after hooks ingest it.
- The existing `session_chunks` table remains the source of truth for chunk/session linkage.
- Re-running ingestion must not duplicate sessions, prompts, tool calls, chunk links, runs, attempts, or events.
- Runner state changes should be transactional where possible. A runner crash should leave enough local state for reconciliation.
- YAML should only be updated for deliberate shared-context changes, such as a human adding a question, answer, decision, or readiness policy.

## Worktrees

Future dispatch should prefer sibling worktrees for implementation attempts. Worktree paths, branches, and cleanup state are local execution details and therefore belong in SQLite attempt rows, not YAML.

Readiness evaluation should run against the control repo's YAML before a dispatch run is created. The attempt workspace can then be created from the same repo remote/branch context.

## UI Contract

The future UI should use CLI/SQLite-backed JSON surfaces for live run status. It should render YAML-backed context and SQLite-backed run state as separate sections:

- shared context: task, chunk, questions, decisions, readiness
- local execution: runs, attempts, current phase, workspace, linked sessions, costs, errors

That split keeps the UI honest about which facts are committed project knowledge and which facts are local machine state.

## Non-Goals For This Slice

- No runner command.
- No background scheduler.
- No database migration.
- No worktree creation.
- No process launching.
- No YAML run-attempt fields.
