# Phase 0: Project Foundation

## Goal

Create the minimal Bun + TypeScript project structure that every later phase can build on. This phase should not implement Foreman domain behavior beyond command dispatch, output mode plumbing, and shared utilities needed by following phases.

## Scope

- Add `package.json`, `tsconfig.json`, and `bunfig.toml`.
- Add the PRD project layout under `src/` and `tests/`.
- Define executable entry points for:
  - `foreman`
  - `foreman-hook-stop-claude-code`
  - `foreman-hook-stop-codex`
- Implement a small command dispatcher with:
  - global `--help`
  - global `--json`
  - stable unknown-command and invalid-argument exit handling
- Add shared output primitives for text and JSON responses.
- Add shared error types that preserve the PRD exit-code rules.
- Add test harness setup and at least one CLI dispatch test.

## Out of Scope

- Real task YAML behavior.
- Real SQLite schema.
- Real hook parsing or installation.
- Network calls to AI summary providers.

## Implementation Notes

- Keep dependencies aligned with the PRD: Bun, TypeScript, `bun:sqlite`, `yaml`, `@anthropic-ai/sdk`, and `openai` when first needed.
- Delay provider SDK installation until a phase actually uses it unless doing so simplifies build setup without adding runtime behavior.
- Prefer plain TypeScript modules over a CLI framework unless a framework is proven necessary.
- JSON responses must include `schema_version: 1` from the start, even for placeholder responses.

## Test Checkpoint

The phase is complete when these pass:

```sh
bun install
bun run build
bun test
bun run src/cli/index.ts --help
bun run src/cli/index.ts unknown-command
```

Expected behavior:

- Build succeeds.
- Tests pass.
- `--help` exits `0`.
- Unknown command exits `2` with usage-oriented output.
- No domain files are created in `.foreman/` or `~/.foreman/`.

## Done Criteria

- Foundation files are committed.
- `docs/backlog/progress.md` marks Phase 0 as `Done`.
- Any setup deviations from the PRD are documented in this file.
