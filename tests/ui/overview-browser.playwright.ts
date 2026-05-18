import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let serverProcess: ChildProcess | null = null;
let serverUrl = "";

test.beforeAll(async () => {
  const started = await startForemanUi();
  serverProcess = started.process;
  serverUrl = started.url;
});

test.afterAll(async () => {
  if (serverProcess !== null && !serverProcess.killed) {
    serverProcess.kill("SIGINT");
  }
});

test("renders overview data and filters without screenshot baselines", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureForPath(path))
    });
  });

  await page.goto(serverUrl);

  await expect(page.getByTestId("load-state")).toHaveText("Loaded");
  await expect(page.locator("#metric-tasks")).toHaveText("2");
  await expect(page.locator("#metric-open-chunks")).toHaveText("2");
  await expect(page.locator("#metric-ready-chunks")).toHaveText("1");
  await expect(page.locator("#metric-ready-note")).toHaveText("1 need attention");
  await expect(page.locator("#chunk-rows")).toContainText("TASK-1/ready-chunk");
  await expect(page.locator("#chunk-rows")).toContainText("TASK-1/blocked-chunk");
  await expect(page.locator("#dispatch-rows")).toContainText("TASK-1/blocked-chunk");
  await expect(page.locator("#session-rows")).toContainText("TASK-1/ready-chunk");

  await page.locator("#filter-readiness").selectOption("blocked");
  await expect(page.locator("#chunk-rows")).toContainText("TASK-1/blocked-chunk");
  await expect(page.locator("#chunk-rows")).not.toContainText("TASK-1/ready-chunk");

  await page.locator("#filter-readiness").selectOption("all");
  await page.locator("#filter-dispatch-status").evaluate((select) => {
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("expected dispatch status filter to be a select");
    }
    select.value = "failed";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#dispatch-rows")).toContainText("TASK-2/done-chunk");
  await expect(page.locator("#dispatch-rows")).not.toContainText("TASK-1/blocked-chunk");

  await page.locator("#filter-search").fill("no matching work");
  await expect(page.locator("#chunk-rows")).toContainText("No chunks match the current filters.");
  await expect(page.locator("#dispatch-rows")).toContainText("No dispatch runs match the current filters.");
});

test("renders read-only detail routes at desktop and mobile sizes", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureForPath(path))
    });
  });

  await page.goto(serverUrl);
  await expect(page.getByTestId("load-state")).toHaveText("Loaded");

  await page.getByRole("link", { name: "TASK-1/blocked-chunk" }).click();
  await expect(page.locator("#page-title")).toHaveText("Chunk Detail");
  await expect(page.locator("#detail-view")).toContainText("answer the open question");
  await expect(page.locator("#detail-view")).toContainText("Use the existing CLI bridge.");
  await expect(page.locator("#detail-view")).toContainText("run_queued");
  await expectNoHorizontalOverflow(page);

  await page.getByRole("link", { name: "run_queued" }).first().click();
  await expect(page.locator("#page-title")).toHaveText("Dispatch Detail");
  await expect(page.locator("#detail-view")).toContainText("attempt_queued");
  await expect(page.locator("#detail-view")).toContainText("/tmp/foreman-worktree");

  await page.getByRole("link", { name: "session_1" }).first().click();
  await expect(page.locator("#page-title")).toHaveText("Session Detail");
  await expect(page.locator("#detail-view")).toContainText("session-source-1");
  await expect(page.locator("#detail-view")).toContainText("Full session id");

  await page.goto(serverUrl + "#/task/TASK-1");
  await expect(page.locator("#page-title")).toHaveText("Task Detail");
  await expect(page.locator("#detail-view")).toContainText("Ready chunk");
  await expect(page.locator("#detail-view")).toContainText("Use the existing CLI bridge.");

  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(serverUrl + "#/chunk/TASK-1/blocked-chunk");
  await expect(page.locator("#page-title")).toHaveText("Chunk Detail");
  await expect(page.locator("#detail-view")).toContainText("Blocked chunk");
  await expectNoHorizontalOverflow(page);
});

