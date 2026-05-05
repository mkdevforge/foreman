# Foreman — POC PRD (v0)

A supervisor-first CLI for managing AI coding agents. Foreman tracks the lifecycle of a development task (discovery → plan → implement → review) across many agent sessions from Claude Code and Codex, captures every session's transcript, summary, and cost, and gives the supervising developer a single CLI to direct work and review output.

This document is the v0 scope. It is intentionally narrow. Everything not listed under **In Scope** is out of scope for this iteration.

---

## 1. Vision

The dev role is moving from "person typing code" to "person supervising AI agents that type code." That role is closer to a software architect than to a senior engineer: break a unit of work into well-scoped chunks, hand each chunk to an agent in a defined stage, review what comes back, decide whether to accept or send back. Foreman is the supervisor's workspace for that loop.

It is **not**:
- An autonomous agent itself
- A replacement for Jira/Linear (those still hold the canonical ticket)
- A code execution sandbox or CI system

It **is**:
- The place where a Jira/Linear/GH ticket gets broken into agent-sized chunks
- The capture layer for every Claude Code and Codex session
- The view that shows the supervisor what happened, what's where, what needs review, what cost what

---

## 2. Two-tier architecture

Foreman keeps two kinds of data with intentionally different storage:

### Tier 1 — Orchestration (repo-scoped, commit-friendly)
Tasks, chunks, statuses, review notes. Lives in the repo at `.foreman/tasks/<task-id>.yaml`, one file per task. **YAML, not SQLite**, because:
- Humans edit this directly sometimes
- It must diff cleanly in PRs
- Colleagues who clone the repo see the same task list immediately
- Volume is low (dozens of tasks, not thousands of rows)

### Tier 2 — Session capture (user-scoped, never committed)
Session transcripts, summaries, token usage, costs. Lives at `~/.foreman/foreman.db` (single SQLite file). Why user-scoped: this data is private, mechanical, high-volume, and doesn't belong in a shared repo. Each dev has their own session DB; merge tooling comes later.

The CLI joins the two tiers. `foreman review <chunk>` reads chunk metadata from the repo YAML and pulls linked sessions from the user DB. A colleague clones the repo, runs the same command, sees the same chunk metadata but their own session history (empty until they do work).

---

## 3. Object model

```
Task                       (in repo: .foreman/tasks/<id>.yaml)
├── id                     (string, e.g. "JIRA-123" or generated slug)
├── title
├── source_ref             (optional: Jira/Linear/GH URL or key)
├── description
├── status                 (todo|doing|review|done|blocked)
├── created_at, updated_at
└── chunks: [
      Chunk
      ├── id               (slug, unique within task, e.g. "middleware")
      ├── title
      ├── spec             (markdown, the agent-facing brief)
      ├── status           (todo|doing|review|done|blocked)
      ├── stage            (discovery|plan|implement|review)
      ├── notes: [         (review notes, append-only in practice)
      │     { ts, author, body }
      │   ]
      └── created_at, updated_at
    ]

Session                    (in user DB: sessions table)
├── id                     (uuidv7)
├── source                 ('claude-code' | 'codex')
├── source_session_id      (CC's or Codex's own session id)
├── started_at, ended_at
├── project_path, repo_remote
├── model, machine, user_email
├── prompts: [...]
├── tool_calls: [...]
├── usage: { tokens, cost_usd }
└── summary: { md, model_used, generated_at }

SessionChunk               (join table)
├── session_id
├── task_id
├── chunk_id
├── stage                  (the stage the chunk was in when this session ran)
├── linked_at
└── linked_by              ('hook'|'catalog'|'manual')
```

A session can be linked to multiple (task_id, chunk_id) pairs. A chunk can have many linked sessions. The join table makes both directions cheap.

---

## 4. In Scope (v0)

1. **Two `Stop` hooks**: one for Claude Code, one for Codex. Both ingest the session into SQLite, generate a summary via a cheap model (Haiku for Claude sessions, GPT-5-mini-equivalent for Codex sessions, or a single chosen model — see §11), and link the session to the active chunk if one is set.
2. **Soft linkage** via `~/.foreman/active.json`: `foreman work <task>/<chunk>` writes the active context, the hook reads it on Stop, links the session. No wrapper around `claude` or `codex` invocations — they run normally.
3. **Repo-scoped task/chunk management** via YAML files at `.foreman/tasks/<id>.yaml`.
4. **Catalog command** for retroactively linking unattached sessions to chunks.
5. **CLI** with the full surface listed in §7.
6. **Two output modes**: agent-optimized text (default) and strict JSON (`--json`).
7. **Both source tools (Claude Code and Codex) work end-to-end in v0.**

