import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { v7 as uuidv7 } from "uuid";
import { CliError } from "../cli/errors";
import { getDispatchRunDetailById, type DispatchAttemptDetail, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent, updateDispatchRunStatus } from "../db/dispatch-writes";
import { inspectDispatchWorkspace, type DispatchWorkspaceInspection } from "./workspace";

type IdGenerator = () => string;
type NowGenerator = () => string;

export interface MergeDispatchRunOptions {
  controlRepoRoot: string;
  repoName: string;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export interface DispatchMerge {
  run_id: string;
  attempt_id: string;
  control_repo_root: string;
  control_branch: string | null;
  workspace_path: string;
  worktree_branch: string;
  previous_head: string;
  new_head: string;
  merged_sha: string;
  changed: boolean;
  fast_forward: boolean;
  merged_at: string | null;
}

export type MergeDispatchRunResult =
  | { kind: "merged"; detail: DispatchRunDetail; attempt: DispatchAttemptDetail; workspace: DispatchWorkspaceInspection; merge: DispatchMerge }
  | {
      kind: "already_merged";
      detail: DispatchRunDetail;
      attempt: DispatchAttemptDetail;
      workspace: DispatchWorkspaceInspection;
      merge: DispatchMerge;
    }
  | { kind: "missing" }
  | { kind: "repo_mismatch"; detail: DispatchRunDetail; expectedRepoName: string; actualRepoName: string | null }
  | { kind: "not_mergeable"; detail: DispatchRunDetail; attempt: DispatchAttemptDetail | null; reason: string };

export function mergeDispatchRun(db: Database, runId: string, options: MergeDispatchRunOptions): MergeDispatchRunResult {
  const existing = getDispatchRunDetailById(db, runId);
  if (existing === null) {
    return { kind: "missing" };
  }

  if (existing.run.repo_name === null) {
    return { kind: "not_mergeable", detail: existing, attempt: null, reason: "missing_repo_name" };
  }

  if (existing.run.repo_name !== options.repoName) {
    return {
      kind: "repo_mismatch",
      detail: existing,
      expectedRepoName: existing.run.repo_name,
      actualRepoName: options.repoName
    };
  }

  const finishable = validateMergeableStatus(existing);
  if (finishable !== null) {
    return finishable;
  }

  const inspected = inspectDispatchWorkspace(db, runId);
  if (inspected.kind === "missing") {
    return { kind: "missing" };
  }

  if (inspected.kind === "not_inspectable") {
    return {
      kind: "not_mergeable",
      detail: inspected.detail,
      attempt: inspected.attempt,
      reason: `workspace_${inspected.reason}`
    };
  }

  if (inspected.workspace.dirty) {
    return {
      kind: "not_mergeable",
      detail: inspected.detail,
      attempt: inspected.attempt,
      reason: "workspace_dirty"
    };
  }

  if (gitOutput(options.controlRepoRoot, ["status", "--porcelain=v1", "-z"]) !== "") {
    return {
      kind: "not_mergeable",
      detail: inspected.detail,
      attempt: inspected.attempt,
      reason: "control_repo_dirty"
    };
  }

  const previousHead = gitOutputRequired(options.controlRepoRoot, ["rev-parse", "HEAD"]);
  const branchHead = gitOutputRequired(options.controlRepoRoot, ["rev-parse", inspected.workspace.expected_branch]);
  const controlBranch = gitOutput(options.controlRepoRoot, ["branch", "--show-current"]) || null;

  if (isAncestor(options.controlRepoRoot, branchHead, "HEAD")) {
    return {
      kind: "already_merged",
      detail: inspected.detail,
      attempt: inspected.attempt,
      workspace: inspected.workspace,
      merge: {
        run_id: inspected.detail.run.id,
        attempt_id: inspected.attempt.id,
        control_repo_root: options.controlRepoRoot,
        control_branch: controlBranch,
        workspace_path: inspected.workspace.workspace_path,
        worktree_branch: inspected.workspace.expected_branch,
        previous_head: previousHead,
        new_head: previousHead,
        merged_sha: branchHead,
        changed: false,
        fast_forward: true,
        merged_at: null
      }
    };
  }

  if (!isAncestor(options.controlRepoRoot, "HEAD", branchHead)) {
    return {
      kind: "not_mergeable",
      detail: inspected.detail,
      attempt: inspected.attempt,
      reason: "non_fast_forward"
    };
  }

  runGitRequired(options.controlRepoRoot, ["merge", "--ff-only", inspected.workspace.expected_branch], "dispatch_merge_failed");

  const timestamp = (options.now ?? defaultNow)();
  const idGenerator = options.idGenerator ?? uuidv7;
  const newHead = gitOutputRequired(options.controlRepoRoot, ["rev-parse", "HEAD"]);
  const eventId = `evt_${idGenerator()}`;

  const merged = db.transaction(() => {
    const updated = updateDispatchRunStatus(db, {
      id: runId,
      status: "succeeded",
      updatedAt: timestamp,
      expectedStatus: "succeeded"
    });

    if (updated !== 1) {
      const detail = getDispatchRunDetailById(db, runId);
      return detail === null
        ? ({ kind: "missing" } satisfies MergeDispatchRunResult)
        : ({ kind: "not_mergeable", detail, attempt: null, reason: "status_changed" } satisfies MergeDispatchRunResult);
    }

    insertDispatchEvent(db, {
      id: eventId,
      runId,
      attemptId: inspected.attempt.id,
      ts: timestamp,
      type: "merged",
      message: "Merged dispatch worktree branch into control repo.",
      dataJson: JSON.stringify({
        previous_head: previousHead,
        new_head: newHead,
        merged_sha: branchHead,
        worktree_branch: inspected.workspace.expected_branch,
        workspace_path: inspected.workspace.workspace_path,
        control_repo_root: options.controlRepoRoot,
        control_branch: controlBranch,
        fast_forward: true
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`merged dispatch run '${runId}' could not be read back`);
    }

    return {
      kind: "merged",
      detail,
      attempt: inspected.attempt,
      workspace: inspected.workspace,
      merge: {
        run_id: detail.run.id,
        attempt_id: inspected.attempt.id,
        control_repo_root: options.controlRepoRoot,
        control_branch: controlBranch,
        workspace_path: inspected.workspace.workspace_path,
        worktree_branch: inspected.workspace.expected_branch,
        previous_head: previousHead,
        new_head: newHead,
        merged_sha: branchHead,
        changed: true,
        fast_forward: true,
        merged_at: timestamp
      }
    } satisfies MergeDispatchRunResult;
  });

  return merged.immediate();
}

function validateMergeableStatus(detail: DispatchRunDetail): Extract<MergeDispatchRunResult, { kind: "not_mergeable" }> | null {
  if (detail.run.status !== "succeeded") {
    return { kind: "not_mergeable", detail, attempt: null, reason: "run_status_not_succeeded" };
  }

  if (detail.attempts.length === 0) {
    return { kind: "not_mergeable", detail, attempt: null, reason: "missing_attempt" };
  }

  if (detail.attempts.length > 1) {
    return { kind: "not_mergeable", detail, attempt: null, reason: "multiple_attempts" };
  }

  const attempt = detail.attempts[0];
  if (attempt.status !== "succeeded") {
    return { kind: "not_mergeable", detail, attempt, reason: "attempt_status_not_succeeded" };
  }

  return null;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.status === 0;
}

interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function gitOutput(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

function gitOutputRequired(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new CliError(2, "dispatch_merge_git_failed", stderr.length === 0 ? `git ${args.join(" ")} failed` : stderr, {
      command: ["git", ...args],
      cwd
    });
  }

  return result.stdout.trim();
}

function runGitRequired(cwd: string, args: string[], code: string): void {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new CliError(2, code, stderr.length === 0 ? `git ${args.join(" ")} failed` : stderr, {
      command: ["git", ...args],
      cwd
    });
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}