test("submits basic chunk controls through the UI write bridge", async ({ page }) => {
  const fixture = createFixtureState();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const result = request.method() === "POST"
      ? handleFixtureWrite(path, request.postData() || "{}", fixture)
      : { status: 200, body: fixtureForPath(path, fixture) };

    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: JSON.stringify(result.body)
    });
  });

  await page.goto(serverUrl + "#/chunk/TASK-1/blocked-chunk");
  await expect(page.getByTestId("load-state")).toHaveText("Loaded");
  await expect(page.locator("#page-title")).toHaveText("Chunk Detail");

  const statusForm = page.locator('[data-action="chunk-status"][data-task-id="TASK-1"][data-chunk-id="blocked-chunk"]').first();
  await statusForm.locator('select[name="status"]').selectOption("review");
  await statusForm.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#detail-view")).toContainText("Status saved.");
  await expect(page.locator("#detail-view")).toContainText("review");

  const noteForm = page.locator('[data-action="chunk-note"][data-task-id="TASK-1"][data-chunk-id="blocked-chunk"]');
  await noteForm.locator('textarea[name="body"]').fill("Added from the local UI.");
  await noteForm.getByRole("button", { name: "Add note" }).click();
  await expect(page.locator("#detail-view")).toContainText("Note added.");
  await expect(page.locator("#detail-view")).toContainText("Added from the local UI.");

  const answerForm = page.locator('[data-action="question-answer"][data-question-id="q_blocked"]');
  await answerForm.locator('textarea[name="answer"]').fill("Show chunk controls first.");
  await answerForm.getByRole("button", { name: "Answer" }).click();
  await expect(page.locator("#detail-view")).toContainText("Answer saved.");
  await expect(page.locator("#detail-view")).toContainText("Show chunk controls first.");

  const questionForm = page.locator('[data-action="question-add"][data-task-id="TASK-1"][data-chunk-id="blocked-chunk"]');
  await questionForm.locator('textarea[name="body"]').fill("Should this be visible after refresh?");
  await questionForm.getByRole("button", { name: "Add question" }).click();
  await expect(page.locator("#detail-view")).toContainText("Question added.");
  await expect(page.locator("#detail-view")).toContainText("Should this be visible after refresh?");

  const decisionForm = page.locator('[data-action="decision-add"][data-task-id="TASK-1"][data-chunk-id="blocked-chunk"]');
  await decisionForm.locator('textarea[name="body"]').fill("Keep controls on chunk detail.");
  await decisionForm.getByRole("button", { name: "Accept decision" }).click();
  await expect(page.locator("#detail-view")).toContainText("Decision added.");
  await expect(page.locator("#detail-view")).toContainText("Keep controls on chunk detail.");

  await page.goto(serverUrl + "#/task/TASK-1");
  await expect(page.locator("#page-title")).toHaveText("Task Detail");
  const stageForm = page.locator('[data-action="chunk-stage"][data-task-id="TASK-1"][data-chunk-id="ready-chunk"]').first();
  await stageForm.locator('select[name="stage"]').selectOption("review");
  await stageForm.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#detail-view")).toContainText("Stage saved.");

  expect(fixture.writes).toEqual([
    { path: "/api/chunks/TASK-1/blocked-chunk/status", body: { status: "review" } },
    { path: "/api/chunks/TASK-1/blocked-chunk/notes", body: { body: "Added from the local UI." } },
    { path: "/api/questions/TASK-1/blocked-chunk/q_blocked/answer", body: { answer: "Show chunk controls first." } },
    { path: "/api/questions/TASK-1/blocked-chunk", body: { body: "Should this be visible after refresh?" } },
    { path: "/api/decisions/TASK-1/blocked-chunk", body: { body: "Keep controls on chunk detail." } },
    { path: "/api/chunks/TASK-1/ready-chunk/stage", body: { stage: "review" } }
  ]);
  await expectNoHorizontalOverflow(page);
});

