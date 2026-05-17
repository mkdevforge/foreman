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
  beforeFinalEventWrite?: () => void;
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
  audit_recovered: boolean;
  audit_recovery_reason: string | null;
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
    if (inspected.reason === "workspace_missing" && inspected.attempt !== null) {
      const controlBranch = gitOutput(options.controlRepoRoot, ["branch", "--show-current"]) || null;
      const cleanupEvent = findLatestAttemptEvent(inspected.detail, inspected.attempt.id, "cleaned_up");
      const cleanupStartedEvent = findLatestAttemptEvent(inspected.detail, inspected.attempt.id, "cleanup_started");
      const workspacePath = inspected.workspace_path ?? inspected.attempt.workspace_path ?? "";
      const worktreeBranch = inspected.expected_branch ?? inspected.attempt.worktree_branch ?? "";

      if (cleanupEvent === null && cleanupStartedEvent !== null) {
        return recoverCleanupAudit(db, {
          runId,
          detail: inspected.detail,
          attempt: inspected.attempt,
          controlRepoRoot: options.controlRepoRoot,
          controlBranch,
          workspacePath,
          worktreeBranch,
          force: options.force ?? false,
          startedEvent: cleanupStartedEvent,
          now: options.now ?? defaultNow,
          idGenerator: options.idGenerator ?? uuidv7
        });
      }

      if (cleanupEvent === null) {
        return {
          kind: "not_cleanupable",
          detail: inspected.detail,
          attempt: inspected.attempt,
          reason: `workspace_${inspected.reason}`
        };
      }

      return {
        kind: "already_cleaned",
        detail: inspected.detail,
        attempt: inspected.attempt,
        cleanup: {
          run_id: inspected.detail.run.id,
          attempt_id: inspected.attempt.id,
          control_repo_root: options.controlRepoRoot,
          control_branch: controlBranch,
          workspace_path: workspacePath,
          worktree_branch: worktreeBranch,
          force: options.force ?? false,
          changed: false,
          workspace_removed: false,
          branch_deleted: false,
          branch_delete_skipped_reason: "already_cleaned",
          cleaned_at: null,
          audit_recovered: false,
          audit_recovery_reason: null
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
  const now = options.now ?? defaultNow;
  const timestamp = now();
  const idGenerator = options.idGenerator ?? uuidv7;
  const cleanupStartedEventId = insertCleanupStartedEvent(db, {
    runId,
    attemptId: inspected.attempt.id,
    ts: timestamp,
    idGenerator,
    workspacePath: inspected.workspace.workspace_path,
    worktreeBranch: inspected.workspace.expected_branch,
    controlRepoRoot: options.controlRepoRoot,
    controlBranch,
    force: options.force ?? false
  });
  const removeArgs = ["worktree", "remove", ...(options.force === true ? ["--force"] : []), inspected.workspace.workspace_path];
  runGitRequired(options.controlRepoRoot, removeArgs, "dispatch_cleanup_git_failed");
  const branchDelete = deleteBranchIfSafe(options.controlRepoRoot, inspected.workspace.expected_branch);
  options.beforeFinalEventWrite?.();
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
        branch_delete_stderr: branchDelete.stderr,
        cleanup_started_event_id: cleanupStartedEventId,
        audit_recovered: false,
        audit_recovery_reason: null
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
        cleaned_at: timestamp,
        audit_recovered: false,
        audit_recovery_reason: null
      }
    } satisfies CleanupDispatchRunResult;
  });

  return cleaned.immediate();
}

function recoverCleanupAudit(
  db: Database,
  input: {
    runId: string;
    detail: DispatchRunDetail;
    attempt: DispatchAttemptDetail;
    controlRepoRoot: string;
    controlBranch: string | null;
    workspacePath: string;
    worktreeBranch: string;
    force: boolean;
    startedEvent: DispatchRunDetail["events"][number];
    now: NowGenerator;
    idGenerator: IdGenerator;
  }
): Extract<CleanupDispatchRunResult, { kind: "already_cleaned" }> {
  const timestamp = input.now();
  const branchStillExists = branchExists(input.controlRepoRoot, input.worktreeBranch);
  const branchDeleted = !branchStillExists;
  const recoveryReason = "cleanup_event_missing_after_git_side_effect";
  const eventId = `evt_${input.idGenerator()}`;
  const branchDeleteSkippedReason = branchDeleted ? null : "branch_state_unknown_after_recovery";

  insertDispatchEvent(db, {
    id: eventId,
    runId: input.runId,
    attemptId: input.attempt.id,
    ts: timestamp,
    type: "cleaned_up",
    message: "Recovered missing dispatch cleanup audit event after Git side effect was already applied.",
    dataJson: JSON.stringify({
      workspace_path: input.workspacePath,
      worktree_branch: input.worktreeBranch,
      control_repo_root: input.controlRepoRoot,
      control_branch: input.controlBranch,
      force: input.force,
      workspace_removed: true,
      branch_deleted: branchDeleted,
      branch_delete_skipped_reason: branchDeleteSkippedReason,
      branch_delete_stderr: null,
      cleanup_started_event_id: input.startedEvent.id,
      audit_recovered: true,
      audit_recovery_reason: recoveryReason
    })
  });

  const detail = getDispatchRunDetailById(db, input.runId);
  if (detail === null) {
    throw new Error(`recovered cleaned dispatch run '${input.runId}' could not be read back`);
  }

  return {
    kind: "already_cleaned",
    detail,
    attempt: input.attempt,
    cleanup: {
      run_id: detail.run.id,
      attempt_id: input.attempt.id,
      control_repo_root: input.controlRepoRoot,
      control_branch: input.controlBranch,
      workspace_path: input.workspacePath,
      worktree_branch: input.worktreeBranch,
      force: input.force,
      changed: false,
      workspace_removed: true,
      branch_deleted: branchDeleted,
      branch_delete_skipped_reason: branchDeleteSkippedReason,
      cleaned_at: timestamp,
      audit_recovered: true,
      audit_recovery_reason: recoveryReason
    }
  };
}

function insertCleanupStartedEvent(
  db: Database,
  input: {
    runId: string;
    attemptId: string;
    ts: string;
    idGenerator: IdGenerator;
    workspacePath: string;
    worktreeBranch: string;
    controlRepoRoot: string;
    controlBranch: string | null;
    force: boolean;
  }
): string {
  const eventId = `evt_${input.idGenerator()}`;
  insertDispatchEvent(db, {
    id: eventId,
    runId: input.runId,
    attemptId: input.attemptId,
    ts: input.ts,
    type: "cleanup_started",
    message: "Started dispatch cleanup Git side effect.",
    dataJson: JSON.stringify({
      workspace_path: input.workspacePath,
      worktree_branch: input.worktreeBranch,
      control_repo_root: input.controlRepoRoot,
      control_branch: input.controlBranch,
      force: input.force
    })
  });

  return eventId;
}

function findLatestAttemptEvent(
  detail: DispatchRunDetail,
  attemptId: string,
  type: string
): DispatchRunDetail["events"][number] | null {
  for (let index = detail.events.length - 1; index >= 0; index -= 1) {
    const event = detail.events[index];
    if (event.attempt_id === attemptId && event.type === type) {
      return event;
    }
  }

  return null;
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
