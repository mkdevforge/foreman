# Phase 2b: Session Query CLI

## Goal

Add read-only session CLI commands over the Phase 2a SQLite schema. This phase uses seeded data in tests and does not parse real transcripts or write ingestion-specific rows in production.

## Scope

- Implement read query helpers for:
  - sessions
  - prompts
  - tool calls
  - usage
  - summaries
  - session_chunks
- Implement enough test seed helpers to create representative sessions.
- Implement session CLI commands:
  - `foreman session list [--since ...] [--project ...] [--source claude-code|codex] [--unattached] [--json]`
  - `foreman session show <prefix> [--full] [--json]`
  - `foreman session last [--full] [--json]`
- Implement ID-prefix resolution for session IDs.
- Add ambiguous-prefix errors that list candidates and exit `1`.
- Add text and JSON output for the session commands.

## Out of Scope

- Transcript parsing.
- Hook entry points.
- Summary generation.
- Production ingestion/upsert helpers.
- UUIDv7 helper.
- SHA-256 content hash helper.
- Environment probes such as hostname, git remote, or git email.
- `foreman session cost`.
- Review and catalog commands.

## Resolved Decisions

- Duration filter syntax: `--since` accepts compact relative durations with units `m`, `h`, `d`, and `w`, such as `30m`, `24h`, `7d`, or `2w`.

## Implementation Notes

- Query helpers should be read-oriented and shaped by the session CLI, not by future ingestion assumptions.
- Prefix resolution searches full session IDs and must reject ambiguous matches.
- `session last` sorts by `started_at DESC`, with a deterministic tie-breaker.
- `--full` includes prompts and tool calls; default output should include enough metadata, usage, summary, and linked chunks to be useful without dumping every event.
- `--unattached` means sessions with no rows in `session_chunks`.
- `--since` accepts only compact relative durations: `m` for minutes, `h` for hours, `d` for days, and `w` for weeks.
- Absolute timestamps are out of scope for Phase 2b.
- JSON output must include `schema_version: 1`, snake_case keys, full UUIDs, ISO 8601 timestamps, and explicit nullable fields.
- Text output must avoid ANSI colors and relative timestamps.

## Test Checkpoint

The phase is complete when automated tests cover:

- Listing seeded sessions.
- Listing empty databases cleanly.
- Filtering sessions by project.
- Filtering sessions by source.
- Filtering unattached sessions.
- Filtering by `--since` with `m`, `h`, `d`, and `w` units.
- Rejecting invalid `--since` values.
- Showing sessions by full ID.
- Showing sessions by unique prefix.
- Ambiguous prefix errors with candidates and exit `1`.
- Missing session errors.
- `session last` ordering by `started_at`.
- `--full` including prompts and tool calls.
- Text output shape for list/show/last.
- JSON output shape for list/show/last.

Manual smoke test:

```sh
HOME=/tmp/foreman-home foreman session list
HOME=/tmp/foreman-home foreman session list --json
```

## Done Criteria

- Phase 2b checkpoint passes.
- `docs/backlog/progress.md` marks Phase 2b as `Done`.
- Production ingestion APIs are still deferred to Phases 3a, 3b, and 3c.