test("shows write command errors without hidden optimistic mutation", async ({ page }) => {
  const fixture = createFixtureState();
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const result = request.method() === "POST"
      ? {
          status: 400,
          body: {
            schema_version: 1,
            error: { code: "ui_command_failed", message: "bad status", exit_code: 2 }
          }
        }
      : { status: 200, body: fixtureForPath(path, fixture) };

    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: JSON.stringify(result.body)
    });
  });

  await page.goto(serverUrl + "#/chunk/TASK-1/blocked-chunk");
  await expect(page.locator("#page-title")).toHaveText("Chunk Detail");

  const statusForm = page.locator('[data-action="chunk-status"][data-task-id="TASK-1"][data-chunk-id="blocked-chunk"]').first();
  await statusForm.locator('select[name="status"]').selectOption("blocked");
  await statusForm.getByRole("button", { name: "Save" }).click();

  await expect(page.locator("#detail-view")).toContainText("bad status (ui_command_failed)");
  await expect(statusForm.locator('select[name="status"]')).toHaveValue("todo");
  expect(fixture.task.chunks[1].status).toBe("todo");
});

test("submits dispatch controls and displays workspace review data", async ({ page }) => {
  const fixture = createFixtureState();
  await page.addInitScript(() => {
    (window as any).__foremanConfirmResult = true;
    window.confirm = () => (window as any).__foremanConfirmResult;
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const result = request.method() === "POST"
      ? handleFixtureWrite(path, request.postData() || "{}", fixture)
      : { status: 200, body: fixtureForPath(path, fixture) };

    await route.fulfill({
      status: result.status,
      contentType: "application/json",
      body: JSON.stringify(result.body)
    });
  });

  await page.goto(serverUrl + "#/chunk/TASK-1/ready-chunk");
  await expect(page.locator("#page-title")).toHaveText("Chunk Detail");

  const startForm = page.locator('[data-action="dispatch-start"][data-task-id="TASK-1"][data-chunk-id="ready-chunk"]');
  await startForm.locator('select[name="tool"]').selectOption("codex");
  await startForm.locator('select[name="stage"]').selectOption("implement");
  await page.evaluate(() => {
    (window as any).__foremanConfirmResult = false;
  });
  await startForm.getByRole("button", { name: "Start dispatch" }).click();
  expect(fixture.writes).toEqual([]);
  await page.evaluate(() => {
    (window as any).__foremanConfirmResult = true;
  });
  await startForm.getByRole("button", { name: "Start dispatch" }).click();
  await expect(page.locator("#detail-view")).toContainText("Dispatch started.");
  await expect(page.locator("#detail-view")).toContainText("run_started");

  await page.goto(serverUrl + "#/dispatch/run_queued");
  await expect(page.locator("#page-title")).toHaveText("Dispatch Detail");

  await page.locator('[data-action="dispatch-workspace"][data-run-id="run_queued"]').getByRole("button", { name: "Inspect" }).click();
  await expect(page.locator("#detail-view")).toContainText("Workspace inspected.");
  await expect(page.locator("#detail-view")).toContainText("src/ui/app.js");
  await expect(page.locator("#detail-view")).toContainText("notes.txt");

  const diffForm = page.locator('[data-action="dispatch-diff"][data-run-id="run_queued"]');
  await diffForm.locator('select[name="mode"]').selectOption("name-only");
  await diffForm.getByRole("button", { name: "Show diff" }).click();
  await expect(page.locator("#detail-view")).toContainText("Diff loaded.");
  await expect(page.locator("#detail-view")).toContainText("dispatch controls");

  const finishForm = page.locator('[data-action="dispatch-finish"][data-run-id="run_queued"]');
  await finishForm.locator('select[name="status"]').selectOption("failed");
  await finishForm.locator('textarea[name="message"]').fill("Stopped after review.");
  await finishForm.getByRole("button", { name: "Finish" }).click();
  await expect(page.locator("#detail-view")).toContainText("Dispatch finished.");
  await expect(page.locator("#detail-view")).toContainText("failed");

  const cleanupForm = page.locator('[data-action="dispatch-cleanup"][data-run-id="run_queued"]');
  await cleanupForm.locator('input[name="force"]').check();
  await cleanupForm.getByRole("button", { name: "Clean up" }).click();
  await expect(page.locator("#detail-view")).toContainText("Dispatch cleaned up.");

  expect(fixture.writes).toEqual([
    { path: "/api/chunks/TASK-1/ready-chunk/dispatch/start", body: { tool: "codex", stage: "implement" } },
    { path: "/api/dispatch-runs/run_queued/finish", body: { status: "failed", message: "Stopped after review.", allow_missing_session: false } },
    { path: "/api/dispatch-runs/run_queued/cleanup", body: { force: true } }
  ]);
  await expectNoHorizontalOverflow(page);
});