---

## 5. Out of Scope (deliberately)

These will come later. **Do not build them in v0.**

- FTS5 search → v0.1
- Vector search via sqlite-vec → v0.2 (only if FTS5 proves insufficient; Chroma explicitly ruled out)
- `SessionStart` hook for context injection back into new sessions → v0.3
- LLM-powered catalog suggestions (`foreman catalog --suggest`) → v0.4
- Avalonia / TUI / web viewer → separate project, consumes the CLI
- Auto-pull from Jira/Linear/GH APIs → v1
- Auto-create branches per chunk → v1
- Multi-user review workflows / role assignments → v1+
- Cross-machine session sync / merge tooling → v2
- Workflow automation (e.g. auto-advance stage on review approval) → v1+
- HTTP / worker service of any kind
- ChromaDB
- MCP server / tools
- opencode support → after v0 stabilizes
- Subagent tree tracking
- Any Codex-only or Claude-Code-only feature that doesn't have a counterpart on the other tool. v0 must work end-to-end on both.

If unsure whether something belongs in v0, the answer is no.

---

## 6. Architecture

### Stack
- **Bun + TypeScript** for hooks and CLI. Bun for fast cold-start (matters on every Stop), built-in SQLite, native TS execution.
- **`bun:sqlite`** for DB access.
- **`yaml`** package for task file parsing/writing.
- **`@anthropic-ai/sdk`** and **`openai`** for summary calls (one per source — see §11 for the alternative of using a single provider for all summaries).
- No other runtime dependencies unless absolutely necessary.

### Project layout
```
foreman/
├── package.json
├── tsconfig.json
├── bunfig.toml
├── src/
│   ├── hook/
│   │   ├── stop-claude-code.ts    # entry: foreman-hook-stop-claude-code
│   │   └── stop-codex.ts          # entry: foreman-hook-stop-codex
│   ├── cli/
│   │   ├── index.ts               # entry: foreman
│   │   └── commands/
│   │       ├── install.ts
│   │       ├── task.ts            # add, list, show, status
│   │       ├── chunk.ts           # add, list, status, note
│   │       ├── work.ts            # work, stop
│   │       ├── review.ts
│   │       ├── catalog.ts
│   │       ├── session.ts         # list, show, last, cost
│   │       └── ...
│   ├── repo/
│   │   ├── tasks.ts               # read/write .foreman/tasks/*.yaml
│   │   ├── active.ts              # read/write ~/.foreman/active.json
│   │   └── paths.ts               # repo root detection, .foreman/ resolution
│   ├── db/
│   │   ├── schema.ts              # DDL + migrations
│   │   ├── client.ts
│   │   └── queries.ts
│   ├── ingest/
│   │   ├── claude-code.ts         # parses CC JSONL transcripts
│   │   ├── codex.ts               # parses Codex JSONL transcripts
│   │   ├── common.ts              # shared event shape, dedup, upserts
│   │   └── summarize.ts           # AI summary call
│   ├── format/
│   │   ├── text.ts                # default agent-optimized output
│   │   └── json.ts                # strict JSON output
│   └── lib/
│       ├── ids.ts                 # uuidv7
│       ├── hash.ts                # sha256
│       └── env.ts                 # hostname, git config probes
├── tests/
└── README.md
```

### Three binaries, one codebase
- `foreman-hook-stop-claude-code` — invoked by Claude Code on Stop
- `foreman-hook-stop-codex` — invoked by Codex on Stop
- `foreman` — user/agent-facing CLI

For dev, all three run via `bun run`. Distribution as compiled binaries is deferred (script invocation is fine for v0).

---

## 7. CLI surface

### Output philosophy
Two consumers matter: AI agents (default text) and a future Avalonia client (`--json`). Humans reading directly are tertiary — they get agent-optimized text, which is also readable by humans.

**Default text mode rules:**
- Markdown-ish prose with stable structure
- No ANSI colors, no padding, no relative timestamps ("3 hours ago")
- ISO 8601 UTC for all timestamps
- Show full UUIDs at least once per object; short forms for display alongside
- Inline aggressively — agent shouldn't need to chain commands to get the obvious next field

