import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CliError } from "../cli/errors";
import { getDispatchRunDetailById, type DispatchAttemptDetail, type DispatchRunDetail } from "../db/dispatch-queries";

export type DispatchWorkspaceInspectionReason =
  | "missing_attempt"
  | "multiple_attempts"
  | "missing_workspace_path"
  | "missing_worktree_branch"
  | "workspace_missing"
  | "workspace_not_directory"
  | "workspace_not_git_root"
  | "branch_mismatch";

export type DispatchDiffMode = "full" | "stat" | "name_only";

export interface DispatchWorkspaceStatusFile {
  path: string;
  index_status: string;
  worktree_status: string;
  original_path: string | null;
}

export interface DispatchWorkspaceCommit {
  hash: string;
  short_hash: string;
  subject: string;
  committed_at: string;
}

export interface DispatchWorkspaceInspection {
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  workspace_path: string;
  expected_branch: string;
  git_root: string;
  branch: string | null;
  branch_matches: boolean;
  dirty: boolean;
  changed_files: DispatchWorkspaceStatusFile[];
  untracked_files: string[];
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  recent_commits: DispatchWorkspaceCommit[];
}

export type InspectDispatchWorkspaceResult =
  | { kind: "inspected"; detail: DispatchRunDetail; attempt: DispatchAttemptDetail; workspace: DispatchWorkspaceInspection }
  | {
      kind: "not_inspectable";
      detail: DispatchRunDetail;
      attempt: DispatchAttemptDetail | null;
      reason: DispatchWorkspaceInspectionReason;
      message: string;
      workspace_path: string | null;
      expected_branch: string | null;
      actual_branch?: string | null;
      git_root?: string | null;
    }
  | { kind: "missing" };

export interface DispatchWorkspaceDiff {
  mode: DispatchDiffMode;
  text: string;
}

export type DispatchWorkspaceDiffResult =
  | { kind: "diff"; detail: DispatchRunDetail; attempt: DispatchAttemptDetail; workspace: DispatchWorkspaceInspection; diff: DispatchWorkspaceDiff }
  | Exclude<InspectDispatchWorkspaceResult, { kind: "inspected" }>;