function startForemanUi(): Promise<{ process: ChildProcess; url: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bun", ["run", "foreman", "--", "ui", "--port", "0"], {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGINT");
      reject(new Error("timed out waiting for foreman ui to start"));
    }, 15_000);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/Foreman UI listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (match) {
        clearTimeout(timeout);
        resolvePromise({ process: child, url: match[1] });
      }
    });

    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("exit", (code) => {
      if (!output.includes("Foreman UI listening on")) {
        clearTimeout(timeout);
        reject(new Error("foreman ui exited before starting with code " + code + ": " + output));
      }
    });
  });
}

type FixtureNote = { ts: string; body: string };
type FixtureChunk = {
  id: string;
  title: string;
  spec: string;
  status: string;
  stage: string;
  created_at: string;
  updated_at: string;
  notes: FixtureNote[];
};
type FixtureQuestion = {
  id: string;
  status: string;
  body: string;
  asked_at: string;
  answered_at: string | null;
  answer: string | null;
};
type FixtureDecision = { id: string; body: string; decided_at: string };
type FixtureDispatchRun = Record<string, any>;
type FixtureTask = {
  schema_version: 1;
  id: string;
  title: string;
  description: string;
  status: string;
  created_at: string;
  updated_at: string;
  chunks: FixtureChunk[];
};
type FixtureState = {
  task: FixtureTask;
  questionsByChunk: Map<string, FixtureQuestion[]>;
  decisionsByChunk: Map<string, FixtureDecision[]>;
  dispatchRuns: FixtureDispatchRun[];
  writes: Array<{ path: string; body: unknown }>;
  nextQuestionNumber: number;
  nextDecisionNumber: number;
  nextNoteNumber: number;
};

function createFixtureState(): FixtureState {
  return {
    task: taskOneFixture(),
    questionsByChunk: new Map([
      ["ready-chunk", []],
      [
        "blocked-chunk",
        [
          {
            id: "q_blocked",
            status: "open",
            body: "Which UI detail should be shown first?",
            asked_at: "2026-05-18T09:30:00.000Z",
            answered_at: null,
            answer: null
          }
        ]
      ]
    ]),
    decisionsByChunk: new Map([
      ["ready-chunk", []],
      [
        "blocked-chunk",
        [
          {
            id: "d_bridge",
            body: "Use the existing CLI bridge.",
            decided_at: "2026-05-18T09:45:00.000Z"
          }
        ]
      ]
    ]),
    dispatchRuns: dispatchRunFixtures(),
    writes: [] as Array<{ path: string; body: unknown }>,
    nextQuestionNumber: 1,
    nextDecisionNumber: 1,
    nextNoteNumber: 1
  };
}

