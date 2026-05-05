# Phase 0: Project Foundation

## Goal

Create the smallest Bun + TypeScript foundation that proves Foreman's command entry points, build, tests, and output envelope. This phase should avoid domain behavior and avoid scaffolding files that do not contain real implementation.

## Scope

- Add `package.json`, `tsconfig.json`, and `bunfig.toml`.
- Add only the source and test files needed for this phase.
- Define runnable package `bin` entry points for:
  - `foreman`
  - `foreman-hook-stop-claude-code`
  - `foreman-hook-stop-codex`
- Implement a small command dispatcher with:
  - global `--help`
  - global `--json`
  - stable unknown-command and invalid-argument exit handling
- Implement hook entry stubs with predictable help or not-implemented behavior.
- Add shared output primitives for text and JSON responses.
- Add shared error types that preserve the PRD exit-code rules.
- Add test harness setup and focused dispatch/output tests.

## Out of Scope

- Real task YAML behavior.
- Real SQLite schema.
- Real hook parsing or installation.
- Full PRD directory skeleton.
- Network calls to AI summary providers.
- Provider SDK dependencies.

## Implementation Notes

- Keep dependencies minimal. Add runtime dependencies only in the phase that uses them.
- Use Commander for command routing and option parsing.
- Argument parsing stance for v0:
  - global flags are accepted in any position
  - global flags are limited to `--help`, `-h`, and `--json`
  - command paths are Commander subcommands, such as `task add` or `session list`
  - command handlers own command-specific flag validation
  - Foreman-owned wrappers control output formatting, JSON error envelopes, and exit-code policy
  - if Commander does not handle required global flag placement cleanly, use a tiny pre-pass for global flags instead of writing a full parser
  - do not add parser behavior not needed by v0
- Treat `bun run build` as type-checking plus any lightweight validation needed for script distribution. Compiled binary distribution is not part of v0 Phase 0.
- JSON responses and JSON-formatted errors must include `schema_version: 1`.
- Text output must avoid ANSI colors from the start.

## Test Checkpoint

The phase is complete when these pass:

```sh
bun install
bun run build
bun test
bun run foreman --help
bun run foreman --json unknown-command
bun run foreman-hook-stop-claude-code --help
bun run foreman-hook-stop-codex --help
```

Expected behavior:

- Build succeeds.
- Tests pass.
- `--help` exits `0`.
- Unknown command exits `2` with usage-oriented output.
- Global flags work before and after the command path.
- Unknown command with `--json` exits `2` with valid JSON.
- Hook stubs are runnable and do not ingest, install, or write files.
- No domain files are created in `.foreman/` or `~/.foreman/`.

## Done Criteria

- Foundation files are committed.
- `docs/backlog/progress.md` marks Phase 0 as `Done`.
- Any setup deviations from the PRD are documented in this file.
