import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { v7 as uuidv7 } from "uuid";
import { getDispatchRunDetailById, type DispatchAttemptDetail, type DispatchRunDetail } from "../db/dispatch-queries";
import { insertDispatchEvent, updateDispatchAttemptStatus, updateDispatchRunStatus } from "../db/dispatch-writes";
import { findExecutableCommand } from "../tools/executable";
import { DISPATCH_TOOLS, type DispatchTool } from "./claim";
import {
  FOREMAN_DISPATCH_ATTEMPT_ID_ENV,
  FOREMAN_DISPATCH_CHILD_ENV,
  FOREMAN_DISPATCH_CHUNK_ID_ENV,
  FOREMAN_DISPATCH_RUN_ID_ENV,
  FOREMAN_DISPATCH_TASK_ID_ENV
} from "./env";
import type { DispatchPrompt } from "./prompt";

type IdGenerator = () => string;
type NowGenerator = () => string;

export { FOREMAN_DISPATCH_CHILD_ENV } from "./env";

export interface DispatchLaunch {
  run_id: string;
  attempt_id: string;
  tool: DispatchTool;
  command: string;
  args: string[];
  cwd: string;
  process_id: number;
  prompt_chars: number;
  prompt_sha256: string;
  launched_at: string;
}

export type LaunchDispatchRunResult =
  | { kind: "launched"; detail: DispatchRunDetail; launch: DispatchLaunch }
  | { kind: "missing" }
  | { kind: "not_launchable"; detail: DispatchRunDetail; reason: string }
  | { kind: "launch_failed"; detail: DispatchRunDetail; errorMessage: string };

export interface LaunchPreparedDispatchRunOptions {
  idGenerator?: IdGenerator;
  now?: NowGenerator;
  env?: Record<string, string | undefined>;
}

interface LaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
}

interface LaunchableAttempt {
  attempt: DispatchAttemptDetail;
  tool: DispatchTool;
}

