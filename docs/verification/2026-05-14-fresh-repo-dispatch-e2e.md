# Fresh Repo Dispatch E2E: 2026-05-14

This record covers a real Foreman dispatch verification against a fresh private GitHub repo.

Environment:

- Date: 2026-05-14
- Fresh repo: `git@github.com:mkajander/foreman-e2e-20260514.git`
- Local checkout: `/Users/mkajander/Development/mkdevforge/foreman-e2e-20260514`
- Prepared worktrees: `/Users/mkajander/Development/mkdevforge/foreman-worktrees/foreman-e2e-20260514/*`
- Foreman checkout under test: `/Users/mkajander/Development/mkdevforge/foreman`
- Claude Code: `2.1.34`
- Codex CLI: `codex-cli 0.130.0`
- Bun: `1.3.13`

References checked:

- Codex hooks docs: <https://developers.openai.com/codex/hooks>
- Codex config feature flags: <https://developers.openai.com/codex/config-basic#feature-flags>

## Private Repo Setup

Created and pushed the private repo:

```sh
gh repo create mkajander/foreman-e2e-20260514 --private --source /Users/mkajander/Development/mkdevforge/foreman-e2e-20260514 --remote origin --push
```

Initial `main` commit:

- `e966fcf Initial Foreman E2E repo`

Additional setup commit for the Codex verification task:

- `25b4eae Add Codex dispatch verification task`

## Claude Code Dispatch

First attempted run:

- Run: `run_019e27af-9538-74b9-ad53-451920d1ffca`
- Result: Claude exited immediately and did not attach a session.
- Foreground reproduction showed Claude Code 2.1.34 rejects `--print --output-format stream-json` unless `--verbose` is present.

Fix applied in Foreman:

```sh
claude --print --input-format text --output-format stream-json --verbose --permission-mode acceptEdits
```

Successful run:

- Run: `run_019e27b1-90eb-77eb-b7e9-36a2871a26b0`
- Attempt: `attempt_019e27b1-9159-706c-8817-332b1d905b13`
- Session: `019e27b3-558b-75ca-9594-85db01c74544`
- Tool: `claude-code`
- Model observed: `claude-opus-4-6`
- Events included `queued`, `claimed`, `attempt_prepared`, `prompt_built`, `agent_launched`, `session_attached`, and `succeeded`.
- Active linkage created `E2E-1/greeting-update` with `linked_by: "hook"`.
- `foreman dispatch finish --status succeeded` succeeded.
- Manual `bun test` in the worktree passed: `1 pass, 0 fail`.

Pushed branch:

- Branch: `foreman/E2E-1`
- Commit: `ed4b348 Verify Foreman dispatch E2E`

## Codex Dispatch

First attempted run:

- Run: `run_019e27b5-fc3e-75d5-be39-652618030e3f`
- Result: Codex exited immediately and did not attach a session.
- Foreground reproduction showed Codex CLI 0.130.0 rejects `codex exec --ask-for-approval never ...`; `--ask-for-approval` must be passed before `exec`.

Fix applied in Foreman:

```sh
codex --ask-for-approval never exec --sandbox workspace-write --color never -
```

Codex hook trust setup:

- Used an isolated `CODEX_HOME` at `/Users/mkajander/Development/mkdevforge/foreman-e2e-codex-home-20260514`.
- Copied auth only; did not change the real `~/.codex` hook state.
- Enabled `[features] hooks = true`.
- Added a trusted `hooks.state` entry for the isolated `hooks.json` because Codex 0.130.0 does not run user-installed hooks until trusted.
- Verified a foreground Codex run emitted `hook: Stop` and Foreman captured a linked `codex` session.

Successful dispatch run:

- Run: `run_019e27bc-2e5a-750e-8340-558b64ab9121`
- Attempt: `attempt_019e27bc-2ecb-70ce-b722-b3a1a2cde50b`
- Session: `019e27bc-9ac2-7309-95c3-a5eaf00ad955`
- Tool: `codex`
- Model observed: `gpt-5.4-mini`
- Events included `queued`, `claimed`, `attempt_prepared`, `prompt_built`, `agent_launched`, `session_attached`, and `succeeded`.
- Active linkage created `E2E-2/codex-marker` with `linked_by: "hook"`.
- `foreman dispatch finish --status succeeded` succeeded.
- `bun test` in the worktree passed: `2 pass, 0 fail`.

Pushed branch:

- Branch: `foreman/E2E-2`
- Commit: `e89bdbb Verify Foreman Codex dispatch E2E`

## Observations

- Foreman correctly requires an origin remote before dispatch, and the fresh repo used `foreman-e2e-20260514` as the derived repo name.
- The first failed Claude and Codex attempts remain local SQLite records in `running` state because Foreman does not yet have a terminal failure command for launched attempts without captured sessions.
- Codex 0.130.0 currently warns that `codex_hooks` is deprecated in favor of `[features] hooks = true`, while the public hooks page still shows `codex_hooks` examples.
- Codex user-level hooks require trust state before they execute. For this verification, trust was recorded only in the isolated temporary `CODEX_HOME`.
- Hook error log had no new records from this verification; the only visible historical entry was from 2026-05-06.
