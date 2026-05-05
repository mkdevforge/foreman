# Phase 2: Session Database

## Goal

Implement the user-scoped SQLite tier at `~/.foreman/foreman.db` without hook ingestion. By the end of this phase, the schema can be migrated, seeded in tests, and queried through session-oriented CLI commands.

## Scope

- Implement `src/db/schema.ts` with PRD migration version `1`.
- Implement `src/db/client.ts` for opening `~/.foreman/foreman.db` and test database paths.
- Implement query helpers for:
  - sessions
  - prompts
  - tool calls
  - usage
  - summaries
  - session_chunks
- Implement shared ID and hash helpers:
  - UUIDv7 IDs
  - SHA-256 content hashes
- Implement environment probes:
  - hostname
  - git remote URL
  - git config user email
- Implement enough session CLI surface to query seeded data:
  - `foreman session list [--since ...] [--project ...] [--source claude-code|codex] [--unattached] [--json]`
  - `foreman session show <prefix> [--full] [--json]`
  - `foreman session last [--full] [--json]`
- Implement ID-prefix resolution with ambiguous-prefix errors.

## Out of Scope

- Transcript parsing.
- Hook entry points.
- Summary generation.
- `foreman session cost`.
- Review and catalog commands.

## Implementation Notes

- Apply `PRAGMA foreign_keys = ON` on every connection.
- Keep migrations additive and deterministic. Tests should verify `PRAGMA user_version`.
- Use `INSERT ... ON CONFLICT` behavior only in query helpers that later ingestion code can reuse.
- Timestamps are ISO 8601 UTC strings.
- Prefix resolution must list candidates on ambiguity and exit `1`, matching the PRD.
- The database path should be injectable in tests to avoid writing to a developer's real `~/.foreman/foreman.db`.

## Test Checkpoint

The phase is complete when automated tests cover:

- Fresh database creation.
- Migration to user version `1`.
- Foreign-key enforcement.
- Inserting seeded sessions, prompts, tool calls, usage, summaries, and chunk links.
- Listing sessions with project/source/unattached filters.
- Showing sessions by full ID and unique prefix.
- Ambiguous prefix errors.
- `session last` ordering by `started_at`.
- JSON output shape for session commands.

Manual smoke test:

```sh
HOME=/tmp/foreman-home foreman session list
HOME=/tmp/foreman-home foreman session list --json
```

## Done Criteria

- Phase 2 checkpoint passes.
- `docs/backlog/progress.md` marks Phase 2 as `Done`.
- The real user DB is not touched by tests.