**JSON mode rules (`--json`):**
- snake_case keys
- ISO 8601 strings for timestamps
- Full UUIDs only
- Nullable fields explicitly `null`, never omitted
- `"schema_version": 1` on every top-level response
- Same data as text mode where possible. `--full` works in both modes.

### Commands

#### Setup
- `foreman install [--tool claude-code|codex|all]` — register Stop hooks. Defaults to `all`. Idempotent. Writes to `~/.claude/settings.json` and/or `~/.codex/hooks.json` (or `~/.codex/config.toml` `[hooks]` section, whichever Codex's docs recommend at implementation time — pick one consistently).
- `foreman init` — create `.foreman/` in the current repo with a sane default structure and a `.gitignore` snippet line if needed (most things in `.foreman/` should be committed; nothing in `.foreman/` itself should be ignored unless we add a local-only subdir later).

#### Tasks
- `foreman task add <id> --title "..." [--source-ref ...] [--description ...]` — create task; `<id>` is user-supplied (e.g. `JIRA-123`) or `--auto` to generate a slug.
- `foreman task list [--status ...] [--json]`
- `foreman task show <id> [--json]`
- `foreman task status <id> <todo|doing|review|done|blocked>`

#### Chunks
- `foreman chunk add <task>/<chunk-slug> --title "..." [--spec-file path]` — create chunk under task. Spec is a markdown body.
- `foreman chunk list <task> [--json]`
- `foreman chunk status <task>/<chunk> <todo|doing|review|done|blocked>`
- `foreman chunk stage <task>/<chunk> <discovery|plan|implement|review>` — set the stage independently of status
- `foreman chunk note <task>/<chunk> "..."` — append a review note (timestamped, author = git config user.email)

#### Work context (soft linkage)
- `foreman work <task>/<chunk> [--stage ...]` — write `~/.foreman/active.json`. Optional `--stage` overrides the chunk's current stage for this session only.
- `foreman stop` — clear `~/.foreman/active.json`. (Not to be confused with the hook event; this is the user-facing context-clear.)
- `foreman status` — show what's currently active (no DB writes; just `cat`s active.json prettily).

#### Review
- `foreman review <task>/<chunk> [--full] [--json]` — show chunk metadata (title, spec, status, stage, notes) + all linked sessions grouped by stage, with summaries inline, costs totaled.
- `foreman review <task> [--json]` — task-level review: chunk roll-up + total session cost across the task.

#### Catalog (retroactive linkage)
- `foreman catalog [--all] [--since <duration>] [--json]` — interactive: walk through unattached sessions (filtered to the current repo's `project_path` by default; `--all` to override), show summary, prompt the user for `<task>/<chunk>` or skip. Records linkage with `linked_by='catalog'`.
- `foreman catalog --link <session-prefix> <task>/<chunk> [--stage ...]` — one-shot link.
- `foreman catalog --unlink <session-prefix> <task>/<chunk>` — remove a link.

#### Sessions (the v0-original CLI, namespaced)
- `foreman session list [--since ...] [--project ...] [--source claude-code|codex] [--unattached] [--json]`
- `foreman session show <prefix> [--full] [--json]`
- `foreman session last [--full] [--json]`
- `foreman session cost [--since ...] [--by project|task|chunk|model|source|day] [--json]`

### Error handling
- Unknown commands → exit 2 with usage
- Invalid args → exit 2
- Ambiguous ID prefix → exit 1 with the candidates listed
- DB missing/corrupt → exit 1 with a clear message
- Stable exit codes documented in `--help`

---

## 8. The Stop hooks

Both hooks share most of their logic via `src/ingest/common.ts`. The only differences are: which transcript format to parse, where to find the transcript file, and what cost table to apply.

### Common ingestion flow (per source)
1. Parse stdin JSON payload.
2. Open SQLite, apply pending migrations.
3. Look up existing session by `(source, source_session_id)`. Reuse internal `id` if found; generate UUIDv7 otherwise.
4. Parse the transcript file. Extract metadata, prompts, tool calls, usage totals.
5. Upsert all rows. Use `INSERT ... ON CONFLICT DO NOTHING` keyed on the unique constraints — never duplicate on re-run.
6. Read `~/.foreman/active.json`. If present and the `project_path` matches, insert into `session_chunks` with `linked_by='hook'`. (If active.json's project_path doesn't match the session's cwd, log and skip linking — defensive against stale active context.)
7. Generate summary (truncate transcript to ~50k tokens with head+tail strategy if huge), upsert into `summaries`. Overwrite is fine; summaries are derived.
8. Exit 0.

**The hook must never block agent UX.** Errors are logged to `~/.foreman/logs/hook-errors.log` and the hook exits 0.

### Claude Code Stop hook
- Registered in `~/.claude/settings.json` `hooks.Stop[].hooks[].command` → `foreman-hook-stop-claude-code`
- Payload contract (from CC docs): `session_id`, `transcript_path`, `cwd`, `hook_event_name`
- Transcript at `transcript_path` (also at `~/.claude/projects/<hash>/<session-id>.jsonl`)
- Parse: user turns, assistant turns with `tool_use` blocks, tool_result blocks pair by `tool_use_id`

### Codex Stop hook
- Registered in `~/.codex/hooks.json` (or `~/.codex/config.toml` `[hooks]` — implementer picks based on current Codex docs at implementation time) `hooks.Stop[].hooks[].command` → `foreman-hook-stop-codex`
- Payload includes `session_id` (from `session_meta.payload.id`), `last_assistant_message`, and standard fields per Codex hooks docs at https://developers.openai.com/codex/hooks
- Transcript at `~/.codex/sessions/**/*.jsonl` — find the matching file by `session_id`
- Parse: Codex's JSONL event format (different from CC's; see existing implementations like `hatayama/codex-hooks` for reference, but do not copy code)

### Cost calculation
Per-source pricing tables in `src/ingest/summarize.ts` (or a sibling `pricing.ts`). Hardcoded for v0 with a clear comment about how to update. Out-of-table models get `cost_usd = 0` and a log warning. Document the format so a v0.1 PR can move it to a config file without surgery.

---

## 9. Schema (SQLite, user-scoped)

```sql
PRAGMA user_version = 1;
PRAGMA journal_mode = DELETE;
PRAGMA foreign_keys = ON;

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,        -- uuidv7
  source              TEXT NOT NULL,           -- 'claude-code' | 'codex'
  source_session_id   TEXT NOT NULL,
  started_at          TEXT NOT NULL,           -- ISO 8601 UTC
  ended_at            TEXT NOT NULL,
  project_path        TEXT NOT NULL,
  repo_remote         TEXT,
  model               TEXT,
  machine             TEXT NOT NULL,
  user_email          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (source, source_session_id)
);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_path);
CREATE INDEX idx_sessions_source ON sessions(source);

CREATE TABLE prompts (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts            TEXT NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  UNIQUE (session_id, content_hash, ts)
);
CREATE INDEX idx_prompts_session ON prompts(session_id);

CREATE TABLE tool_calls (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts            TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  result_json   TEXT,
  is_error      INTEGER NOT NULL DEFAULT 0,
  params_hash   TEXT NOT NULL,
  UNIQUE (session_id, params_hash, ts)
);
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_tool ON tool_calls(tool_name);

CREATE TABLE usage (
  session_id              TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL    NOT NULL DEFAULT 0
);

CREATE TABLE summaries (
  session_id    TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary_md    TEXT NOT NULL,
  model_used    TEXT NOT NULL,
  generated_at  TEXT NOT NULL
);

CREATE TABLE session_chunks (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL,
  chunk_id      TEXT NOT NULL,                 -- the chunk slug within the task
  stage         TEXT NOT NULL,                 -- discovery|plan|implement|review
  linked_at     TEXT NOT NULL,
  linked_by     TEXT NOT NULL,                 -- 'hook'|'catalog'|'manual'
  PRIMARY KEY (session_id, task_id, chunk_id)
);
CREATE INDEX idx_session_chunks_task ON session_chunks(task_id, chunk_id);
```

### Schema design decisions, fixed
- **UUIDv7** for session/prompt/tool_call IDs. Time-sortable, future-merge-friendly.
- **Origin stamps** (`machine`, `user_email`, `created_at`) on `sessions`. Enables future merge tooling.
- **Content hashes** on prompts and tool_calls. Trivial dedup on re-run; useful for cross-DB merge later.
- **Append-only** for sessions/prompts/tool_calls. Mutable for summaries and session_chunks (re-link allowed).
- **Many-to-many session→chunk** via join table. A session can span chunks; a chunk has many sessions.
- **All timestamps ISO 8601 UTC strings.**
- **Source-agnostic schema.** Adding opencode later is a new `source` value plus an ingestion adapter. No schema change.

---

## 10. Task YAML schema (repo-scoped)

`.foreman/tasks/<id>.yaml`:

```yaml
schema_version: 1
id: JIRA-123
title: Migrate auth module to OAuth2
source_ref: https://company.atlassian.net/browse/JIRA-123
description: |
  Replace session-based auth with OAuth2 across middleware,
  token handling, tests, and integration layer.
status: doing
created_at: 2026-05-05T10:00:00Z
updated_at: 2026-05-05T14:32:00Z
chunks:
  - id: middleware
    title: Update middleware to validate OAuth tokens
    spec: |
      The middleware currently checks session cookies. Replace with
      Bearer token validation against the OAuth provider...
    status: doing
    stage: implement
    created_at: 2026-05-05T10:05:00Z
    updated_at: 2026-05-05T14:32:00Z
    notes:
      - ts: 2026-05-05T13:15:00Z
        author: mikael@example.com
        body: |
          Initial implement looks good but missing the JWT signature
          validation step. Sending back to implement.
  - id: token-handling
    title: Rewrite token storage and refresh logic
    spec: ...
    status: todo
    stage: discovery
    created_at: 2026-05-05T10:06:00Z
    updated_at: 2026-05-05T10:06:00Z
    notes: []
```

YAML is read fully into memory and rewritten on every edit. Atomic write via temp-file-and-rename to avoid corruption on crash. No locking — git is the conflict resolution layer.

---

## 11. Reference material

The user has placed a clone of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) in `./references/claude-mem/`. **This directory is gitignored.** It exists for your reading reference only — do not import, copy, or vendor any code from it.

There may also be reference value in [hatayama/codex-hooks](https://github.com/hatayama/codex-hooks) for understanding how Codex's session JSONL format differs from Claude Code's.

### What to study from claude-mem
- Transcript JSONL parsing for Claude Code (their `src/` has the patterns)
- Tool call detection in CC transcripts (`tool_use` / `tool_result` pairing by `tool_use_id`)
- Usage / cost extraction from assistant turns
- General Stop hook entry-point shape

### What to ignore from claude-mem
**Do not replicate any of these:**
- Their worker HTTP service on port 37777
- ChromaDB / vector embeddings
- The web viewer UI
- The MCP server / `search` / `timeline` / `get_observations` tools
- The 5-hook surface (we only need Stop)
- The mode system (`code`, `code--zh`, etc.) and i18n
- Beta channels / Endless Mode
- The plugin marketplace install flow
- Anything OpenClaw-related

If a feature in claude-mem is not in our **In Scope** section, it does not belong in v0.

---

## 12. Acceptance criteria

v0 is done when, on a clean machine:

1. `bun install && bun run build` produces working hook + CLI scripts.
2. `foreman install` registers Stop hooks in both `~/.claude/settings.json` and Codex's hooks config, idempotently. Re-running doesn't duplicate or clobber unrelated entries.
3. `foreman init` creates `.foreman/` in the current repo.
4. `foreman task add` and `foreman chunk add` create well-formed YAML files that round-trip correctly.
5. After running a real Claude Code session with `foreman work <task>/<chunk>` set, the Stop hook fires, the session row appears in SQLite, and a `session_chunks` row links it to the active chunk.
6. Same scenario works for a real Codex session.
7. `foreman review <task>/<chunk>` shows the chunk YAML metadata + linked sessions sorted by stage, with summaries and costs.
8. `foreman catalog` lists unattached sessions for the current repo and supports interactive linking.
9. `foreman session cost --by source` shows correct breakdown across Claude Code and Codex sessions.
10. All commands have a `--json` mode that returns valid JSON matching the documented shape.
11. Re-running a hook on the same `(source, source_session_id)` does not duplicate prompts, tool_calls, or session_chunks rows (idempotency holds).
12. Hook never blocks the agent on errors — malformed payloads or missing transcripts log to `~/.foreman/logs/hook-errors.log` and exit 0.
13. There is a basic test suite covering: transcript parsing for both sources, schema migrations, dedup-on-rerun, soft-link-on-stop, catalog interactive flow (mocked stdin), and CLI output shape (both modes).

---

## 13. Forward-compatibility notes (non-binding for v0)

- **opencode** slots in as a new `source` value plus a third ingestion adapter and a third hook entry point. No schema change.
- **FTS5 search** (v0.1) adds a virtual table over `prompts.content`, `summaries.summary_md`, and chunk specs/notes (chunk content is loaded from YAML at index time). Additive migration. Surfaced as `foreman search "<query>" [--scope sessions|tasks|all] [--json]`.
- **Vector search via `sqlite-vec`** (v0.2, *only if FTS5 proves insufficient*) adds vector columns alongside FTS5 in the same SQLite file. Embeddings generated on Stop hook (one extra API call per session, fractions of a cent). Hybrid ranking: FTS5 results unioned with vector results, deduped, scored. Rationale: Foreman's expected scale is ~20k vectors after five years of heavy use (one per summary, one per chunk spec, one per note); sqlite-vec brute-force handles that in single-digit milliseconds, and the IPC tax of a separate vector process would exceed the search time itself. The "one stop shop" principle is better served by one SQLite file than by a multi-store combination. If Foreman ever exceeds ~1M vectors, sqlite-vec's ANN indexes (DiskANN, IVF) cover that ceiling without leaving the SQLite ecosystem.
  - **Backend abstraction.** v0.2 introduces a `VectorStore` interface (`upsert`, `search`) with sqlite-vec as the only implementation in v0.2. Hook and search code calls the interface, never sqlite-vec directly. This keeps the door open for a future swap to Qdrant (Rust-based, embedded mode available, hybrid search built in — the most natural fit for this stack if a swap is needed), Chroma, or another store, without hunting through the codebase. Do not add the abstraction earlier than v0.2 — there's no second implementation to design against until then.
- **Context injection on SessionStart** (v0.3) reads the most recent N summaries linked to the active chunk and writes them into a context file the agent picks up. The data is already there.
- **LLM-suggested catalog** (v0.4) reuses summaries + chunk specs to propose links. No data model change, just a new flag on `catalog`.
- **Cross-machine merge tooling** (v2): the schema's content hashes and `(source, source_session_id)` unique constraint make this a row-by-row insert-or-skip operation.
- **Auto-pull from Jira/Linear/GH** (v1) writes the same task YAML structure; the source_ref field is already there.

---

## 14. Open questions for the implementer to resolve

1. **Single summary provider vs per-source.** Using Anthropic Haiku for both Claude and Codex sessions is simpler (one SDK, one API key, consistent summary style). Using each provider's own cheap model is more "natural" but adds a dependency. **Recommendation: use Anthropic Haiku for all summaries in v0.** Document the choice; users can swap later.
2. **Codex hooks config format.** Codex supports both `~/.codex/hooks.json` and inline `[hooks]` in `~/.codex/config.toml`. Pick one and use it consistently in `foreman install`. Whichever Codex's docs recommend at implementation time wins.
3. **Transcript truncation strategy for the summary.** Cap input at ~50k tokens. Recommended: head + tail with a `[... N records elided ...]` marker. Document the chosen strategy in code comments.
4. **Tool call pairing.** For Claude Code, `tool_use` blocks (in assistant messages) and `tool_result` blocks (in user messages) tie together by `tool_use_id`. Store as a single `tool_calls` row with both sides. For Codex, find the analogous pairing in its JSONL format and document it. If a tool_use has no matching tool_result (interrupted session), still write the row with `result_json = null` and `is_error = 0`.
5. **Active context staleness.** What happens if `~/.foreman/active.json` is from yesterday and the user forgot to `foreman stop`? Recommendation: include a timestamp in active.json; if older than 24h, the hook ignores it and logs. User can manually link via catalog.
6. **Pricing table location.** Inline in code is fine for v0. Document a clear path to migrating to `~/.foreman/pricing.json` for v0.1.
7. **Hostname source.** `os.hostname()` is fine; document in code.
8. **`foreman init` defaults.** Should it create a sample task file? Recommendation: no, just create the empty `.foreman/tasks/` directory and a `README.md` explaining the structure.

---

## 15. A note on style and ergonomics

The agent reading this PRD will consume CLI output too. Optimize agent ergonomics:

- Default text output should be dense but parseable — section headers with `##`, sub-objects with `###`, key facts on their own lines as `key: value`, no fancy formatting.
- Always print full UUIDs at least once per object; short IDs are fine for repeated mentions.
- When listing things (sessions, chunks, tasks), put the most-likely-needed-next info inline so the agent doesn't have to chain commands.
- `--json` is for the future Avalonia client and any scripted consumers. Same data, structured.

The goal is that an agent invoking `foreman review JIRA-123/middleware` once gets enough information to write a useful comment back to its supervisor without needing a follow-up call. That's the bar.
