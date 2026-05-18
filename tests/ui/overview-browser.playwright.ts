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
  await expect(page.locator("#metric-blocked-chunks")).toHaveText("1");
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

function fixtureForPath(path: string): unknown {
  if (path === "/api/tasks") {
    return {
      schema_version: 1,
      tasks: [
        {
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
              updated_at: "2026-05-18T10:00:00.000Z"
            },
            {
              id: "blocked-chunk",
              title: "Blocked chunk",
              spec: "Blocked work needs a decision.",
              status: "todo",
              stage: "plan",
              created_at: "2026-05-17T10:00:00.000Z",
              updated_at: "2026-05-18T09:00:00.000Z"
            }
          ]
        },
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
      task: taskOneFixture()
    };
  }

  if (path === "/api/chunks/TASK-1") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunks: taskOneFixture().chunks
    };
  }

  if (path === "/api/questions/TASK-1/ready-chunk") {
    return { schema_version: 1, task_id: "TASK-1", chunk_id: "ready-chunk", questions: [] };
  }

  if (path === "/api/questions/TASK-1/blocked-chunk") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunk_id: "blocked-chunk",
      questions: [
        {
          id: "q_blocked",
          status: "open",
          body: "Which UI detail should be shown first?",
          asked_at: "2026-05-18T09:30:00.000Z",
          answered_at: null,
          answer: null
        }
      ]
    };
  }

  if (path === "/api/decisions/TASK-1/ready-chunk") {
    return { schema_version: 1, task_id: "TASK-1", chunk_id: "ready-chunk", decisions: [] };
  }

  if (path === "/api/decisions/TASK-1/blocked-chunk") {
    return {
      schema_version: 1,
      task_id: "TASK-1",
      chunk_id: "blocked-chunk",
      decisions: [
        {
          id: "d_bridge",
          body: "Use the existing CLI bridge.",
          decided_at: "2026-05-18T09:45:00.000Z"
        }
      ]
    };
  }

  if (path === "/api/reviews/TASK-1") {
    return {
      schema_version: 1,
      review: {
        type: "task",
        task: taskOneFixture(),
        chunk_rollups: [
          { chunk: taskOneFixture().chunks[0], linked_session_count: 1, total_cost_usd: 0.01 },
          { chunk: taskOneFixture().chunks[1], linked_session_count: 1, total_cost_usd: 0.01 }
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
        task: taskOneFixture(),
        chunk: taskOneFixture().chunks[1],
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

  if (path === "/api/dispatch-runs") {
    return {
      schema_version: 1,
      dispatch_runs: [
        {
          id: "run_queued",
          repo_name: "foreman",
          task_id: "TASK-1",
          chunk_id: "blocked-chunk",
          status: "queued",
          updated_at: "2026-05-18T10:00:00.000Z",
          attempts: [],
          events: [{ message: "Queued dispatch run." }]
        },
        {
          id: "run_failed",
          repo_name: "foreman",
          task_id: "TASK-2",
          chunk_id: "done-chunk",
          status: "failed",
          updated_at: "2026-05-18T09:00:00.000Z",
          attempts: [{ tool: "codex" }],
          events: [{ message: "Dispatch attempt failed." }]
        }
      ]
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
    return {
      schema_version: 1,
      dispatch_run: {
        id: "run_queued",
        repo_name: "foreman",
        task_id: "TASK-1",
        chunk_id: "blocked-chunk",
        requested_stage: "implement",
        status: "running",
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
      }
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

function taskOneFixture() {
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
