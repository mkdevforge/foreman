# Phase 2a: SQLite Schema

## Goal

Implement the user-scoped SQLite database foundation at `~/.foreman/foreman.db`. This phase proves schema creation, migration bookkeeping, and database constraints without designing ingestion write APIs or user-facing session queries.

## Scope

- Implement `src/db/schema.ts` with PRD migration version `1`.
- Implement `src/db/client.ts` for opening the user database and injectable test database paths.
- Create the full v0 schema from the PRD:
  - `sessions`
  - `prompts`
  - `tool_calls`
  - `usage`
  - `summaries`
  - `session_chunks`
- Create the indexes documented in the PRD.
- Apply connection pragmas needed by the schema:
  - `PRAGMA foreign_keys = ON`
  - `PRAGMA journal_mode = DELETE`
- Set and verify `PRAGMA user_version = 1`.
- Add minimal test-only seed helpers where needed to assert constraints.

## Out of Scope

- Transcript parsing.
- Hook entry points.
- Summary generation.
- Production ingestion/upsert helpers.
- Session query CLI.
- ID-prefix resolution.
- UUIDv7 helper.
- SHA-256 content hash helper.
- Environment probes such as hostname, git remote, or git email.
- `foreman session cost`.
- Review and catalog commands.

## Implementation Notes

- The default user DB path is `~/.foreman/foreman.db`.
- Tests must inject a database path or temporary home so they never touch the developer's real DB.
- Create `~/.foreman/` only when opening the real user database path.
- Keep migrations additive and deterministic.
- Apply `PRAGMA foreign_keys = ON` on every connection, not only during migration.
- Do not build broad query abstractions in this phase. Keep helpers limited to opening, migrating, and test seeding.
- Use ISO 8601 UTC strings in seed data so later phases can reuse fixtures.

## Test Checkpoint

The phase is complete when automated tests cover:

- Fresh database creation.
- Parent directory creation for the real DB path under a temporary home.
- Migration to user version `1`.
- All expected tables exist.
- All expected indexes exist.
- Foreign-key enforcement.
- Required unique constraints:
  - `sessions(source, source_session_id)`
  - `prompts(session_id, content_hash, ts)`
  - `tool_calls(session_id, params_hash, ts)`
  - `session_chunks(session_id, task_id, chunk_id)`
- Cascade delete from sessions to child tables.
- Test database isolation from the developer's real `~/.foreman/foreman.db`.

Manual smoke test:

```sh
bun test tests/db
```

Expected behavior:

- The test database is created and migrated under a temporary path.
- The real user database is not touched.

## Done Criteria

- Phase 2a checkpoint passes.
- `docs/backlog/progress.md` marks Phase 2a as `Done`.
- The real user DB is not touched by tests.
