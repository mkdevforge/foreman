import type { DispatchAttemptDetail, DispatchRunDetail } from "../db/dispatch-queries";
import type { ChunkDispatchReadiness, ChunkQuestion, ForemanChunk, ForemanTask } from "../store/schema";

export interface DispatchPrompt {
  run_id: string;
  attempt_id: string;
  repo_name: string;
  task_id: string;
  task_title: string;
  chunk_id: string;
  chunk_title: string;
  requested_stage: string;
  chunk_stage: string;
  chunk_status: string;
  tool: string;
  workspace_path: string;
  worktree_branch: string | null;
  prompt: string;
}

export type BuildDispatchPromptResult =
  | { kind: "built"; dispatchPrompt: DispatchPrompt }
  | { kind: "repo_mismatch"; expectedRepoName: string; actualRepoName: string | null }
  | { kind: "not_promptable"; reason: string };

export function buildDispatchPrompt(
  detail: DispatchRunDetail,
  task: ForemanTask,
  chunk: ForemanChunk,
  options: { repoName: string }
): BuildDispatchPromptResult {
  const run = detail.run;

  if (run.repo_name === null) {
    return { kind: "not_promptable", reason: "missing_repo_name" };
  }

  if (run.repo_name !== options.repoName) {
    return { kind: "repo_mismatch", expectedRepoName: run.repo_name, actualRepoName: options.repoName };
  }

  if (run.status !== "running") {
    return { kind: "not_promptable", reason: "status_not_running" };
  }

  if (detail.attempts.length === 0) {
    return { kind: "not_promptable", reason: "missing_attempt" };
  }

  if (detail.attempts.length > 1) {
    return { kind: "not_promptable", reason: "multiple_attempts" };
  }

  const attempt = detail.attempts[0];
  if (attempt.workspace_path === null) {
    return { kind: "not_promptable", reason: "missing_workspace_path" };
  }

  return {
    kind: "built",
    dispatchPrompt: {
      run_id: run.id,
      attempt_id: attempt.id,
      repo_name: run.repo_name,
      task_id: run.task_id,
      task_title: task.title,
      chunk_id: run.chunk_id,
      chunk_title: chunk.title,
      requested_stage: run.requested_stage,
      chunk_stage: chunk.stage,
      chunk_status: chunk.status,
      tool: attempt.tool,
      workspace_path: attempt.workspace_path,
      worktree_branch: attempt.worktree_branch,
      prompt: renderPrompt(detail, task, chunk, attempt)
    }
  };
}

function renderPrompt(
  detail: DispatchRunDetail,
  task: ForemanTask,
  chunk: ForemanChunk,
  attempt: DispatchAttemptDetail
): string {
  const run = detail.run;
  const dispatch = chunk.dispatch ?? null;
  const questions = chunk.questions ?? [];
  const answeredQuestions = questions.filter((question) => question.status === "answered");
  const openQuestions = questions.filter((question) => question.status === "open");
  const decisions = chunk.decisions ?? [];

  return [
    "# Foreman Dispatch Prompt",
    "",
    "You are working on a Foreman-dispatched task chunk. Use the workspace and constraints below.",
    "",
    "## Execution Context",
    `- Repo: ${run.repo_name ?? "null"}`,
    `- Task: ${task.id} - ${task.title}`,
    `- Chunk: ${chunk.id} - ${chunk.title}`,
    `- Requested stage: ${run.requested_stage}`,
    `- Current chunk stage: ${chunk.stage}`,
    `- Current chunk status: ${chunk.status}`,
    `- Dispatch run: ${run.id}`,
    `- Dispatch attempt: ${attempt.id}`,
    `- Tool: ${attempt.tool}`,
    `- Workspace path: ${attempt.workspace_path ?? "null"}`,
    `- Worktree branch: ${attempt.worktree_branch ?? "null"}`,
    "",
    "## Task Description",
    formatBlock(task.description ?? "null"),
    "",
    "## Chunk Spec",
    formatBlock(chunk.spec),
    "",
    "## Dispatch Policy",
    ...formatDispatchPolicy(dispatch),
    "",
    "## Decisions",
    ...formatDecisions(decisions),
    "",
    "## Answered Questions",
    ...formatQuestions(answeredQuestions),
    "",
    "## Open Questions",
    ...formatQuestions(openQuestions),
    "",
    "## Operating Rules",
    "- Work in the workspace path above.",
    "- Follow the dispatch policy allowed and blocked actions.",
    "- If required context is missing or ambiguous, do not guess.",
    "- Capture missing context as precise Foreman questions, then stop and report the block.",
    "- Do not launch unrelated tools or mutate unrelated task chunks.",
    "- Do not mark the chunk done unless the human explicitly asks for that state change.",
    "- Unless explicitly instructed otherwise, commit completed workspace changes to the worktree branch before reporting finished.",
    "- When finished, report changed files, verification commands, and any residual risk.",
    ""
  ].join("\n");
}

function formatDispatchPolicy(dispatch: ChunkDispatchReadiness | null): string[] {
  if (dispatch === null) {
    return ["- Dispatch metadata: null"];
  }

  return [
    `- Status: ${dispatch.status}`,
    `- Risk level: ${dispatch.risk_level}`,
    `- Approval required: ${dispatch.approval_required}`,
    `- Allowed actions: ${formatInlineList(dispatch.allowed_actions)}`,
    `- Blocked actions: ${formatInlineList(dispatch.blocked_actions)}`
  ];
}

function formatDecisions(decisions: Array<{ id: string; body: string }>): string[] {
  if (decisions.length === 0) {
    return ["- none"];
  }

  return decisions.map((decision) => `- ${decision.id}: ${decision.body}`);
}

function formatQuestions(questions: ChunkQuestion[]): string[] {
  if (questions.length === 0) {
    return ["- none"];
  }

  return questions.flatMap((question) => {
    if (question.status === "answered") {
      return [`- ${question.id}: ${question.body}`, `  Answer: ${question.answer ?? "null"}`];
    }

    return [`- ${question.id}: ${question.body}`];
  });
}

function formatBlock(value: string): string {
  return value.trim().length === 0 ? "null" : value.trim();
}

function formatInlineList(values: string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}