function fixtureForPath(path: string, state = createFixtureState()): unknown {
  if (path === "/api/tasks") {
    return {
      schema_version: 1,
      tasks: [
        state.task,
        {
          id: "TASK-2",
          title: "Finished work",
          description: "Completed dispatch work.",
          status: "done",
          created_at: "2026-05-16T10:00:00.000Z",
          updated_at: "2026-05-16T11:00:00.000Z",
          chunks: [
            {
              id: "done-chunk",
              title: "Done chunk",
              spec: "Completed work.",
              status: "done",
              stage: "review",
              created_at: "2026-05-16T10:00:00.000Z",
              updated_at: "2026-05-16T11:00:00.000Z"
            }
          ]
        }
      ]
    };
  }

  if (path === "/api/readiness/TASK-1/ready-chunk") {
    return { schema_version: 1, task_id: "TASK-1", chunk_id: "ready-chunk", ready: true, blockers: [], warnings: [] };
  }

  if (path === "/api/readiness/TASK-1/blocked-chunk") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunk_id: "blocked-chunk",
      ready: false,
      blockers: [{ code: "open_question", message: "answer the open question" }],
      warnings: []
    };
  }

  if (path === "/api/readiness/TASK-2/done-chunk") {
    return { schema_version: 1, task_id: "TASK-2", chunk_id: "done-chunk", ready: true, blockers: [], warnings: [] };
  }

  if (path === "/api/tasks/TASK-1") {
    return {
      schema_version: 1,
      task: state.task
    };
  }

  if (path === "/api/chunks/TASK-1") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunks: state.task.chunks
    };
  }

  if (path === "/api/questions/TASK-1/ready-chunk") {
    return { schema_version: 1, task_id: "TASK-1", chunk_id: "ready-chunk", questions: state.questionsByChunk.get("ready-chunk") ?? [] };
  }

  if (path === "/api/questions/TASK-1/blocked-chunk") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunk_id: "blocked-chunk",
      questions: state.questionsByChunk.get("blocked-chunk") ?? []
    };
  }

  if (path === "/api/decisions/TASK-1/ready-chunk") {
    return { schema_version: 1, task_id: "TASK-1", chunk_id: "ready-chunk", decisions: state.decisionsByChunk.get("ready-chunk") ?? [] };
  }

  if (path === "/api/decisions/TASK-1/blocked-chunk") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunk_id: "blocked-chunk",
      decisions: state.decisionsByChunk.get("blocked-chunk") ?? []
    };
  }

  if (path === "/api/reviews/TASK-1") {
    return {
      schema_version: 1,
      review: {
        type: "task",
        task: state.task,
        chunk_rollups: [
          { chunk: state.task.chunks[0], linked_session_count: 1, total_cost_usd: 0.01 },
          { chunk: state.task.chunks[1], linked_session_count: 1, total_cost_usd: 0.01 }
        ],
        linked_sessions: [
          {
            link: { task_id: "TASK-1", chunk_id: "blocked-chunk", stage: "implement", linked_at: "2026-05-18T10:00:00.000Z", linked_by: "hook" },
            session: sessionOneFixture()
          }
        ],
        total_linked_sessions: 1,
        total_cost_usd: 0.01
      }
    };
  }

  if (path === "/api/reviews/TASK-1/blocked-chunk") {
    return {
      schema_version: 1,
      review: {
        type: "chunk",
        task: state.task,
        chunk: state.task.chunks[1],
        linked_sessions_by_stage: [
          {
            stage: "implement",
            total_cost_usd: 0.01,
            sessions: [
              {
                link: { task_id: "TASK-1", chunk_id: "blocked-chunk", stage: "implement", linked_at: "2026-05-18T10:00:00.000Z", linked_by: "hook" },
                session: sessionOneFixture()
              }
            ]
          }
        ],
        total_cost_usd: 0.01
      }
    };
  }

  if (path === "/api/reviews/TASK-1/ready-chunk") {
    return {
      schema_version: 1,
      review: {
        type: "chunk",
        task: state.task,
        chunk: state.task.chunks[0],
        linked_sessions_by_stage: [],
        total_cost_usd: 0
      }
    };
  }

  if (path === "/api/dispatch-runs") {
    return {
      schema_version: 1,
      dispatch_runs: state.dispatchRuns
    };
  }

  if (path === "/api/sessions") {
    return {
      schema_version: 1,
      sessions: [
        {
          id: "session_1",
          source: "codex",
          model: "gpt-5.4-mini",
          ended_at: "2026-05-18T10:00:00.000Z",
          project_path: "/tmp/foreman",
          usage: { cost_usd: 0.01 },
          linked_chunks: [{ task_id: "TASK-1", chunk_id: "ready-chunk" }]
        }
      ]
    };
  }

  if (path === "/api/dispatch-runs/run_queued") {
    const run = state.dispatchRuns.find((candidate) => candidate.id === "run_queued");
    return {
      schema_version: 1,
      dispatch_run: run ?? null
    };
  }

  if (path === "/api/dispatch-runs/run_queued/workspace") {
    return {
      schema_version: 1,
      dispatch_run: state.dispatchRuns.find((candidate) => candidate.id === "run_queued"),
      workspace: {
        run_id: "run_queued",
        attempt_id: "attempt_queued",
        attempt_number: 1,
        workspace_path: "/tmp/foreman-worktree",
        expected_branch: "foreman/TASK-1",
        git_root: "/tmp/foreman-worktree",
        branch: "foreman/TASK-1",
        branch_matches: true,
        dirty: true,
        changed_files: [{ path: "src/ui/app.js", index_status: "M", worktree_status: "M", original_path: null }],
        untracked_files: ["notes.txt"],
        upstream: null,
        ahead: null,
        behind: null,
        recent_commits: [{ sha: "abcdef123456", subject: "Implement fixture work", author_name: "Fixture User", date: "2026-05-18T09:59:00.000Z" }]
      }
    };
  }

  if (path === "/api/dispatch-runs/run_queued/diff") {
    return {
      schema_version: 1,
      dispatch_run: state.dispatchRuns.find((candidate) => candidate.id === "run_queued"),
      workspace: {
        run_id: "run_queued",
        attempt_id: "attempt_queued",
        attempt_number: 1,
        workspace_path: "/tmp/foreman-worktree"
      },
      diff: { mode: "full", text: "diff --git a/src/ui/app.js b/src/ui/app.js\n+dispatch controls\n" }
    };
  }

  if (path === "/api/sessions/session_1") {
    return {
      schema_version: 1,
      session: sessionOneFixture()
    };
  }

  if (path === "/api/costs") {
    return {
      schema_version: 1,
      cost: {
        overall: { session_count: 1, total_cost_usd: 0.01 },
        groups: [{ source: "codex", session_count: 1, total_cost_usd: 0.01 }]
      }
    };
  }

  return { schema_version: 1, error: { message: "unexpected path " + path } };
}

