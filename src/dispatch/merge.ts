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
  beforeFinalEventWrite?: () => void;
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
  audit_recovered: boolean;
  audit_recovery_reason: string | null;
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
  const mergedEvent = findLatestAttemptEvent(inspected.detail, inspected.attempt.id, "merged");
  const mergeStartedEvent = findLatestAttemptEvent(inspected.detail, inspected.attempt.id, "merge_started");
  const now = options.now ?? defaultNow;
  const idGenerator = options.idGenerator ?? uuidv7;

  if (isAncestor(options.controlRepoRoot, branchHead, "HEAD")) {
    if (mergedEvent === null && mergeStartedEvent !== null) {
      return recoverMergedAudit(db, {
        runId,
        detail: inspected.detail,
        attempt: inspected.attempt,
        workspace: inspected.workspace,
        controlRepoRoot: options.controlRepoRoot,
        controlBranch,
        currentHead: previousHead,
        branchHead,
        startedEvent: mergeStartedEvent,
        now,
        idGenerator
      });
    }

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
        merged_at: null,
        audit_recovered: false,
        audit_recovery_reason: null
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

  const mergeStartedEventId = insertMergeStartedEvent(db, {
    runId,
    attemptId: inspected.attempt.id,
    ts: now(),
    idGenerator,
    previousHead,
    expectedNewHead: branchHead,
    branchHead,
    workspacePath: inspected.workspace.workspace_path,
    worktreeBranch: inspected.workspace.expected_branch,
    controlRepoRoot: options.controlRepoRoot,
    controlBranch
  });

  runGitRequired(options.controlRepoRoot, ["merge", "--ff-only", inspected.workspace.expected_branch], "dispatch_merge_failed");

  options.beforeFinalEventWrite?.();

  const timestamp = now();
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
        fast_forward: true,
        merge_started_event_id: mergeStartedEventId,
        audit_recovered: false,
        audit_recovery_reason: null
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
        merged_at: timestamp,
        audit_recovered: false,
        audit_recovery_reason: null
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

function recoverMergedAudit(
  db: Database,
  input: {
    runId: string;
    detail: DispatchRunDetail;
    attempt: DispatchAttemptDetail;
    workspace: DispatchWorkspaceInspection;
    controlRepoRoot: string;
    controlBranch: string | null;
    currentHead: string;
    branchHead: string;
    startedEvent: DispatchRunDetail["events"][number];
    now: NowGenerator;
    idGenerator: IdGenerator;
  }
): Extract<MergeDispatchRunResult, { kind: "already_merged" }> {
  const timestamp = input.now();
  const startedData = parseEventData(input.startedEvent);
  const previousHead = stringFromEventData(startedData, "previous_head") ?? input.currentHead;
  const newHead =
    stringFromEventData(startedData, "expected_new_head") ??
    stringFromEventData(startedData, "new_head") ??
    stringFromEventData(startedData, "merged_sha") ??
    input.branchHead;
  const eventId = `evt_${input.idGenerator()}`;
  const recoveryReason = "merge_event_missing_after_git_side_effect";

  insertDispatchEvent(db, {
    id: eventId,
    runId: input.runId,
    attemptId: input.attempt.id,
    ts: timestamp,
    type: "merged",
    message: "Recovered missing dispatch merge audit event after Git side effect was already applied.",
    dataJson: JSON.stringify({
      previous_head: previousHead,
      new_head: newHead,
      merged_sha: input.branchHead,
      worktree_branch: input.workspace.expected_branch,
      workspace_path: input.workspace.workspace_path,
      control_repo_root: input.controlRepoRoot,
      control_branch: input.controlBranch,
      fast_forward: true,
      merge_started_event_id: input.startedEvent.id,
      audit_recovered: true,
      audit_recovery_reason: recoveryReason
    })
  });

  const detail = getDispatchRunDetailById(db, input.runId);
  if (detail === null) {
    throw new Error(`recovered merged dispatch run '${input.runId}' could not be read back`);
  }

  return {
    kind: "already_merged",
    detail,
    attempt: input.attempt,
    workspace: input.workspace,
    merge: {
      run_id: detail.run.id,
      attempt_id: input.attempt.id,
      control_repo_root: input.controlRepoRoot,
      control_branch: input.controlBranch,
      workspace_path: input.workspace.workspace_path,
      worktree_branch: input.workspace.expected_branch,
      previous_head: previousHead,
      new_head: newHead,
      merged_sha: input.branchHead,
      changed: false,
      fast_forward: true,
      merged_at: timestamp,
      audit_recovered: true,
      audit_recovery_reason: recoveryReason
    }
  };
}

function insertMergeStartedEvent(
  db: Database,
  input: {
    runId: string;
    attemptId: string;
    ts: string;
    idGenerator: IdGenerator;
    previousHead: string;
    expectedNewHead: string;
    branchHead: string;
    workspacePath: string;
    worktreeBranch: string;
    controlRepoRoot: string;
    controlBranch: string | null;
  }
): string {
  const eventId = `evt_${input.idGenerator()}`;
  insertDispatchEvent(db, {
    id: eventId,
    runId: input.runId,
    attemptId: input.attemptId,
    ts: input.ts,
    type: "merge_started",
    message: "Started dispatch merge Git side effect.",
    dataJson: JSON.stringify({
      previous_head: input.previousHead,
      expected_new_head: input.expectedNewHead,
      merged_sha: input.branchHead,
      worktree_branch: input.worktreeBranch,
      workspace_path: input.workspacePath,
      control_repo_root: input.controlRepoRoot,
      control_branch: input.controlBranch,
      fast_forward: true
    })
  });

  return eventId;
}

function findLatestAttemptEvent(detail: DispatchRunDetail, attemptId: string, type: string): DispatchRunDetail["events"][number] | null {
  for (let index = detail.events.length - 1; index >= 0; index -= 1) {
    const event = detail.events[index];
    if (event.attempt_id === attemptId && event.type === type) {
      return event;
    }
  }

  return null;
}

function parseEventData(event: DispatchRunDetail["events"][number]): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.data_json) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringFromEventData(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
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
