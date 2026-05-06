# Phase 3c: Summary, Truncation, And Pricing

Backlog review: Unreviewed. Review this phase before implementation starts.

## Goal

Add derived session data on top of parsed and persisted sessions: summary generation through a provider boundary, deterministic transcript truncation, and v0 cost calculation. Tests must not require network access.

## Decision Gates

Close these in `docs/backlog/progress.md` before implementation starts:

- Summary provider for v0.
- Summary truncation strategy details.
- Pricing table scope and location.

## Scope

- Implement `src/ingest/summarize.ts` or equivalent summary boundary.
- Add a mocked summary provider path for tests.
- Build summary input from parsed transcript content.
- Implement head + tail truncation with an explicit elision marker.
- Upsert summaries because summaries are derived.
- Implement pricing calculation for known v0 models.
- Log or return warnings for unknown pricing models without failing ingestion.
- Store `cost_usd = 0` for unknown pricing models.
- Keep pricing hardcoded for v0 with a clear migration comment.

## Out Of Scope

- Parser fixture expansion except where needed for summary/pricing tests.
- Hook binaries reading real stdin and swallowing errors.
- Active chunk linkage.
- Hook installation.
- Review and catalog commands.
- User-configurable pricing files.

## Implementation Notes

- Network-backed summary providers must be injectable and mocked in automated tests.
- Summary overwrite is allowed because summaries are derived data.
- Keep the truncation algorithm deterministic and easy to test.
- Prefer a compact pricing table module over mixing pricing into parsers.

## Test Checkpoint

The phase is complete when automated tests cover:

- Mocked summary provider without network access.
- Summary upsert.
- Head + tail truncation with elision marker.
- Known model cost calculation.
- Unknown model warning behavior.
- Unknown model cost stored as `0`.
- Re-running ingestion does not duplicate summaries.

Manual smoke test:

```sh
bun test tests/ingest
```

## Done Criteria

- Phase 3c checkpoint passes.
- `docs/backlog/progress.md` marks Phase 3c as `Done`.
- Phase 3 is considered complete after 3a, 3b, and 3c are all `Done`.
