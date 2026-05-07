# Phase 5b: Catalog Listing And One-Shot Linking

Backlog review: Reviewed.

## Goal

Implement non-interactive catalog commands for finding unattached sessions and retroactively linking or unlinking them. This phase proves the catalog data model and repo identity policy before adding the interactive prompt loop.

## Resolved Decisions

- Do not require a Git remote globally.
- Catalog default scope uses the current repo `remote.origin.url` when present.
- Sessions match the current repo when their stored `repo_remote` normalizes to the same remote.
- If the current repo has no remote, default catalog scope is exact current Git root path only.
- `--all` removes the repo/project filter but keeps other filters such as `--since`.
- Hook ingestion should attempt to fill missing `repo_remote` from `remote.origin.url` at `parsed.project_path` before storing the session.
- Do not guess sibling worktrees without a shared remote.

## Scope

- Implement `foreman catalog [--all] [--since <duration>] [--json]` as a non-interactive list of unattached sessions.
- Implement `foreman catalog --link <session-prefix> <task>/<chunk> [--stage <stage>]`.
- Implement `foreman catalog --unlink <session-prefix> <task>/<chunk>`.
- Add repo remote normalization shared by catalog filtering and hook remote fallback.
- Add idempotent catalog link writes using `linked_by = 'catalog'`.

## Out Of Scope

- Interactive catalog prompt loop.
- `foreman review` output changes beyond what is needed to make newly linked sessions visible through existing queries.
- `foreman session cost`.
- LLM-powered catalog suggestions and search.

## Implementation Notes

- `--stage` records the link stage in `session_chunks`; it does not mutate chunk YAML.
- Without `--stage`, use the current chunk YAML stage.
- `--unlink` removes the matching `session_chunks` row and succeeds idempotently when the link is already absent.
- Reserve `linked_by = 'manual'` for a future explicit manual-link surface.
- If current repo has no remote, text output should make the path-only filter visible, for example: `No origin remote found; catalog is limited to this worktree path. Use --all to include other projects.`

## Test Checkpoint

The phase is complete when automated tests cover:

- Catalog listing unattached current-repo sessions by matching `repo_remote`.
- Catalog listing unattached sibling-worktree sessions that share the current repo remote.
- Catalog fallback to exact `project_path` when the current repo has no remote.
- Catalog `--all` includes other projects.
- Catalog `--since` works with the existing duration parser behavior.
- Catalog one-shot link records `linked_by = 'catalog'`.
- Catalog one-shot link with `--stage` records the override without mutating YAML.
- Catalog unlink removes a link and is idempotent.
- Hook ingestion fills missing `repo_remote` from the session project path remote when available.

Manual smoke test:

```sh
foreman catalog --since 7d
foreman catalog --link <session-prefix> FOREMAN-1/yaml-store
foreman catalog --unlink <session-prefix> FOREMAN-1/yaml-store
```

## Done Criteria

- Phase 5b checkpoint passes.
- `docs/backlog/progress.md` marks Phase 5b as `Done`.
