import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { v7 as uuidv7 } from "uuid";
import { CliError } from "../cli/errors";
import { getDispatchRunDetailById, type DispatchAttemptDetail, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent } from "../db/dispatch-writes";
import { inspectDispatchWorkspace, type DispatchWorkspaceInspection } from "./workspace";

type IdGenerator = () => string;
type NowGenerator = () => string;

const CLEANUP_RUN_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export interface CleanupDispatchRunOptions {
  controlRepoRoot: string;
  repoName: string;
  force?: boolean;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export interface DispatchCleanup {
  run_id: string;
  attempt_id: string;
  control_repo_root: string;
  control_branch: string | null;
  workspace_path: string;
  worktree_branch: string;
  force: boolean;
  changed: boolean;
  workspace_removed: boolean;
  branch_deleted: boolean;
  branch_delete_skipped_reason: string | null;
  cleaned_at: string | null;
}

export type CleanupDispatchRunResult =
  | {
      kind: "cleaned";
      detail: DispatchRunDetail;
      attempt: DispatchAttemptDetail;
      workspace: DispatchWorkspaceInspection;
      cleanup: DispatchCleanup;
    }
  | { kind: "already_cleaned"; detail: DispatchRunDetail; attempt: DispatchAttemptDetail; cleanup: DispatchCleanup }
  | { kind: "missing" }
  | { kind: "repo_mismatch"; detail: DispatchRunDetail; expectedRepoName: string; actualRepoName: string | null }
  | { kind: "not_cleanupable"; detail: DispatchRunDetail; attempt: DispatchAttemptDetail | null; reason: string };

export function cleanupDispatchRun(
  db: Database,
  runId: string,
  options: CleanupDispatchRunOptions
): CleanupDispatchRunResult {
  const existing = getDispatchRunDetailById(db, runId);
  if (existing === null) {
    return { kind: "missing" };
  }

  if (existing.run.repo_name === null) {
    return { kind: "not_cleanupable", detail: existing, attempt: null, reason: "missing_repo_name" };
  }

  if (existing.run.repo_name !== options.repoName) {
    return {
      kind: "repo_mismatch",
      detail: existing,
      expectedRepoName: existing.run.repo_name,
      actualRepoName: options.repoName
    };
  }

  if (!CLEANUP_RUN_STATUSES.has(existing.run.status)) {
    return { kind: "not_cleanupable", detail: existing, attempt: null, reason: "run_status_not_terminal" };
  }

  const inspected = inspectDispatchWorkspace(db, runId);
  if (inspected.kind === "missing") {
    return { kind: "missing" };
  }

  if (inspected.kind === "not_inspectable") {
    if (inspected.reason === "workspace_missing" && inspected.attempt !== null && hasCleanupEvent(inspected.detail, inspected.attempt.id)) {
      const controlBranch = gitOutput(options.controlRepoRoot, ["branch", "--show-current"]) || null;
      return {
        kind: "already_cleaned",
        detail: inspected.detail,
        attempt: inspected.attempt,
        cleanup: {
          run_id: inspected.detail.run.id,
          attempt_id: inspected.attempt.id,
          control_repo_root: options.controlRepoRoot,
          control_branch: controlBranch,
          workspace_path: inspected.workspace_path ?? inspected.attempt.workspace_path ?? "",
          worktree_branch: inspected.expected_branch ?? inspected.attempt.worktree_branch ?? "",
          force: options.force ?? false,
          changed: false,
          workspace_removed: false,
          branch_deleted: false,
          branch_delete_skipped_reason: "already_cleaned",
          cleaned_at: null
        }
      };
    }

    return {
      kind: "not_cleanupable",
      detail: inspected.detail,
      attempt: inspected.attempt,
      reason: `workspace_${inspected.reason}`
    };
  }

  if (inspected.workspace.dirty && options.force !== true) {
    return {
      kind: "not_cleanupable",
      detail: inspected.detail,
      attempt: inspected.attempt,
      reason: "workspace_dirty"
    };
  }

  if (inspected.detail.run.status === "succeeded" && options.force !== true) {
    const branchHead = gitOutput(options.controlRepoRoot, ["rev-parse", inspected.workspace.expected_branch]);
    if (branchHead === null) {
      return {
        kind: "not_cleanupable",
        detail: inspected.detail,
        attempt: inspected.attempt,
        reason: "missing_worktree_branch_ref"
      };
    }

    if (!isAncestor(options.controlRepoRoot, branchHead, "HEAD")) {
      return {
        kind: "not_cleanupable",
        detail: inspected.detail,
        attempt: inspected.attempt,
        reason: "branch_not_merged"
      };
    }
  }

  const controlBranch = gitOutput(options.controlRepoRoot, ["branch", "--show-current"]) || null;
  const timestamp = (options.now ?? defaultNow)();
  const idGenerator = options.idGenerator ?? uuidv7;
  const removeArgs = ["worktree", "remove", ...(options.force === true ? ["--force"] : []), inspected.workspace.workspace_path];
  runGitRequired(options.controlRepoRoot, removeArgs, "dispatch_cleanup_git_failed");
  const branchDelete = deleteBranchIfSafe(options.controlRepoRoot, inspected.workspace.expected_branch);
  const eventId = `evt_${idGenerator()}`;

  const cleaned = db.transaction(() => {
    insertDispatchEvent(db, {
      id: eventId,
      runId,
      attemptId: inspected.attempt.id,
      ts: timestamp,
      type: "cleaned_up",
      message: "Cleaned up dispatch worktree.",
      dataJson: JSON.stringify({
        workspace_path: inspected.workspace.workspace_path,
        worktree_branch: inspected.workspace.expected_branch,
        control_repo_root: options.controlRepoRoot,
        control_branch: controlBranch,
        force: options.force ?? false,
        workspace_removed: true,
        branch_deleted: branchDelete.deleted,
        branch_delete_skipped_reason: branchDelete.skippedReason,
        branch_delete_stderr: branchDelete.stderr
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`cleaned dispatch run '${runId}' could not be read back`);
    }

    return {
      kind: "cleaned",
      detail,
      attempt: inspected.attempt,
      workspace: inspected.workspace,
      cleanup: {
        run_id: detail.run.id,
        attempt_id: inspected.attempt.id,
        control_repo_root: options.controlRepoRoot,
        control_branch: controlBranch,
        workspace_path: inspected.workspace.workspace_path,
        worktree_branch: inspected.workspace.expected_branch,
        force: options.force ?? false,
        changed: true,
        workspace_removed: true,
        branch_deleted: branchDelete.deleted,
        branch_delete_skipped_reason: branchDelete.skippedReason,
        cleaned_at: timestamp
      }
    } satisfies CleanupDispatchRunResult;
  });

  return cleaned.immediate();
}

function hasCleanupEvent(detail: DispatchRunDetail, attemptId: string): boolean {
  return detail.events.some((event) => event.type === "cleaned_up" && event.attempt_id === attemptId);
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  const result = runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.status === 0;
}

interface BranchDeleteResult {
  deleted: boolean;
  skippedReason: string | null;
  stderr: string | null;
}

function deleteBranchIfSafe(cwd: string, branch: string): BranchDeleteResult {
  if (!branchExists(cwd, branch)) {
    return { deleted: false, skippedReason: "branch_missing", stderr: null };
  }

  const result = runGit(cwd, ["branch", "-d", branch]);
  if (result.status === 0) {
    return { deleted: true, skippedReason: null, stderr: null };
  }

  return {
    deleted: false,
    skippedReason: "branch_delete_unsafe",
    stderr: trimToNullable(result.stderr)
  };
}

function branchExists(cwd: string, branch: string): boolean {
  const result = runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
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

function gitOutput(cwd: string, args: string[]): string | null {
  const result = runGit(cwd, args);

  if (result.status !== 0) {
    return null;
  }

  return trimToNullable(result.stdout);
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

function trimToNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function defaultNow(): string {
  return new Date().toISOString();
}
