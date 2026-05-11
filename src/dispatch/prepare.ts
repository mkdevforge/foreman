import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { CliError } from "../cli/errors";
import { getDispatchRunDetailById, type DispatchEventRecord, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchAttempt, insertDispatchEvent, updateDispatchRunStatus } from "../db/dispatch-writes";
import { getGitOriginRemote, repoNameFromGitRemote } from "../store/repo";
import { DISPATCH_TOOLS, type DispatchTool } from "./claim";

type IdGenerator = () => string;
type NowGenerator = () => string;

export interface DispatchWorkspace {
  repo_remote: string;
  repo_name: string;
  workspace_path: string;
  worktree_branch: string;
  created: boolean;
}

export type PrepareDispatchRunResult =
  | { kind: "prepared"; detail: DispatchRunDetail; workspace: DispatchWorkspace }
  | { kind: "missing" }
  | { kind: "repo_mismatch"; detail: DispatchRunDetail; expectedRepoName: string; actualRepoName: string | null }
  | { kind: "not_preparable"; detail: DispatchRunDetail; reason: string };

export interface PrepareClaimedDispatchRunOptions {
  controlRepoRoot: string;
  repoRemote: string;
  repoName: string;
  idGenerator?: IdGenerator;
  now?: NowGenerator;
}