export function inspectDispatchWorkspace(db: Database, runId: string): InspectDispatchWorkspaceResult {
  const detail = getDispatchRunDetailById(db, runId);

  if (detail === null) {
    return { kind: "missing" };
  }

  const attemptResult = singleAttempt(detail);
  if (attemptResult.kind !== "ok") {
    return attemptResult;
  }

  const { attempt } = attemptResult;
  if (attempt.workspace_path === null) {
    return notInspectable(detail, attempt, "missing_workspace_path", "dispatch attempt has no recorded workspace path", null);
  }

  if (attempt.worktree_branch === null) {
    return notInspectable(
      detail,
      attempt,
      "missing_worktree_branch",
      "dispatch attempt has no recorded worktree branch",
      attempt.workspace_path
    );
  }

  const workspacePath = attempt.workspace_path;
  if (!existsSync(workspacePath)) {
    return notInspectable(detail, attempt, "workspace_missing", `workspace path '${workspacePath}' does not exist`, workspacePath);
  }

  if (!statSync(workspacePath).isDirectory()) {
    return notInspectable(
      detail,
      attempt,
      "workspace_not_directory",
      `workspace path '${workspacePath}' is not a directory`,
      workspacePath
    );
  }

  const gitRootResult = runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  const gitRoot = gitRootResult.status === 0 ? trimToNullable(gitRootResult.stdout) : null;
  if (gitRoot === null || resolve(gitRoot) !== resolve(workspacePath)) {
    return {
      ...notInspectable(
        detail,
        attempt,
        "workspace_not_git_root",
        `workspace path '${workspacePath}' is not the recorded Git worktree root`,
        workspacePath
      ),
      git_root: gitRoot
    };
  }

  const branch = gitOutput(workspacePath, ["branch", "--show-current"]);
  if (branch !== attempt.worktree_branch) {
    return {
      ...notInspectable(
        detail,
        attempt,
        "branch_mismatch",
        `workspace path '${workspacePath}' is on branch '${branch ?? "detached"}'; expected '${attempt.worktree_branch}'`,
        workspacePath
      ),
      expected_branch: attempt.worktree_branch,
      actual_branch: branch,
      git_root: gitRoot
    };
  }

  const changedFiles = parsePorcelainStatus(gitOutputRequired(workspacePath, ["status", "--porcelain=v1", "-z"]));
  const upstream = gitOutput(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const aheadBehind = upstream === null ? { ahead: null, behind: null } : readAheadBehind(workspacePath);
  const workspace: DispatchWorkspaceInspection = {
    run_id: detail.run.id,
    attempt_id: attempt.id,
    attempt_number: attempt.attempt_number,
    workspace_path: workspacePath,
    expected_branch: attempt.worktree_branch,
    git_root: gitRoot,
    branch,
    branch_matches: true,
    dirty: changedFiles.length > 0,
    changed_files: changedFiles,
    untracked_files: changedFiles.filter((file) => file.index_status === "?" && file.worktree_status === "?").map((file) => file.path),
    upstream,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    recent_commits: readRecentCommits(workspacePath)
  };

  return { kind: "inspected", detail, attempt, workspace };
}

export function buildDispatchWorkspaceDiff(
  db: Database,
  runId: string,
  mode: DispatchDiffMode
): DispatchWorkspaceDiffResult {
  const inspected = inspectDispatchWorkspace(db, runId);

  if (inspected.kind !== "inspected") {
    return inspected;
  }

  const args =
    mode === "stat"
      ? ["diff", "--no-ext-diff", "--stat", "HEAD", "--"]
      : mode === "name_only"
        ? ["diff", "--no-ext-diff", "--name-only", "HEAD", "--"]
        : ["diff", "--no-ext-diff", "HEAD", "--"];

  return {
    kind: "diff",
    detail: inspected.detail,
    attempt: inspected.attempt,
    workspace: inspected.workspace,
    diff: {
      mode,
      text: gitOutputRequired(inspected.workspace.workspace_path, args)
    }
  };
}

type SingleAttemptResult =
  | { kind: "ok"; attempt: DispatchAttemptDetail }
  | Exclude<InspectDispatchWorkspaceResult, { kind: "inspected" | "missing" }>;

function singleAttempt(detail: DispatchRunDetail): SingleAttemptResult {
  if (detail.attempts.length === 0) {
    return notInspectable(detail, null, "missing_attempt", "dispatch run has no recorded attempt", null);
  }

  if (detail.attempts.length > 1) {
    return notInspectable(
      detail,
      null,
      "multiple_attempts",
      "dispatch run has multiple attempts; workspace inspection requires exactly one attempt",
      null
    );
  }

  return { kind: "ok", attempt: detail.attempts[0] };
}

function notInspectable(
  detail: DispatchRunDetail,
  attempt: DispatchAttemptDetail | null,
  reason: DispatchWorkspaceInspectionReason,
  message: string,
  workspacePath: string | null
): Exclude<InspectDispatchWorkspaceResult, { kind: "inspected" | "missing" }> {
  return {
    kind: "not_inspectable",
    detail,
    attempt,
    reason,
    message,
    workspace_path: workspacePath,
    expected_branch: attempt?.worktree_branch ?? null
  };
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

function gitOutput(cwd: string, args: string[]): string | null {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    return null;
  }

  return trimToNullable(result.stdout);
}

function gitOutputRequired(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new CliError(2, "dispatch_workspace_git_failed", stderr.length === 0 ? `git ${args.join(" ")} failed` : stderr, {
      command: ["git", ...args],
      cwd
    });
  }

  return result.stdout;
}

function parsePorcelainStatus(output: string): DispatchWorkspaceStatusFile[] {
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const files: DispatchWorkspaceStatusFile[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) {
      continue;
    }

    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const file: DispatchWorkspaceStatusFile = {
      path: entry.slice(3),
      index_status: indexStatus,
      worktree_status: worktreeStatus,
      original_path: null
    };

    if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
      index += 1;
      file.original_path = entries[index] ?? null;
    }

    files.push(file);
  }

  return files;
}

function readAheadBehind(cwd: string): { ahead: number | null; behind: number | null } {
  const output = gitOutput(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  if (output === null) {
    return { ahead: null, behind: null };
  }

  const [ahead, behind] = output.split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null
  };
}

function readRecentCommits(cwd: string): DispatchWorkspaceCommit[] {
  const output = gitOutput(cwd, ["log", "-5", "--format=%H%x1f%h%x1f%s%x1f%cI%x1e"]);
  if (output === null || output.length === 0) {
    return [];
  }

  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash = "", shortHash = "", subject = "", committedAt = ""] = record.split("\x1f");
      return {
        hash,
        short_hash: shortHash,
        subject,
        committed_at: committedAt
      };
    });
}

function trimToNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
