# Real Tool Verification: 2026-05-07

This record covers Phase 6c real-tool verification for Foreman v0.

Environment:

- Date: 2026-05-07
- Host: macOS, `Mikaels-MacBook-Air.local`
- Foreman checkout: `/Users/mkajander/Development/mkdevforge/foreman`
- Verification used temporary Git repos and temporary Foreman homes under `/tmp`.
- Real user hook config files were not mutated.

Sources checked:

- Codex hooks docs: <https://developers.openai.com/codex/hooks>
- Local Claude Code CLI help from `npm exec --yes @anthropic-ai/claude-code -- --help`

## Codex Stop Hook

Tool version:

```sh
codex --version
# codex-cli 0.125.0
```

Setup:

- Created a temporary Git repo with origin `git@example.com:mkdevforge/foreman-phase6.git`.
- Created a temporary HOME and CODEX_HOME.
- Copied the real Codex auth file into the temporary CODEX_HOME.
- Ran `foreman init`, created task `FOREMAN-REAL`, created chunk `FOREMAN-REAL/codex-stop`, and ran `foreman work FOREMAN-REAL/codex-stop --stage review`.
- Ran `foreman install --tool codex` against the temporary HOME/CODEX_HOME.

Command:

```sh
HOME="$tmp/home" CODEX_HOME="$tmp/home/.codex" \
  codex --disable plugins exec \
  --sandbox read-only \
  --skip-git-repo-check \
  --ignore-rules \
  --json \
  "Return exactly FOREMAN_CODEX_STOP_LINK_OK and nothing else."
```

Observed behavior:

- Codex exited `0`.
- Codex emitted a Stop hook payload with `transcript_path: null`.
- Foreman located the Codex transcript from the session id.
- `foreman session list --json` showed one `codex` session.
- The session had `repo_remote: "git@example.com:mkdevforge/foreman-phase6.git"`.
- The session linked to `FOREMAN-REAL/codex-stop` with `stage: "review"` and `linked_by: "hook"`.
- `foreman review FOREMAN-REAL/codex-stop --json` showed the linked session under `linked_sessions_by_stage`.
- No Foreman hook errors were logged.

Relevant observed output:

```json
{
  "source": "codex",
  "model": "gpt-5.5",
  "linked_chunks": [
    {
      "task_id": "FOREMAN-REAL",
      "chunk_id": "codex-stop",
      "stage": "review",
      "linked_by": "hook"
    }
  ]
}
```

Note:

- Codex stderr included `failed to record rollout items: thread ... not found`, but the Codex command still exited `0` and Foreman capture/linkage succeeded.

## Claude Code Stop Hook

Tool version:

```sh
claude --version
# 2.1.34 (Claude Code)
```

Setup:

- The direct Claude Code binary resolved to `/Users/mkajander/.local/bin/claude`.
- The first non-interactive verification exposed that the Codex execution shell PATH could omit `~/.local/bin`; Foreman's summary provider now resolves default harness commands from PATH plus common user-bin directories.
- The Claude Code npm entrypoint was also available through `npm exec --yes @anthropic-ai/claude-code`.
- To avoid mutating real user settings or Foreman DB state, the verification used:
  - real HOME for Claude auth
  - a temporary `--settings` file containing the Foreman Stop hook
  - a hook wrapper that set `HOME` to the temporary Foreman home before executing `foreman-hook-stop-claude-code`
- Created a temporary Git repo with origin `git@example.com:mkdevforge/foreman-phase6.git`.
- Ran `foreman init`, created task `FOREMAN-REAL`, created chunk `FOREMAN-REAL/claude-stop`, and ran `foreman work FOREMAN-REAL/claude-stop --stage review` using the temporary Foreman HOME.

Command:

```sh
printf '%s\n' 'Return exactly FOREMAN_CLAUDE_STOP_LINK_OK and nothing else.' |
  npm exec --yes @anthropic-ai/claude-code -- \
  --print \
  --output-format text \
  --input-format text \
  --model haiku \
  --tools "" \
  --settings "$tmp/foreman-home/.claude/settings.json"
```

Observed behavior:

- Claude Code exited `0`.
- stdout was exactly `FOREMAN_CLAUDE_STOP_LINK_OK`.
- Foreman ingested one `claude-code` session from the real Claude Code transcript.
- The session had `repo_remote: "git@example.com:mkdevforge/foreman-phase6.git"`.
- The session linked to `FOREMAN-REAL/claude-stop` with `stage: "review"` and `linked_by: "hook"`.
- `foreman review FOREMAN-REAL/claude-stop --json` showed the linked session under `linked_sessions_by_stage`.
- The initial Claude Stop run logged a degraded `summary` hook error because the non-interactive environment did not resolve the direct `claude` binary.
- The summary resolution issue was fixed and verified in the real summary harness follow-up below.
- Claude Code still exited `0`, confirming hook failures do not block the source tool.

Relevant observed output:

```json
{
  "source": "claude-code",
  "model": "claude-haiku-4-5-20251001",
  "summary": null,
  "linked_chunks": [
    {
      "task_id": "FOREMAN-REAL",
      "chunk_id": "claude-stop",
      "stage": "review",
      "linked_by": "hook"
    }
  ]
}
```

Initial hook error record observed:

```json
{
  "source": "claude-code",
  "phase": "summary",
  "error": "claude summary harness exited 1: no stderr"
}
```

## Summary Harness Follow-up

Command:

```sh
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/mkajander/.bun/bin" \
  bun run test:real-harness
```

Observed behavior:

- The opt-in real harness tests were run, not skipped.
- The test PATH deliberately omitted `/Users/mkajander/.local/bin`.
- The Claude summary harness used the installed `/Users/mkajander/.local/bin/claude` binary and returned the expected `FOREMAN_CLAUDE_SMOKE_OK` sentinel.
- The Codex summary harness used the installed `/opt/homebrew/bin/codex` binary and returned the expected `FOREMAN_CODEX_SMOKE_OK` sentinel.
- Result: 2 pass, 0 fail.

## Contract Observations

- Codex Stop payloads may provide `transcript_path: null`; Foreman's fallback transcript lookup is required and worked.
- Codex hook commands ran with the session working directory, matching the Codex hooks documentation.
- Claude Code `--print` mode fired Stop hooks and provided a transcript path.
- Foreman preserved capture/linkage when derived summary data failed.
