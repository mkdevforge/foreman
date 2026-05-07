# Release Pass: 2026-05-07

This record covers Phase 6d final release verification for Foreman v0.

Environment:

- Date: 2026-05-07
- Source checkout: `/Users/mkajander/Development/mkdevforge/foreman`
- Verification copy: `/tmp/foreman-release-pass-BixBKv/foreman`
- Method: copied the current working tree to a temporary directory excluding `.git`, `node_modules`, and `.DS_Store`; then ran install/build/test from that clean copy.

## Commands And Results

```sh
bun install
# exit 0
# 8 packages installed

bun run build
# exit 0
# tsc --noEmit

bun test
# exit 0
# 95 pass
# 2 skip
# 0 fail
# 839 expect() calls
# Ran 97 tests across 15 files.

bun run foreman --help
# exit 0

bun run foreman-hook-stop-claude-code --help
# exit 0

bun run foreman-hook-stop-codex --help
# exit 0
```

The two skipped tests are the opt-in Phase 3c real summary harness smoke tests. Real Claude Code and Codex Stop hook capture/linkage are recorded separately in `2026-05-07-real-tool-verification.md`.

## Acceptance State

- Build works from a clean copy.
- Hook and CLI scripts are runnable through package bin entries.
- Hook installation idempotency is covered by automated tests.
- Repo initialization, task YAML, chunk YAML, and unknown-field round trips are covered by automated tests.
- Claude Code Stop hook capture/linkage was manually verified.
- Codex Stop hook capture/linkage was manually verified.
- Review output includes chunk metadata, linked sessions, summaries where available, and costs.
- Catalog interactive linking is covered by automated tests.
- Session cost by source is covered by automated tests.
- JSON mode is covered by Phase 6a acceptance tests across all JSON-capable commands.
- Hook re-run deduplication and hook error exit behavior are covered by automated tests and real-tool verification.
- Parser, migration, dedup, soft-link-on-stop, catalog flow, and CLI output-shape coverage exists.

## Out-Of-Scope Check

The v0 CLI exposes:

- `init`
- `install`
- `work`
- `stop`
- `status`
- `review`
- `catalog`
- `task`
- `chunk`
- `session`

The following PRD out-of-scope items were not implemented as v0 CLI surfaces:

- full-text search
- dispatch orchestration
- tracker integrations
- Avalonia, TUI, web, or MCP UI clients
- LLM-powered catalog suggestions
- exact enterprise billing reconciliation