function handleFixtureWrite(path: string, rawBody: string, state: FixtureState): { status: number; body: unknown } {
  const body = parseJsonObject(rawBody);
  state.writes.push({ path, body });

  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 5 && parts[0] === "api" && parts[1] === "chunks" && parts[2] === "TASK-1") {
    const chunk = requireFixtureChunk(state, parts[3]);
    if (parts[4] === "status") {
      chunk.status = readBodyString(body, "status");
      chunk.updated_at = "2026-05-18T11:00:00.000Z";
      return { status: 200, body: { schema_version: 1, task_id: "TASK-1", chunk } };
    }
    if (parts[4] === "stage") {
      chunk.stage = readBodyString(body, "stage");
      chunk.updated_at = "2026-05-18T11:00:00.000Z";
      return { status: 200, body: { schema_version: 1, task_id: "TASK-1", chunk } };
    }
    if (parts[4] === "notes") {
      chunk.notes.push({
        ts: `2026-05-18T11:00:${String(state.nextNoteNumber++).padStart(2, "0")}.000Z`,
        body: readBodyString(body, "body")
      });
      chunk.updated_at = "2026-05-18T11:00:00.000Z";
      return { status: 200, body: { schema_version: 1, task_id: "TASK-1", chunk } };
    }
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "questions" && parts[2] === "TASK-1") {
    const questions = state.questionsByChunk.get(parts[3]) ?? [];
    state.questionsByChunk.set(parts[3], questions);
    const question: FixtureQuestion = {
      id: `q_added_${state.nextQuestionNumber++}`,
      status: "open",
      body: readBodyString(body, "body"),
      asked_at: "2026-05-18T11:01:00.000Z",
      answered_at: null,
      answer: null
    };
    questions.push(question);
    return { status: 200, body: { schema_version: 1, task_id: "TASK-1", chunk_id: parts[3], question } };
  }

  if (parts.length === 6 && parts[0] === "api" && parts[1] === "questions" && parts[2] === "TASK-1" && parts[5] === "answer") {
    const questions = state.questionsByChunk.get(parts[3]) ?? [];
    const question = questions.find((candidate) => candidate.id === parts[4]);
    if (question === undefined) {
      return { status: 404, body: { schema_version: 1, error: { message: "missing question" } } };
    }
    question.status = "answered";
    question.answer = readBodyString(body, "answer");
    question.answered_at = "2026-05-18T11:02:00.000Z";
    return { status: 200, body: { schema_version: 1, task_id: "TASK-1", chunk_id: parts[3], question } };
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "decisions" && parts[2] === "TASK-1") {
    const decisions = state.decisionsByChunk.get(parts[3]) ?? [];
    state.decisionsByChunk.set(parts[3], decisions);
    const decision: FixtureDecision = {
      id: `d_added_${state.nextDecisionNumber++}`,
      body: readBodyString(body, "body"),
      decided_at: "2026-05-18T11:03:00.000Z"
    };
    decisions.push(decision);
    return { status: 200, body: { schema_version: 1, task_id: "TASK-1", chunk_id: parts[3], decision } };
  }

  if (parts.length === 6 && parts[0] === "api" && parts[1] === "chunks" && parts[2] === "TASK-1" && parts[4] === "dispatch" && parts[5] === "start") {
    const chunk = requireFixtureChunk(state, parts[3]);
    const run = {
      id: "run_started",
      repo_name: "foreman",
      task_id: "TASK-1",
      chunk_id: chunk.id,
      requested_stage: readBodyString(body, "stage"),
      status: "running",
      tool: readBodyString(body, "tool"),
      requested_by: null,
      source: "ui",
      created_at: "2026-05-18T11:04:00.000Z",
      updated_at: "2026-05-18T11:04:00.000Z",
      finished_at: null,
      attempts: [{ id: "attempt_started", tool: readBodyString(body, "tool"), session_id: null }],
      events: [{ message: "Started dispatch run." }]
    };
    state.dispatchRuns.unshift(run);
    return { status: 200, body: { schema_version: 1, dispatch_run: run } };
  }

  if (parts.length === 4 && parts[0] === "api" && parts[1] === "dispatch-runs" && parts[2] === "run_queued") {
    const run = requireFixtureDispatchRun(state, parts[2]);
    if (parts[3] === "finish") {
      run.status = readBodyString(body, "status");
      run.updated_at = "2026-05-18T11:05:00.000Z";
      run.finished_at = "2026-05-18T11:05:00.000Z";
      run.events.push({ message: "Finished dispatch run." });
      return { status: 200, body: { schema_version: 1, dispatch_run: run, changed: true } };
    }
    if (parts[3] === "reconcile") {
      run.events.push({ message: "Reconciled dispatch run." });
      return {
        status: 200,
        body: {
          schema_version: 1,
          dispatch_run: run,
          reconciliation: { reason: "not_stale", changed: false },
          changed: false
        }
      };
    }
    if (parts[3] === "merge") {
      run.events.push({ message: "Merged dispatch run." });
      return { status: 200, body: { schema_version: 1, dispatch_run: run, merge: { changed: true }, changed: true } };
    }
    if (parts[3] === "cleanup") {
      run.events.push({ message: "Cleaned up dispatch run." });
      return { status: 200, body: { schema_version: 1, dispatch_run: run, cleanup: { changed: true, force: body.force === true }, changed: true } };
    }
  }

  return { status: 404, body: { schema_version: 1, error: { message: "unexpected write path " + path } } };
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  const parsed = JSON.parse(rawBody) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected object body");
  }
  return parsed as Record<string, unknown>;
}

function readBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function requireFixtureChunk(state: FixtureState, chunkId: string): FixtureChunk {
  const chunk = state.task.chunks.find((candidate) => candidate.id === chunkId);
  if (chunk === undefined) {
    throw new Error("missing fixture chunk " + chunkId);
  }
  return chunk;
}

function requireFixtureDispatchRun(state: FixtureState, runId: string): FixtureDispatchRun {
  const run = state.dispatchRuns.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new Error("missing fixture dispatch run " + runId);
  }
  return run;
}

function taskOneFixture(): FixtureTask {
  return {
    schema_version: 1,
    id: "TASK-1",
    title: "UI work",
    description: "Build useful overview behavior.",
    status: "todo",
    created_at: "2026-05-17T10:00:00.000Z",
    updated_at: "2026-05-18T10:00:00.000Z",
    chunks: [
      {
        id: "ready-chunk",
        title: "Ready chunk",
        spec: "Ready work can be dispatched.",
        status: "todo",
        stage: "implement",
        created_at: "2026-05-17T10:00:00.000Z",
        updated_at: "2026-05-18T10:00:00.000Z",
        notes: []
      },
      {
        id: "blocked-chunk",
        title: "Blocked chunk",
        spec: "Blocked work needs a decision.",
        status: "todo",
        stage: "plan",
        created_at: "2026-05-17T10:00:00.000Z",
        updated_at: "2026-05-18T09:00:00.000Z",
        notes: [{ ts: "2026-05-18T09:10:00.000Z", body: "Needs detail route coverage." }]
      }
    ]
  };
}

