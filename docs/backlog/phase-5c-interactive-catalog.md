# Phase 5c: Interactive Catalog

Backlog review: Reviewed.

## Goal

Add the interactive catalog prompt loop on top of the Phase 5b catalog listing and link helpers. This phase makes retroactive linkage ergonomic without changing the underlying catalog data model.

## Scope

- Implement interactive `foreman catalog [--all] [--since <duration>]`.
- For each unattached session in scope, show enough detail to decide: full session id, source, started/ended timestamps, project path, model, cost, and summary.
- Prompt for `<task>/<chunk>`, `skip`, or `quit`.
- Validate entered chunk refs against current repo YAML.
- Link accepted entries with `linked_by = 'catalog'`.
- Keep `--json` non-interactive; JSON catalog output should list candidates and never prompt.

## Out Of Scope

- LLM-powered suggestions.
- Fuzzy task/chunk selection.
- Multi-select/batch UI.
- `foreman session cost`.

## Implementation Notes

- Reuse Phase 5b filtering and one-shot link helpers.
- The prompt loop should be testable with injected stdin/stdout and should not depend on TTY-specific behavior.
- `skip` advances to the next candidate without writing a link.
- `quit` stops the loop without treating remaining candidates as errors.
- Invalid refs should print a clear message and reprompt for the same session.

## Test Checkpoint

The phase is complete when automated tests cover:

- Interactive link path with mocked stdin/stdout.
- Interactive skip path.
- Interactive quit path.
- Invalid chunk ref reprompts for the same candidate.
- JSON catalog mode does not prompt.

Manual smoke test:

```sh
foreman catalog --since 7d
foreman catalog --all
foreman catalog --json
```

## Done Criteria

- Phase 5c checkpoint passes.
- `docs/backlog/progress.md` marks Phase 5c as `Done`.