export function prepareClaimedDispatchRun(
  db: Database,
  runId: string,
  options: PrepareClaimedDispatchRunOptions
): PrepareDispatchRunResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;
  const existing = getDispatchRunDetailById(db, runId);

  if (existing === null) {
    return { kind: "missing" };
  }

  if (existing.run.repo_name === null) {
    return { kind: "not_preparable", detail: existing, reason: "missing_repo_name" };
  }

  if (existing.run.repo_name !== options.repoName) {
    return {
      kind: "repo_mismatch",
      detail: existing,
      expectedRepoName: existing.run.repo_name,
      actualRepoName: options.repoName
    };
  }

  if (existing.run.status !== "claimed") {
    return { kind: "not_preparable", detail: existing, reason: "status_not_claimed" };
  }

  if (existing.attempts.length > 0) {
    return { kind: "not_preparable", detail: existing, reason: "already_has_attempts" };
  }

  const tool = extractClaimedTool(existing.events);
  if (tool === null) {
    return { kind: "not_preparable", detail: existing, reason: "missing_claim_tool" };
  }

  const workspace = prepareTaskWorktree({
    controlRepoRoot: options.controlRepoRoot,
    repoRemote: options.repoRemote,
    repoName: options.repoName,
    taskId: existing.run.task_id
  });
  const timestamp = now();
  const attemptId = `attempt_${idGenerator()}`;
  const eventId = `evt_${idGenerator()}`;

  const prepare = db.transaction(() => {
    const updated = updateDispatchRunStatus(db, {
      id: runId,
      status: "running",
      updatedAt: timestamp,
      repoName: options.repoName,
      expectedStatus: "claimed"
    });

    if (updated !== 1) {
      const detail = getDispatchRunDetailById(db, runId);
      return detail === null
        ? ({ kind: "missing" } satisfies PrepareDispatchRunResult)
        : ({ kind: "not_preparable", detail, reason: "status_changed" } satisfies PrepareDispatchRunResult);
    }

    insertDispatchAttempt(db, {
      id: attemptId,
      runId,
      attemptNumber: 1,
      status: "preparing_workspace",
      tool,
      workspacePath: workspace.workspace_path,
      worktreeBranch: workspace.worktree_branch,
      startedAt: timestamp
    });

    insertDispatchEvent(db, {
      id: eventId,
      runId,
      attemptId,
      ts: timestamp,
      type: "attempt_prepared",
      message: "Prepared dispatch attempt workspace.",
      dataJson: JSON.stringify({
        status: "preparing_workspace",
        tool,
        workspace_path: workspace.workspace_path,
        worktree_branch: workspace.worktree_branch,
        repo_name: workspace.repo_name,
        workspace_created: workspace.created
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`prepared dispatch run '${runId}' could not be read back`);
    }

    return { kind: "prepared", detail, workspace } satisfies PrepareDispatchRunResult;
  });

  return prepare.immediate();
}

interface PrepareTaskWorktreeInput {
  controlRepoRoot: string;
  repoRemote: string;
  repoName: string;
  taskId: string;
}

function prepareTaskWorktree(input: PrepareTaskWorktreeInput): DispatchWorkspace {
  const workspacePath = defaultWorkspacePath(input.controlRepoRoot, input.repoName, input.taskId);
  const worktreeBranch = `foreman/${input.taskId}`;

  if (existsSync(workspacePath)) {
    assertReusableWorktree(workspacePath, worktreeBranch, input.repoName);
    return {
      repo_remote: input.repoRemote,
      repo_name: input.repoName,
      workspace_path: workspacePath,
      worktree_branch: worktreeBranch,
      created: false
    };
  }

  mkdirSync(dirname(workspacePath), { recursive: true });
  const args = branchExists(input.controlRepoRoot, worktreeBranch)
    ? ["worktree", "add", workspacePath, worktreeBranch]
    : ["worktree", "add", "-b", worktreeBranch, workspacePath, "HEAD"];
  runGit(input.controlRepoRoot, args, "dispatch_worktree_failed");

  return {
    repo_remote: input.repoRemote,
    repo_name: input.repoName,
    workspace_path: workspacePath,
    worktree_branch: worktreeBranch,
    created: true
  };
}

function defaultWorkspacePath(controlRepoRoot: string, repoName: string, taskId: string): string {
  return resolve(dirname(controlRepoRoot), "foreman-worktrees", repoName, taskId);
}

function assertReusableWorktree(workspacePath: string, worktreeBranch: string, repoName: string): void {
  const root = gitOutput(workspacePath, ["rev-parse", "--show-toplevel"]);
  if (root === null || resolve(root) !== resolve(workspacePath)) {
    throw new CliError(
      2,
      "dispatch_workspace_conflict",
      `workspace path '${workspacePath}' already exists but is not the expected Git worktree root`
    );
  }

  const branch = gitOutput(workspacePath, ["branch", "--show-current"]);
  if (branch !== worktreeBranch) {
    throw new CliError(
      2,
      "dispatch_workspace_conflict",
      `workspace path '${workspacePath}' is on branch '${branch ?? "detached"}'; expected '${worktreeBranch}'`
    );
  }

  const remote = getGitOriginRemote(workspacePath);
  if (remote === null || repoNameFromGitRemote(remote) !== repoName) {
    throw new CliError(
      2,
      "dispatch_workspace_conflict",
      `workspace path '${workspacePath}' does not match repo '${repoName}'`
    );
  }
}

function branchExists(cwd: string, branch: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  return result.status === 0;
}

function gitOutput(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    return null;
  }

  const output = result.stdout.trim();
  return output.length === 0 ? null : output;
}

function runGit(cwd: string, args: string[], code: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8"
  });

  if (result.error) {
    throw new CliError(1, "git_not_found", `failed to run git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new CliError(2, code, stderr.length === 0 ? `git ${args.join(" ")} failed` : stderr);
  }
}

function extractClaimedTool(events: DispatchEventRecord[]): DispatchTool | null {
  for (const event of [...events].reverse()) {
    if (event.type !== "claimed") {
      continue;
    }

    try {
      const parsed = JSON.parse(event.data_json) as { tool?: unknown };
      return typeof parsed.tool === "string" && DISPATCH_TOOLS.includes(parsed.tool as DispatchTool)
        ? (parsed.tool as DispatchTool)
        : null;
    } catch {
      return null;
    }
  }

  return null;
}

function defaultNow(): string {
  return new Date().toISOString();
}