function dispatchRunFixtures(): FixtureDispatchRun[] {
  return [
    {
      id: "run_queued",
      repo_name: "foreman",
      task_id: "TASK-1",
      chunk_id: "blocked-chunk",
      requested_stage: "implement",
      status: "running",
      tool: "codex",
      requested_by: null,
      source: "cli",
      created_at: "2026-05-18T09:55:00.000Z",
      updated_at: "2026-05-18T10:00:00.000Z",
      finished_at: null,
      attempts: [
        {
          id: "attempt_queued",
          run_id: "run_queued",
          attempt_number: 1,
          status: "launching_agent",
          tool: "codex",
          workspace_path: "/tmp/foreman-worktree",
          worktree_branch: "foreman/TASK-1",
          process_id: 12345,
          started_at: "2026-05-18T09:56:00.000Z",
          ended_at: null,
          error_message: null,
          session_id: "session_1",
          session: sessionOneFixture()
        }
      ],
      events: [
        { id: "evt_queued", run_id: "run_queued", attempt_id: null, ts: "2026-05-18T09:55:00.000Z", type: "queued", message: "Queued dispatch run.", data_json: "{\"task_id\":\"TASK-1\"}" },
        { id: "evt_launch", run_id: "run_queued", attempt_id: "attempt_queued", ts: "2026-05-18T09:56:00.000Z", type: "agent_launched", message: "Launched codex.", data_json: "{\"process_id\":12345}" }
      ]
    },
    {
      id: "run_failed",
      repo_name: "foreman",
      task_id: "TASK-2",
      chunk_id: "done-chunk",
      requested_stage: "review",
      status: "failed",
      tool: "codex",
      requested_by: null,
      source: "cli",
      created_at: "2026-05-18T08:55:00.000Z",
      updated_at: "2026-05-18T09:00:00.000Z",
      finished_at: "2026-05-18T09:00:00.000Z",
      attempts: [{ id: "attempt_failed", tool: "codex", session_id: null }],
      events: [{ message: "Dispatch attempt failed." }]
    }
  ];
}

function sessionOneFixture() {
  return {
    id: "session_1",
    source: "codex",
    source_session_id: "session-source-1",
    started_at: "2026-05-18T09:57:00.000Z",
    ended_at: "2026-05-18T10:00:00.000Z",
    project_path: "/tmp/foreman",
    repo_remote: "git@github.com:mkajander/foreman.git",
    model: "gpt-5.4-mini",
    machine: "test-machine",
    user_email: "user@example.test",
    created_at: "2026-05-18T10:00:01.000Z",
    usage: { input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.01 },
    summary: {
      summary_md: "Implemented the blocked detail view.",
      model_used: "gpt-5.4-mini",
      generated_at: "2026-05-18T10:00:02.000Z"
    },
    linked_chunks: [{ task_id: "TASK-1", chunk_id: "blocked-chunk", stage: "implement", linked_at: "2026-05-18T10:00:00.000Z", linked_by: "hook" }]
  };
}

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true);
}
