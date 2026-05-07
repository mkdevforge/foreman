# Future: Dispatch and Human Gates

Status: Seeded for post-v0. Do not implement in v0.

Reference: use `references/symphony/` as product/design input for the desired dispatch end state. Treat it as reference-only material; do not copy or vendor code.

## Goal

Add a Symphony-style dispatch surface over Foreman chunks without treating tracker issues as complete implementation specs. Foreman should dispatch agent-ready chunks that carry enough context, constraints, and human decisions for quality work.

The dispatch layer should make asking the human a first-class successful outcome. An agent that discovers missing context should be able to stop with precise questions instead of guessing or failing.

## Product Direction

- Tracker issues remain source references and routing objects, not the executable spec.
- Foreman tasks hold the engineering breakdown for a tracker issue or project goal.
- Foreman chunks are the dispatchable units of work.
- A chunk is dispatchable only when its spec and gate metadata satisfy the selected policy.
- Dispatch should support both autonomous execution and human-gated execution.
- A future UI should render Foreman chunk/run state, not raw tracker issue state.

## Architecture Stance

Foreman should not chase literal Symphony parity. It should borrow the useful operational primitives while rejecting tracker-state-driven autonomy as the core product model.

Avoid as core product behavior:

- always-on daemon ownership of work selection
- tracker polling as the primary source of dispatch readiness
- raw Linear/Jira issue auto-dispatch
- treating remote issue state as proof that a task is agent-ready

Make core product behavior:

- explicit dispatch queue populated from Foreman chunks
- per-task worktree/workspace creation and reuse
- agent runner that can launch Codex and Claude against a Foreman chunk
- live run state visible through CLI/JSON and later UI
- cancellation and stop controls
- stall detection
- retry/backoff governed by Foreman policy
- reconciliation between run state, workspace state, and chunk state
- runtime observability for active and completed runs
- optional dashboard or web surface over Foreman's state

An optional local service can be introduced later for live updates or UI ergonomics, but it should not become the source of truth for work selection. Foreman should dispatch only Foreman chunks that are explicitly ready, never tracker issues just because they match a remote state.

Workspace ownership should be task-level, not chunk-level: one worktree/workspace per Foreman task. Chunks are coordinated slices of that task and usually need to share branch state, partial edits, tests, and context. Running chunks from the same task in separate worktrees is expected to create avoidable merge and coordination problems. Dispatch can still target one chunk at a time, but the workspace should be reused for the parent task unless a future policy explicitly opts into a different isolation model.

## Candidate YAML Metadata

These fields are examples for the future schema. The current storage contract is recorded in
[`docs/dispatch-readiness-schema.md`](../dispatch-readiness-schema.md).

```yaml
chunks:
  - id: middleware
    title: Build request middleware
    spec: ...
    status: todo
    stage: plan
    questions:
      - id: q-001
        status: open
        body: Which auth boundary owns token refresh?
        asked_at: 2026-05-06T00:00:00.000Z
        answered_at: null
        answer: null
    decisions:
      - id: d-001
        body: Keep refresh handling in the API boundary.
        decided_at: 2026-05-06T00:00:00.000Z
    dispatch:
      status: needs_context
      risk_level: medium
      approval_required: plan
      allowed_actions:
        - edit_source
        - run_tests
      blocked_actions:
        - database_migration
        - public_api_change
```

## Expected States

- `needs_context`: chunk needs clarification before planning or implementation.
- `ready`: chunk is dispatchable.
- `planning`: agent is producing a plan.
- `awaiting_plan_approval`: human approval is required before implementation.
- `running`: agent is actively working.
- `blocked_on_question`: agent stopped with questions that need human answers.
- `needs_review`: implementation finished and needs human review.
- `rework_requested`: review produced follow-up work.
- `done`: accepted.
- `failed`: dispatch failed for infrastructure or agent-runtime reasons.

## CLI Surface Sketch

- `foreman chunk ready <task>/<chunk>` validates that a chunk can be dispatched.
- `foreman question add <task>/<chunk> "..."`.
- `foreman question answer <task>/<chunk> <question-id> "..."`.
- `foreman decision add <task>/<chunk> "..."`.
- `foreman dispatch <task>/<chunk> [--mode discovery|plan|implement|review]`.
- `foreman dispatch status [--json]`.
- `foreman dispatch stop <run-id>`.
- `foreman dispatch retry <run-id>`.

## Agent Contract Sketch

Each dispatched run should receive:

- chunk spec
- current task and chunk metadata
- open questions
- accepted decisions
- risk level
- approval requirements
- allowed and blocked action classes
- clear instruction that unresolved ambiguity should produce questions, not assumptions

Allowed run outcomes:

- `completed`
- `needs_review`
- `blocked_on_question`
- `needs_plan_approval`
- `rework_needed`
- `failed`

`blocked_on_question` and `needs_plan_approval` are successful control outcomes, not infrastructure failures.

## UI Direction

A future dispatch UI should show:

- queue of ready chunks
- chunks blocked on questions
- plans awaiting approval
- running agents
- runs needing review
- rework loops
- run attempts, costs, changed files, tests, and summaries

The UI can consume Foreman's JSON output initially. A daemon or local service can be introduced later if live updates require it.

The first dispatch UI should be a control surface over explicit Foreman state: enqueue, run, pause, cancel, retry, answer questions, approve plans, and review completed work. It should not be an autonomous tracker monitor.

## Explicitly Out of Scope for This Seed

- Raw Linear/Jira issue auto-dispatch without Foreman chunk context.
- Assuming a tracker issue is a complete agent prompt.
- Tracker polling as the dispatch source of truth.
- Required always-on daemon behavior.
- Large-team workflow ownership rules.
- Multi-user synchronization.
- Production service design.
- Web UI implementation details.