export function launchPreparedDispatchRun(
  db: Database,
  runId: string,
  prompt: DispatchPrompt,
  options: LaunchPreparedDispatchRunOptions = {}
): LaunchDispatchRunResult {
  const idGenerator = options.idGenerator ?? uuidv7;
  const now = options.now ?? defaultNow;
  const env = options.env ?? process.env;
  const existing = getDispatchRunDetailById(db, runId);

  if (existing === null) {
    return { kind: "missing" };
  }

  const initialLaunchable = validateLaunchable(existing, prompt);
  if (typeof initialLaunchable === "string") {
    return { kind: "not_launchable", detail: existing, reason: initialLaunchable };
  }

  if (!isDirectory(initialLaunchable.attempt.workspace_path ?? "")) {
    return { kind: "not_launchable", detail: existing, reason: "workspace_missing" };
  }

  const launchCommand = buildLaunchCommand(prompt, initialLaunchable.tool, env);
  if (typeof launchCommand === "string") {
    return { kind: "not_launchable", detail: existing, reason: launchCommand };
  }

  const promptMeta = promptMetadata(prompt.prompt);
  const reserved = reserveLaunch(db, runId, prompt, promptMeta, { idGenerator, now });
  if (reserved.kind !== "reserved") {
    return reserved.result;
  }

  let processId: number;
  try {
    processId = spawnLaunchCommand(launchCommand);
  } catch (error) {
    return recordLaunchFailure(db, runId, prompt, launchCommand, error, { idGenerator, now });
  }

  const launchedAt = now();
  const launched = db.transaction(() => {
    updateDispatchRunStatus(db, {
      id: runId,
      status: "running",
      updatedAt: launchedAt,
      expectedStatus: "running"
    });

    const attemptUpdated = updateDispatchAttemptStatus(db, {
      id: prompt.attempt_id,
      status: "launching_agent",
      processId,
      expectedStatus: "building_prompt"
    });

    if (attemptUpdated !== 1) {
      throw new Error(`dispatch attempt '${prompt.attempt_id}' launch reservation was lost`);
    }

    insertDispatchEvent(db, {
      id: `evt_${idGenerator()}`,
      runId,
      attemptId: prompt.attempt_id,
      ts: launchedAt,
      type: "agent_launched",
      message: `Launched ${prompt.tool} for dispatch attempt.`,
      dataJson: JSON.stringify({
        status: "launching_agent",
        tool: prompt.tool,
        command: launchCommand.command,
        args: launchCommand.args,
        cwd: launchCommand.cwd,
        process_id: processId,
        prompt_chars: promptMeta.chars,
        prompt_sha256: promptMeta.sha256
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`launched dispatch run '${runId}' could not be read back`);
    }

    return {
      kind: "launched",
      detail,
      launch: {
        run_id: runId,
        attempt_id: prompt.attempt_id,
        tool: prompt.tool as DispatchTool,
        command: launchCommand.command,
        args: launchCommand.args,
        cwd: launchCommand.cwd,
        process_id: processId,
        prompt_chars: promptMeta.chars,
        prompt_sha256: promptMeta.sha256,
        launched_at: launchedAt
      }
    } satisfies LaunchDispatchRunResult;
  });

  return launched.immediate();
}

function reserveLaunch(
  db: Database,
  runId: string,
  prompt: DispatchPrompt,
  promptMeta: { chars: number; sha256: string },
  options: { idGenerator: IdGenerator; now: NowGenerator }
):
  | { kind: "reserved" }
  | { kind: "not_reserved"; result: Exclude<LaunchDispatchRunResult, { kind: "launched" | "missing" }> | { kind: "missing" } } {
  const reservedAt = options.now();
  const reserve = db.transaction(() => {
    const current = getDispatchRunDetailById(db, runId);
    if (current === null) {
      return { kind: "not_reserved", result: { kind: "missing" } } as const;
    }

    const launchable = validateLaunchable(current, prompt);
    if (typeof launchable === "string") {
      return {
        kind: "not_reserved",
        result: { kind: "not_launchable", detail: current, reason: launchable }
      } as const;
    }

    const runUpdated = updateDispatchRunStatus(db, {
      id: runId,
      status: "running",
      updatedAt: reservedAt,
      expectedStatus: "running"
    });

    const attemptUpdated = updateDispatchAttemptStatus(db, {
      id: prompt.attempt_id,
      status: "building_prompt",
      expectedStatus: "preparing_workspace"
    });

    if (runUpdated !== 1 || attemptUpdated !== 1) {
      const detail = getDispatchRunDetailById(db, runId);
      return {
        kind: "not_reserved",
        result:
          detail === null
            ? ({ kind: "missing" } as const)
            : ({ kind: "not_launchable", detail, reason: "status_changed" } as const)
      } as const;
    }

    insertDispatchEvent(db, {
      id: `evt_${options.idGenerator()}`,
      runId,
      attemptId: prompt.attempt_id,
      ts: reservedAt,
      type: "prompt_built",
      message: "Built dispatch launch prompt.",
      dataJson: JSON.stringify({
        status: "building_prompt",
        prompt_chars: promptMeta.chars,
        prompt_sha256: promptMeta.sha256
      })
    });

    return { kind: "reserved" } as const;
  });

  return reserve.immediate();
}

function recordLaunchFailure(
  db: Database,
  runId: string,
  prompt: DispatchPrompt,
  launchCommand: LaunchCommand,
  error: unknown,
  options: { idGenerator: IdGenerator; now: NowGenerator }
): Extract<LaunchDispatchRunResult, { kind: "launch_failed" }> {
  const failedAt = options.now();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const failed = db.transaction(() => {
    updateDispatchRunStatus(db, {
      id: runId,
      status: "failed",
      updatedAt: failedAt,
      finishedAt: failedAt,
      expectedStatus: "running"
    });
    updateDispatchAttemptStatus(db, {
      id: prompt.attempt_id,
      status: "failed",
      endedAt: failedAt,
      errorMessage,
      expectedStatus: "building_prompt"
    });
    insertDispatchEvent(db, {
      id: `evt_${options.idGenerator()}`,
      runId,
      attemptId: prompt.attempt_id,
      ts: failedAt,
      type: "launch_failed",
      message: "Failed to launch dispatch agent process.",
      dataJson: JSON.stringify({
        status: "failed",
        tool: prompt.tool,
        command: launchCommand.command,
        args: launchCommand.args,
        cwd: launchCommand.cwd,
        error: errorMessage
      })
    });

    const detail = getDispatchRunDetailById(db, runId);
    if (detail === null) {
      throw new Error(`failed dispatch run '${runId}' could not be read back`);
    }

    return { kind: "launch_failed", detail, errorMessage } satisfies Extract<
      LaunchDispatchRunResult,
      { kind: "launch_failed" }
    >;
  });

  return failed.immediate();
}

function validateLaunchable(detail: DispatchRunDetail, prompt: DispatchPrompt): LaunchableAttempt | string {
  if (detail.run.id !== prompt.run_id) {
    return "prompt_run_mismatch";
  }

  if (detail.run.status !== "running") {
    return "status_not_running";
  }

  if (detail.attempts.length === 0) {
    return "missing_attempt";
  }

  if (detail.attempts.length > 1) {
    return "multiple_attempts";
  }

  const attempt = detail.attempts[0];
  if (attempt.id !== prompt.attempt_id) {
    return "prompt_attempt_mismatch";
  }

  if (attempt.status !== "preparing_workspace") {
    return "attempt_status_not_preparing_workspace";
  }

  if (attempt.workspace_path === null) {
    return "missing_workspace_path";
  }

  if (attempt.workspace_path !== prompt.workspace_path) {
    return "workspace_changed";
  }

  if (attempt.tool !== prompt.tool) {
    return "tool_changed";
  }

  if (attempt.process_id !== null) {
    return "already_has_process";
  }

  if (!DISPATCH_TOOLS.includes(attempt.tool as DispatchTool)) {
    return "unsupported_tool";
  }

  return { attempt, tool: attempt.tool as DispatchTool };
}

function buildLaunchCommand(
  prompt: DispatchPrompt,
  tool: DispatchTool,
  env: Record<string, string | undefined>
): LaunchCommand | string {
  const binaryName = tool === "claude-code" ? "claude" : "codex";
  const command = findExecutableCommand(binaryName, env);

  if (command === null) {
    return `${binaryName}_not_found`;
  }

  const args =
    tool === "claude-code"
      ? [
          "--print",
          "--input-format",
          "text",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "acceptEdits"
        ]
      : ["--ask-for-approval", "never", "exec", "--sandbox", "workspace-write", "--color", "never", "-"];

  return {
    command,
    args,
    cwd: prompt.workspace_path,
    stdin: prompt.prompt,
    env: childEnvironment(env, prompt)
  };
}

function spawnLaunchCommand(command: LaunchCommand): number {
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: ["pipe", "ignore", "ignore"]
  });

  child.once("error", () => undefined);
  child.stdin?.once("error", () => undefined);
  child.stdin?.end(command.stdin);
  child.unref();

  if (child.pid === undefined) {
    throw new Error("spawn did not return a process id");
  }

  return child.pid;
}

function childEnvironment(
  env: Record<string, string | undefined>,
  prompt: DispatchPrompt
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      child[key] = value;
    }
  }

  child[FOREMAN_DISPATCH_CHILD_ENV] = "1";
  child[FOREMAN_DISPATCH_RUN_ID_ENV] = prompt.run_id;
  child[FOREMAN_DISPATCH_ATTEMPT_ID_ENV] = prompt.attempt_id;
  child[FOREMAN_DISPATCH_TASK_ID_ENV] = prompt.task_id;
  child[FOREMAN_DISPATCH_CHUNK_ID_ENV] = prompt.chunk_id;
  child.NO_COLOR = "1";
  return child;
}

function promptMetadata(prompt: string): { chars: number; sha256: string } {
  return {
    chars: prompt.length,
    sha256: createHash("sha256").update(prompt).digest("hex")
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultNow(): string {
  return new Date().toISOString();
}
