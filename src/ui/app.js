const STALE_AFTER_MS = 5 * 60 * 1000;
const CHUNK_STATUSES = ["todo", "doing", "review", "done", "blocked"];
const CHUNK_STAGES = ["discovery", "plan", "implement", "review"];
const DISPATCH_TOOLS = ["codex", "claude-code"];
const DISPATCH_STAGES = ["plan", "implement", "review"];
const DISPATCH_FINISH_STATUSES = ["succeeded", "failed"];
const DISPATCH_DIFF_MODES = ["full", "stat", "name-only"];

const endpoints = {
  tasks: "/api/tasks",
  dispatchRuns: "/api/dispatch-runs",
  sessions: "/api/sessions",
  costs: "/api/costs"
};

const state = {
  data: {},
  errors: {},
  readiness: new Map(),
  readinessLoading: false,
  loadedAt: null,
  route: parseRoute(),
  detail: {
    key: "overview",
    loading: false,
    data: null,
    error: null
  },
  filters: {
    search: "",
    taskStatus: "all",
    chunkStatus: "all",
    stage: "all",
    readiness: "all",
    dispatchStatus: "all",
    tool: "all"
  },
  sort: {
    work: "updated",
    dispatch: "updated"
  },
  write: {
    actions: new Map(),
    last: null
  },
  read: {
    actions: new Map()
  }
};

window.__foremanUiState = state;

document.addEventListener("DOMContentLoaded", () => {
  bindControls();
  window.addEventListener("hashchange", () => {
    state.route = parseRoute();
    renderRoute();
    void loadRouteDetail();
  });
  loadForemanData();
  setInterval(renderStaleState, 30_000);
});

function bindControls() {
  byId("refresh-button")?.addEventListener("click", () => loadForemanData());
  bindFilter("filter-search", "search");
  bindFilter("filter-task-status", "taskStatus");
  bindFilter("filter-chunk-status", "chunkStatus");
  bindFilter("filter-stage", "stage");
  bindFilter("filter-readiness", "readiness");
  bindFilter("filter-dispatch-status", "dispatchStatus");
  bindFilter("filter-tool", "tool");

  document.querySelectorAll("[data-sort-work]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sort.work = button.getAttribute("data-sort-work") || "updated";
      render();
    });
  });

  document.querySelectorAll("[data-sort-dispatch]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sort.dispatch = button.getAttribute("data-sort-dispatch") || "updated";
      render();
    });
  });

  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form === null || !form.matches("[data-ui-write-form]")) {
      return;
    }

    event.preventDefault();
    void submitWriteForm(form);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form === null || !form.matches("[data-ui-read-form]")) {
      return;
    }

    event.preventDefault();
    void submitReadForm(form);
  });
}

function bindFilter(id, key) {
  const element = byId(id);
  const update = () => {
    state.filters[key] = element.value;
    render();
  };
  element?.addEventListener("input", update);
  element?.addEventListener("change", update);
}

async function loadForemanData() {
  setLoadState("Loading", "loading");
  state.errors = {};
  state.readiness = new Map();
  state.readinessLoading = false;
  state.detail = { key: "", loading: false, data: null, error: null };
  renderLoadingState();

  const entries = await Promise.allSettled(
    Object.entries(endpoints).map(async ([key, path]) => [key, validatePayload(key, await fetchJson(path))])
  );

  state.data = {};
  state.errors = {};

  for (const entry of entries) {
    if (entry.status === "fulfilled") {
      const [key, value] = entry.value;
      state.data[key] = value;
    } else {
      const key = entry.reason && entry.reason.key ? entry.reason.key : "unknown";
      state.errors[key] = entry.reason;
    }
  }

  state.loadedAt = new Date();
  populateFilterOptions();
  render();

  const chunks = getChunks();
  if (chunks.length > 0 && !state.errors.tasks) {
    state.readinessLoading = true;
    render();
    await loadReadiness(chunks);
    state.readinessLoading = false;
    render();
  }

  await loadRouteDetail();
}

async function fetchJson(path) {
  let response;
  let body;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
    body = await response.json();
  } catch (error) {
    error.key = endpointKey(path);
    throw error;
  }

  if (!response.ok || body.error) {
    const error = new Error(readErrorMessage(body) || "Request failed");
    error.key = endpointKey(path);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function postJson(path, payload) {
  let response;
  let body;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    body = await response.json();
  } catch (error) {
    error.key = endpointKey(path);
    throw error;
  }

  if (!response.ok || body.error) {
    const error = new Error(readWriteErrorMessage(body) || "Request failed");
    error.key = endpointKey(path);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function loadReadiness(chunks) {
  const results = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const key = chunkKey(chunk);
      const path = "/api/readiness/" + encodeURIComponent(chunk.task.id) + "/" + encodeURIComponent(chunk.id);
      try {
        return [key, validatePayload("readiness", await fetchJson(path))];
      } catch (error) {
        error.chunkKey = key;
        throw error;
      }
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      const [key, value] = result.value;
      state.readiness.set(key, readinessFromPayload(value));
    } else {
      const key = result.reason && result.reason.chunkKey ? result.reason.chunkKey : null;
      if (key !== null) {
        state.readiness.set(key, {
          state: "error",
          message: result.reason.message || "Readiness failed",
          blockers: []
        });
      }
    }
  }
}

function validatePayload(key, body) {
  if (!body || typeof body !== "object" || body.schema_version !== 1) {
    throw payloadError(key, "Malformed response: missing schema_version 1.");
  }

  if (key === "tasks" && !Array.isArray(body.tasks)) {
    throw payloadError(key, "Malformed tasks response: expected tasks array.");
  }

  if (key === "task" && (!body.task || typeof body.task !== "object")) {
    throw payloadError(key, "Malformed task response: expected task object.");
  }

  if (key === "chunks" && !Array.isArray(body.chunks)) {
    throw payloadError(key, "Malformed chunks response: expected chunks array.");
  }

  if (key === "dispatchRuns" && !Array.isArray(body.dispatch_runs) && !Array.isArray(body.runs)) {
    throw payloadError(key, "Malformed dispatch response: expected dispatch_runs array.");
  }

  if (key === "dispatchRun" && (!body.dispatch_run || typeof body.dispatch_run !== "object")) {
    throw payloadError(key, "Malformed dispatch run response: expected dispatch_run object.");
  }

  if (key === "sessions" && !Array.isArray(body.sessions)) {
    throw payloadError(key, "Malformed sessions response: expected sessions array.");
  }

  if (key === "session" && body.session !== null && (!body.session || typeof body.session !== "object")) {
    throw payloadError(key, "Malformed session response: expected session object.");
  }

  if (key === "costs" && (!body.cost || typeof body.cost !== "object")) {
    throw payloadError(key, "Malformed costs response: expected cost object.");
  }

  if (key === "readiness" && typeof body.ready !== "boolean") {
    throw payloadError(key, "Malformed readiness response: expected ready boolean.");
  }

  if (key === "review" && (!body.review || typeof body.review !== "object")) {
    throw payloadError(key, "Malformed review response: expected review object.");
  }

  if (key === "questions" && !Array.isArray(body.questions)) {
    throw payloadError(key, "Malformed questions response: expected questions array.");
  }

  if (key === "decisions" && !Array.isArray(body.decisions)) {
    throw payloadError(key, "Malformed decisions response: expected decisions array.");
  }

  return body;
}

function payloadError(key, message) {
  const error = new Error(message);
  error.key = key;
  return error;
}

function renderLoadingState() {
  setText("chunks-meta", "Loading");
  setHtml("chunk-rows", tableState("Loading", 4));
  setText("dispatch-meta", "Loading");
  setHtml("dispatch-rows", tableState("Loading", 4));
  setText("sessions-meta", "Loading");
  setHtml("session-rows", panelState("Loading"));
  setText("cost-meta", "Loading");
  setHtml("cost-rows", panelState("Loading"));
}

function render() {
  const tasks = getTasks();
  const chunks = getChunks();
  const dispatchRuns = getDispatchRuns();
  const sessions = getSessions();
  const cost = getCost();
  const filteredChunks = sortChunks(chunks.filter(matchesChunkFilters));
  const filteredDispatchRuns = sortDispatchRuns(dispatchRuns.filter(matchesDispatchFilters));
  const filteredSessions = sessions.filter(matchesSessionSearch).slice(0, 8);
  const totalCost = Number(cost.overall?.total_cost_usd || 0);
  const openChunks = chunks.filter((chunk) => chunk.status !== "done");
  const readyDispatchChunks = openChunks.filter((chunk) => getReadinessState(chunk) === "ready");
  const notDispatchableChunks = openChunks.filter((chunk) => getReadinessState(chunk) !== "ready");
  const failures = Object.keys(state.errors);

  setText("rail-tasks", String(tasks.length));
  setText("rail-open-chunks", String(openChunks.length));
  setText("rail-dispatch-ready", String(readyDispatchChunks.length));
  setText("rail-dispatch", String(dispatchRuns.length));
  setText("rail-sessions", String(sessions.length));
  setText("rail-cost", money(totalCost));

  setText("metric-tasks", String(tasks.length));
  setText("metric-tasks-note", countByStatus(tasks));
  setText("metric-open-chunks", String(openChunks.length));
  setText("metric-open-note", chunks.length + " total chunks");
  setText("metric-ready-chunks", String(readyDispatchChunks.length));
  setText("metric-ready-note", state.readinessLoading ? "Checking dispatch gates" : dispatchReadinessNote(openChunks, notDispatchableChunks));
  setText("metric-dispatch", String(dispatchRuns.length));
  setText("metric-dispatch-note", dispatchRuns.length === 0 ? "No active runs" : countByStatus(dispatchRuns));
  setText("metric-sessions", String(sessions.length));
  setText("metric-sessions-note", sessions.length === 0 ? "No captured sessions" : latestTime(sessions[0]));
  setText("metric-cost", money(totalCost));
  setText("metric-cost-note", (cost.overall?.session_count || 0) + " costed sessions");

  setText("chunks-meta", filteredChunks.length + " of " + chunks.length + " chunks");
  setHtml("chunk-rows", renderChunks(filteredChunks));
  setText("dispatch-meta", filteredDispatchRuns.length + " of " + dispatchRuns.length + " runs");
  setHtml("dispatch-rows", renderDispatchRuns(filteredDispatchRuns));
  setText("sessions-meta", filteredSessions.length + " of " + sessions.length + " sessions");
  setHtml("session-rows", renderSessions(filteredSessions));
  setText("cost-meta", money(totalCost));
  setHtml("cost-rows", renderCosts(cost));

  if (failures.length === 0) {
    setLoadState("Loaded", "ok");
  } else {
    setLoadState("Partial", "warn");
  }
  renderSectionErrors();
  renderStaleState();
  renderRoute();
}

function renderChunks(chunks) {
  if (state.errors.tasks) {
    return tableState(readErrorText(state.errors.tasks), 4, true);
  }

  if (chunks.length === 0) {
    return tableState("No chunks match the current filters.", 4);
  }

  return chunks.map((chunk) => {
    const readiness = getReadiness(chunk);
    const description = chunk.spec ? firstLine(chunk.spec) : chunk.title || "";
    return "<tr>" +
      "<td>" +
        "<div class=\"item-title\"><a class=\"item-id detail-link\" href=\"" + routeHref(["chunk", chunk.task.id, chunk.id]) + "\">" + esc(chunk.task.id + "/" + chunk.id) + "</a><span>" + esc(chunk.title || "Untitled chunk") + "</span></div>" +
        "<p class=\"item-copy\">" + esc(description) + "</p>" +
      "</td>" +
      "<td>" + renderWorkStateCell(chunk) + "</td>" +
      "<td>" + renderDispatchGateCell(chunk, readiness) + "</td>" +
      "<td class=\"mono\">" + esc(formatDate(chunk.updated_at || chunk.created_at)) + "</td>" +
    "</tr>";
  }).join("");
}

function renderWorkStateCell(chunk) {
  return "<div class=\"meta-line\">" +
    chip("task " + (chunk.task.status || "unknown"), chunk.task.status) +
    chip("chunk " + (chunk.status || "unknown"), chunk.status) +
    chip("stage " + (chunk.stage || "unset"), chunk.stage) +
  "</div>";
}

function renderDispatchGateCell(chunk, readiness) {
  const summary = dispatchGateSummary(chunk, readiness);
  return "<div class=\"dispatch-gate-cell\">" +
    "<div class=\"meta-line\">" + chip(summary.label, summary.tone) + "</div>" +
    (summary.note ? "<p class=\"item-copy\">" + esc(summary.note) + "</p>" : "") +
  "</div>";
}

function renderDispatchRuns(dispatchRuns) {
  if (state.errors.dispatchRuns) {
    return tableState(readErrorText(state.errors.dispatchRuns), 4, true);
  }

  if (dispatchRuns.length === 0) {
    return tableState("No dispatch runs match the current filters.", 4);
  }

  return dispatchRuns.slice(0, 20).map((run) => {
    const attempt = array(run.attempts)[0] || {};
    const tool = run.tool || attempt.tool || "tool unset";
    const title = [run.task_id, run.chunk_id].filter(Boolean).join("/") || run.id || "Dispatch run";
    return "<tr>" +
      "<td>" +
        "<div class=\"item-title\"><a class=\"item-id detail-link\" href=\"" + routeHref(["dispatch", run.id]) + "\">" + esc(shortId(run.id)) + "</a><span>" + esc(title) + "</span></div>" +
        "<p class=\"item-copy\">" + esc(lastEvent(run) || run.repo_name || "") + "</p>" +
      "</td>" +
      "<td>" + chip(run.status || "unknown", run.status) + "</td>" +
      "<td>" + chip(tool, tool) + "</td>" +
      "<td class=\"mono\">" + esc(formatDate(run.updated_at || run.created_at)) + "</td>" +
    "</tr>";
  }).join("");
}

function renderSessions(sessions) {
  if (state.errors.sessions) {
    return panelState(readErrorText(state.errors.sessions), true);
  }

  if (sessions.length === 0) {
    return panelState("No sessions match the current filters.");
  }

  return sessions.map((session) => {
    const linked = array(session.linked_chunks).map((link) => link.task_id + "/" + link.chunk_id).join(", ");
    const title = [session.source, session.model].filter(Boolean).join(" - ");
    return "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\"><a class=\"item-id detail-link\" href=\"" + routeHref(["session", session.id]) + "\">" + esc(shortId(session.id)) + "</a><span>" + esc(title || "Session") + "</span></div>" +
        "<p class=\"item-copy\">" + (linked ? renderInlineChunkLinks(array(session.linked_chunks)) : esc(session.project_path || "Unlinked")) + "</p>" +
      "</div>" +
      "<div class=\"chips\">" + chip(formatCost(session.usage?.cost_usd), "active") + chip(formatDate(session.ended_at || session.started_at), "done") + "</div>" +
    "</article>";
  }).join("");
}

function renderCosts(cost) {
  if (state.errors.costs) {
    return panelState(readErrorText(state.errors.costs), true);
  }

  const groups = array(cost.groups);
  if (groups.length === 0) {
    return panelState("No cost rows.");
  }

  return "<div class=\"table-scroll\"><table class=\"data-table\"><thead><tr><th>Group</th><th>Sessions</th><th>Cost</th></tr></thead><tbody>" +
    groups.map((group) => {
      const label = group.source || group.model || group.project_path || group.task_id || "overall";
      return "<tr><td>" + esc(label) + "</td><td>" + esc(group.session_count || 0) + "</td><td class=\"mono\">" + esc(money(Number(group.total_cost_usd || 0))) + "</td></tr>";
    }).join("") +
  "</tbody></table></div>";
}

async function loadRouteDetail() {
  const route = state.route;
  const key = routeKey(route);

  if (route.kind === "overview" || route.kind === "unknown") {
    state.detail = { key, loading: false, data: null, error: null };
    renderRoute();
    return;
  }

  if (state.detail.key === key && (state.detail.loading || state.detail.data || state.detail.error)) {
    return;
  }

  state.detail = { key, loading: true, data: null, error: null };
  renderRoute();

  try {
    const data = await fetchRouteDetail(route);
    if (routeKey(state.route) !== key) {
      return;
    }
    state.detail = { key, loading: false, data, error: null };
  } catch (error) {
    if (routeKey(state.route) !== key) {
      return;
    }
    state.detail = { key, loading: false, data: null, error };
  }

  renderRoute();
}

async function fetchRouteDetail(route) {
  if (route.kind === "task") {
    const taskPayload = await fetchValidated("task", apiPath(["tasks", route.taskId]));
    const reviewPayload = await fetchValidated("review", apiPath(["reviews", route.taskId]));
    const task = taskPayload.task;
    const extras = await loadChunkExtras(task.id, array(task.chunks));
    return { kind: "task", task, review: reviewPayload.review, extras };
  }

  if (route.kind === "chunk") {
    const [taskPayload, chunksPayload, readinessPayload, reviewPayload, questionsPayload, decisionsPayload] = await Promise.all([
      fetchValidated("task", apiPath(["tasks", route.taskId])),
      fetchValidated("chunks", apiPath(["chunks", route.taskId])),
      fetchValidated("readiness", apiPath(["readiness", route.taskId, route.chunkId])),
      fetchValidated("review", apiPath(["reviews", route.taskId, route.chunkId])),
      fetchValidated("questions", apiPath(["questions", route.taskId, route.chunkId])),
      fetchValidated("decisions", apiPath(["decisions", route.taskId, route.chunkId]))
    ]);
    const chunk =
      array(chunksPayload.chunks).find((candidate) => candidate.id === route.chunkId) ||
      array(taskPayload.task.chunks).find((candidate) => candidate.id === route.chunkId) ||
      null;

    if (chunk === null) {
      throw payloadError("chunks", "Malformed chunk detail: chunk is missing from task chunk list.");
    }

    return {
      kind: "chunk",
      task: taskPayload.task,
      chunk,
      readiness: readinessFromPayload(readinessPayload),
      readinessPayload,
      review: reviewPayload.review,
      questions: questionsPayload.questions,
      decisions: decisionsPayload.decisions
    };
  }

  if (route.kind === "dispatch") {
    const payload = await fetchValidated("dispatchRun", apiPath(["dispatch-runs", route.runId]));
    return { kind: "dispatch", dispatchRun: payload.dispatch_run };
  }

  if (route.kind === "session") {
    const payload = await fetchValidated("session", apiPath(["sessions", route.sessionId]));
    return { kind: "session", session: payload.session };
  }

  return null;
}

async function fetchValidated(key, path) {
  return validatePayload(key, await fetchJson(path));
}

async function loadChunkExtras(taskId, chunks) {
  const entries = await Promise.all(
    chunks.map(async (chunk) => {
      const [readinessPayload, questionsPayload, decisionsPayload] = await Promise.all([
        fetchValidated("readiness", apiPath(["readiness", taskId, chunk.id])),
        fetchValidated("questions", apiPath(["questions", taskId, chunk.id])),
        fetchValidated("decisions", apiPath(["decisions", taskId, chunk.id]))
      ]);
      return [
        chunk.id,
        {
          readiness: readinessFromPayload(readinessPayload),
          questions: questionsPayload.questions,
          decisions: decisionsPayload.decisions
        }
      ];
    })
  );

  return new Map(entries);
}

async function submitWriteForm(form) {
  const actionKey = form.dataset.actionKey || "";
  if (actionKey.length === 0 || state.write.actions.get(actionKey)?.status === "pending") {
    return;
  }

  let request;
  try {
    request = writeRequestFromForm(form);
  } catch (error) {
    setWriteAction(actionKey, "error", error.message || "Unable to submit form.");
    renderRoute();
    return;
  }

  const confirmMessage = form.dataset.confirm || "";
  if (confirmMessage.length > 0 && !window.confirm(confirmMessage)) {
    return;
  }

  setWriteAction(actionKey, "pending", "Saving");
  renderRoute();

  try {
    await postJson(request.path, request.body);
    setWriteAction(actionKey, "success", request.successMessage);
    await loadForemanData();
  } catch (error) {
    setWriteAction(actionKey, "error", readWriteErrorMessage(error.body) || error.message || "Write failed.");
    renderRoute();
  }
}

async function submitReadForm(form) {
  const actionKey = form.dataset.actionKey || "";
  if (actionKey.length === 0 || state.read.actions.get(actionKey)?.status === "pending") {
    return;
  }

  let request;
  try {
    request = readRequestFromForm(form);
  } catch (error) {
    setReadAction(actionKey, "error", error.message || "Unable to load data.");
    renderRoute();
    return;
  }

  setReadAction(actionKey, "pending", request.pendingMessage);
  renderRoute();

  try {
    const body = await fetchJson(request.path);
    setReadAction(actionKey, "success", request.successMessage, body);
    renderRoute();
  } catch (error) {
    setReadAction(actionKey, "error", readWriteErrorMessage(error.body) || error.message || "Request failed.");
    renderRoute();
  }
}

function writeRequestFromForm(form) {
  const data = new FormData(form);
  const action = form.dataset.action || "";

  if (action === "chunk-status") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    return {
      path: apiPath(["chunks", taskId, chunkId, "status"]),
      body: { status: requireFormString(data, "status") },
      successMessage: "Status saved."
    };
  }

  if (action === "chunk-stage") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    return {
      path: apiPath(["chunks", taskId, chunkId, "stage"]),
      body: { stage: requireFormString(data, "stage") },
      successMessage: "Stage saved."
    };
  }

  if (action === "chunk-note") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    return {
      path: apiPath(["chunks", taskId, chunkId, "notes"]),
      body: { body: requireFormString(data, "body") },
      successMessage: "Note added."
    };
  }

  if (action === "question-add") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    return {
      path: apiPath(["questions", taskId, chunkId]),
      body: { body: requireFormString(data, "body") },
      successMessage: "Question added."
    };
  }

  if (action === "question-answer") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    const questionId = requireDataAttribute(form, "questionId");
    return {
      path: apiPath(["questions", taskId, chunkId, questionId, "answer"]),
      body: { answer: requireFormString(data, "answer") },
      successMessage: "Answer saved."
    };
  }

  if (action === "decision-add") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    return {
      path: apiPath(["decisions", taskId, chunkId]),
      body: { body: requireFormString(data, "body") },
      successMessage: "Decision added."
    };
  }

  if (action === "dispatch-start") {
    const taskId = requireDataAttribute(form, "taskId");
    const chunkId = requireDataAttribute(form, "chunkId");
    return {
      path: apiPath(["chunks", taskId, chunkId, "dispatch", "start"]),
      body: {
        tool: requireFormString(data, "tool"),
        stage: optionalFormString(data, "stage")
      },
      successMessage: "Dispatch started."
    };
  }

  if (action === "dispatch-cancel") {
    const runId = requireDataAttribute(form, "runId");
    return {
      path: apiPath(["dispatch-runs", runId, "cancel"]),
      body: {},
      successMessage: "Dispatch canceled."
    };
  }

  if (action === "dispatch-finish") {
    const runId = requireDataAttribute(form, "runId");
    return {
      path: apiPath(["dispatch-runs", runId, "finish"]),
      body: {
        status: requireFormString(data, "status"),
        message: optionalFormString(data, "message"),
        allow_missing_session: data.get("allow_missing_session") === "on"
      },
      successMessage: "Dispatch finished."
    };
  }

  if (action === "dispatch-reconcile") {
    const runId = requireDataAttribute(form, "runId");
    return {
      path: apiPath(["dispatch-runs", runId, "reconcile"]),
      body: {
        older_than: optionalFormString(data, "older_than")
      },
      successMessage: "Dispatch reconciled."
    };
  }

  if (action === "dispatch-merge") {
    const runId = requireDataAttribute(form, "runId");
    return {
      path: apiPath(["dispatch-runs", runId, "merge"]),
      body: {},
      successMessage: "Dispatch merged."
    };
  }

  if (action === "dispatch-cleanup") {
    const runId = requireDataAttribute(form, "runId");
    return {
      path: apiPath(["dispatch-runs", runId, "cleanup"]),
      body: {
        force: data.get("force") === "on"
      },
      successMessage: "Dispatch cleaned up."
    };
  }

  throw new Error("Unknown write action.");
}

function readRequestFromForm(form) {
  const data = new FormData(form);
  const action = form.dataset.action || "";

  if (action === "dispatch-workspace") {
    const runId = requireDataAttribute(form, "runId");
    return {
      path: apiPath(["dispatch-runs", runId, "workspace"]),
      pendingMessage: "Inspecting workspace",
      successMessage: "Workspace inspected."
    };
  }

  if (action === "dispatch-diff") {
    const runId = requireDataAttribute(form, "runId");
    const mode = requireFormString(data, "mode");
    return {
      path: apiPath(["dispatch-runs", runId, "diff"]) + "?mode=" + encodeURIComponent(mode),
      pendingMessage: "Loading diff",
      successMessage: "Diff loaded."
    };
  }

  throw new Error("Unknown read action.");
}

function requireDataAttribute(form, key) {
  const value = form.dataset[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Missing write target.");
  }
  return value;
}

function requireFormString(data, key) {
  const value = data.get(key);
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) {
    throw new Error("Enter a value before saving.");
  }
  return text;
}

function optionalFormString(data, key) {
  const value = data.get(key);
  const text = typeof value === "string" ? value.trim() : "";
  return text.length === 0 ? null : text;
}

function renderRoute() {
  const overview = byId("overview-view");
  const detail = byId("detail-view");
  if (!overview || !detail) {
    return;
  }

  const route = state.route;
  const isOverview = route.kind === "overview";
  overview.classList.toggle("hidden", !isOverview);
  detail.classList.toggle("hidden", isOverview);

  if (isOverview) {
    setText("page-title", "Work Backlog");
    return;
  }

  if (route.kind === "unknown") {
    setText("page-title", "Unknown View");
    detail.innerHTML = detailHeader("Navigation", "Unknown view", "", "") + detailPanel("Route", "", panelState("No read-only view exists for this route.", true));
    return;
  }

  const key = routeKey(route);
  if (state.detail.key !== key || state.detail.loading) {
    setText("page-title", routeTitle(route));
    detail.innerHTML = detailHeader("Loading", routeTitle(route), "", "") + detailPanel("Detail", "", panelState("Loading"));
    return;
  }

  if (state.detail.error) {
    setText("page-title", routeTitle(route));
    detail.innerHTML =
      detailHeader("Error", routeTitle(route), "", "") +
      detailPanel("Detail", "", panelState(readErrorText(state.detail.error), true));
    return;
  }

  if (state.detail.data?.kind === "task") {
    setText("page-title", "Task Detail");
    detail.innerHTML = renderTaskDetail(state.detail.data);
    return;
  }

  if (state.detail.data?.kind === "chunk") {
    setText("page-title", "Chunk Detail");
    detail.innerHTML = renderChunkDetail(state.detail.data);
    return;
  }

  if (state.detail.data?.kind === "dispatch") {
    setText("page-title", "Dispatch Detail");
    detail.innerHTML = renderDispatchDetail(state.detail.data);
    return;
  }

  if (state.detail.data?.kind === "session") {
    setText("page-title", "Session Detail");
    detail.innerHTML = renderSessionDetail(state.detail.data);
  }
}

function renderTaskDetail(data) {
  const task = data.task;
  const chunks = array(task.chunks);
  const dispatchRuns = matchingDispatchRuns(task.id, null);
  const linkedEntries = array(data.review?.linked_sessions);
  const openQuestionCount = chunks.reduce((count, chunk) => count + array(data.extras.get(chunk.id)?.questions).filter((question) => question.status === "open").length, 0);
  const decisionCount = chunks.reduce((count, chunk) => count + array(data.extras.get(chunk.id)?.decisions).length, 0);

  return detailHeader(
    "Task",
    task.id + " - " + (task.title || "Untitled task"),
    chip(task.status || "unknown", task.status),
    esc(task.description || "")
  ) +
    detailWriteBanner() +
    "<div class=\"detail-grid\">" +
      detailPanel("Task State", "", keyGrid([
        ["Full task id", task.id],
        ["Source", task.source_ref || "null"],
        ["Updated", formatDateTime(task.updated_at)],
        ["Created", formatDateTime(task.created_at)],
        ["Linked sessions", data.review?.total_linked_sessions ?? 0],
        ["Linked cost", money(Number(data.review?.total_cost_usd || 0))]
      ])) +
      detailPanel("Chunks", chunks.length + " total", renderTaskChunkTable(task, chunks, data.extras, data.review)) +
      detailPanel("Open Questions", String(openQuestionCount), renderQuestionsByChunk(task, chunks, data.extras, true)) +
      detailPanel("Accepted Decisions", String(decisionCount), renderDecisionsByChunk(task, chunks, data.extras)) +
      detailPanel("Dispatch Runs", String(dispatchRuns.length), renderDispatchRunTable(dispatchRuns)) +
      detailPanel("Linked Sessions", String(linkedEntries.length), renderLinkedSessionEntries(linkedEntries)) +
    "</div>";
}

function renderChunkDetail(data) {
  const ref = data.task.id + "/" + data.chunk.id;
  const dispatchRuns = matchingDispatchRuns(data.task.id, data.chunk.id);
  const linkedEntries = array(data.review?.linked_sessions_by_stage).flatMap((group) => array(group.sessions));
  const blockers = array(data.readinessPayload.blockers);
  const warnings = array(data.readinessPayload.warnings);

  return detailHeader(
    "Chunk",
    ref + " - " + (data.chunk.title || "Untitled chunk"),
    chip("chunk " + (data.chunk.status || "unknown"), data.chunk.status) + chip("stage " + (data.chunk.stage || "unset"), data.chunk.stage) + dispatchGateChip(data.chunk, data.readiness),
    linkToTask(data.task.id, data.task.title || data.task.id)
  ) +
    detailWriteBanner() +
    "<div class=\"detail-grid\">" +
      detailPanel("Chunk State", "", keyGrid([
        ["Full chunk ref", ref],
        ["Updated", formatDateTime(data.chunk.updated_at)],
        ["Created", formatDateTime(data.chunk.created_at)],
        ["Linked cost", money(Number(data.review?.total_cost_usd || 0))],
        ["Dispatch runs", dispatchRuns.length]
      ])) +
      detailPanel("Controls", "", renderChunkControls(data.task.id, data.chunk), "detail-panel-wide") +
      detailPanel("Dispatch Start", "", renderDispatchStartControls(data.task.id, data.chunk, data.readiness), "detail-panel-wide") +
      detailPanel("Spec", "", preBlock(data.chunk.spec || "No spec."), "detail-panel-wide") +
      detailPanel("Dispatch Gate", dispatchGateDetailMeta(data.chunk, data.readiness, blockers), renderDispatchGateDetail(data.chunk, data.readiness, blockers, warnings)) +
      detailPanel("Open Questions", String(array(data.questions).filter((question) => question.status === "open").length), renderQuestionList(data.questions, data.task.id, data.chunk.id)) +
      detailPanel("Accepted Decisions", String(array(data.decisions).length), renderDecisionList(data.decisions)) +
      detailPanel("Linked Sessions", String(linkedEntries.length), renderLinkedSessionEntries(linkedEntries)) +
      detailPanel("Dispatch Runs", String(dispatchRuns.length), renderDispatchRunTable(dispatchRuns)) +
      detailPanel("Notes", String(array(data.chunk.notes).length), renderNotes(data.chunk.notes)) +
    "</div>";
}

function renderDispatchDetail(data) {
  const run = data.dispatchRun;
  const attempts = array(run.attempts);
  const events = array(run.events);
  const taskChunkLink = run.task_id && run.chunk_id ? linkToChunk(run.task_id, run.chunk_id, run.task_id + "/" + run.chunk_id) : "";

  return detailHeader(
    "Dispatch Run",
    run.id,
    chip(run.status || "unknown", run.status) + chip(run.requested_stage || "stage unset", run.requested_stage),
    taskChunkLink
  ) +
    detailWriteBanner() +
    "<div class=\"detail-grid\">" +
      detailPanel("Run State", "", keyGrid([
        ["Full run id", run.id],
        ["Repo", run.repo_name || "null"],
        ["Task", run.task_id ? htmlValue(linkToTask(run.task_id, run.task_id)) : "null"],
        ["Chunk", taskChunkLink ? htmlValue(taskChunkLink) : "null"],
        ["Requested by", run.requested_by || "null"],
        ["Source", run.source || "null"],
        ["Created", formatDateTime(run.created_at)],
        ["Updated", formatDateTime(run.updated_at)],
        ["Finished", formatDateTime(run.finished_at)]
      ])) +
      detailPanel("Lifecycle Controls", "", renderDispatchLifecycleControls(run)) +
      detailPanel("Workspace Review", "", renderDispatchWorkspaceControls(run), "detail-panel-wide") +
      detailPanel("Advanced Worktree Actions", "", renderDispatchAdvancedControls(run), "detail-panel-wide") +
      detailPanel("Attempts", String(attempts.length), renderAttempts(attempts), "detail-panel-wide") +
      detailPanel("Event Timeline", String(events.length), renderEvents(events), "detail-panel-wide") +
    "</div>";
}

function renderSessionDetail(data) {
  const session = data.session;
  if (session === null) {
    return detailHeader("Session", "Missing session", "", "") + detailPanel("Session", "", panelState("No session found.", true));
  }

  return detailHeader(
    "Session",
    session.id,
    chip(session.source || "unknown", session.source) + chip(session.model || "model unset", "active"),
    renderInlineChunkLinks(array(session.linked_chunks))
  ) +
    "<div class=\"detail-grid\">" +
      detailPanel("Session State", "", keyGrid([
        ["Full session id", session.id],
        ["Source session id", session.source_session_id || "null"],
        ["Source", session.source || "null"],
        ["Model", session.model || "null"],
        ["Project path", session.project_path || "null"],
        ["Repo remote", session.repo_remote || "null"],
        ["Machine", session.machine || "null"],
        ["Started", formatDateTime(session.started_at)],
        ["Ended", formatDateTime(session.ended_at)],
        ["Created", formatDateTime(session.created_at)]
      ]), "detail-panel-wide") +
      detailPanel("Usage", "", renderUsage(session.usage)) +
      detailPanel("Linked Chunks", String(array(session.linked_chunks).length), renderSessionChunkLinks(session.linked_chunks)) +
      detailPanel("Summary", session.summary?.model_used || "", preBlock(session.summary?.summary_md || "No summary."), "detail-panel-wide") +
    "</div>";
}

function renderChunkControls(taskId, chunk) {
  return "<div class=\"control-grid\">" +
    renderChunkStateControls(taskId, chunk, false) +
    renderTextWriteForm({
      action: "chunk-note",
      key: writeActionKey("chunk-note", taskId, chunk.id),
      taskId,
      chunkId: chunk.id,
      label: "Add note",
      field: "body",
      buttonLabel: "Add note"
    }) +
    renderTextWriteForm({
      action: "question-add",
      key: writeActionKey("question-add", taskId, chunk.id),
      taskId,
      chunkId: chunk.id,
      label: "Add question",
      field: "body",
      buttonLabel: "Add question"
    }) +
    renderTextWriteForm({
      action: "decision-add",
      key: writeActionKey("decision-add", taskId, chunk.id),
      taskId,
      chunkId: chunk.id,
      label: "Accept decision",
      field: "body",
      buttonLabel: "Accept decision"
    }) +
  "</div>";
}

function renderDispatchStartControls(taskId, chunk, readiness) {
  const ref = taskId + "/" + chunk.id;
  const actionKey = dispatchActionKey("dispatch-start", ref);
  const pending = isWritePending(actionKey);
  const ready = readiness.state === "ready";
  const stage = DISPATCH_STAGES.includes(chunk.stage) ? chunk.stage : "implement";

  return "<div class=\"control-grid\">" +
    "<form class=\"write-form write-form-card\" data-ui-write-form data-action=\"dispatch-start\" data-action-key=\"" + esc(actionKey) + "\" data-task-id=\"" + esc(taskId) + "\" data-chunk-id=\"" + esc(chunk.id) + "\" data-confirm=\"Start dispatch for " + esc(ref) + "? This can launch a local agent.\">" +
      "<label class=\"field\"><span>Tool</span>" +
        "<select class=\"select-control\" name=\"tool\"" + disabledAttr(pending || !ready) + ">" + renderOptions(DISPATCH_TOOLS, "codex") + "</select>" +
      "</label>" +
      "<label class=\"field\"><span>Stage</span>" +
        "<select class=\"select-control\" name=\"stage\"" + disabledAttr(pending || !ready) + ">" + renderOptions(DISPATCH_STAGES, stage) + "</select>" +
      "</label>" +
      "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending || !ready) + ">" + esc(pending ? "Starting" : "Start dispatch") + "</button></div>" +
      (ready ? "" : "<p class=\"form-status form-status-pending\">Chunk is not dispatch-ready.</p>") +
      renderWriteActionStatus(actionKey) +
    "</form>" +
  "</div>";
}

function renderChunkStateControls(taskId, chunk, compact) {
  return "<div class=\"" + (compact ? "chunk-table-controls" : "state-control-pair") + "\">" +
    renderChunkSelectForm(taskId, chunk, "status", compact) +
    renderChunkSelectForm(taskId, chunk, "stage", compact) +
  "</div>";
}

function renderChunkSelectForm(taskId, chunk, kind, compact) {
  const action = kind === "status" ? "chunk-status" : "chunk-stage";
  const value = kind === "status" ? chunk.status : chunk.stage;
  const values = kind === "status" ? CHUNK_STATUSES : CHUNK_STAGES;
  const label = kind === "status" ? "Status" : "Stage";
  const actionKey = writeActionKey(action, taskId, chunk.id);
  const pending = isWritePending(actionKey);

  return "<form class=\"write-form " + (compact ? "write-form-compact" : "write-form-card") + "\" data-ui-write-form data-action=\"" + esc(action) + "\" data-action-key=\"" + esc(actionKey) + "\" data-task-id=\"" + esc(taskId) + "\" data-chunk-id=\"" + esc(chunk.id) + "\">" +
    "<label class=\"field\"><span>" + esc(label) + "</span>" +
      "<select class=\"select-control\" name=\"" + esc(kind) + "\"" + disabledAttr(pending) + ">" + renderOptions(values, value) + "</select>" +
    "</label>" +
    "<div class=\"form-actions\"><button class=\"" + (compact ? "button-compact" : "button-primary") + "\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Saving" : "Save") + "</button></div>" +
    renderWriteActionStatus(actionKey) +
  "</form>";
}

function renderTextWriteForm(options) {
  const pending = isWritePending(options.key);
  return "<form class=\"write-form write-form-card\" data-ui-write-form data-action=\"" + esc(options.action) + "\" data-action-key=\"" + esc(options.key) + "\" data-task-id=\"" + esc(options.taskId) + "\" data-chunk-id=\"" + esc(options.chunkId) + "\">" +
    "<label class=\"field\"><span>" + esc(options.label) + "</span>" +
      "<textarea class=\"textarea-control\" name=\"" + esc(options.field) + "\" rows=\"3\" maxlength=\"4000\" required" + disabledAttr(pending) + "></textarea>" +
    "</label>" +
    "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Saving" : options.buttonLabel) + "</button></div>" +
    renderWriteActionStatus(options.key) +
  "</form>";
}

function renderDispatchLifecycleControls(run) {
  const forms = [];
  if (run.status === "queued") {
    forms.push(renderDispatchButtonWriteForm({
      action: "dispatch-cancel",
      key: dispatchActionKey("dispatch-cancel", run.id),
      runId: run.id,
      label: "Cancel queued run",
      buttonLabel: "Cancel",
      confirm: "Cancel dispatch run " + shortId(run.id) + "?"
    }));
  }

  if (run.status === "running") {
    forms.push(renderDispatchFinishForm(run));
  }

  if (run.status === "claimed" || run.status === "running") {
    forms.push(renderDispatchReconcileForm(run));
  }

  if (forms.length === 0) {
    return panelState("No lifecycle controls for this status.");
  }

  return "<div class=\"control-grid\">" + forms.join("") + "</div>";
}

function renderDispatchAdvancedControls(run) {
  const forms = [];
  if (run.status === "succeeded") {
    forms.push(renderDispatchButtonWriteForm({
      action: "dispatch-merge",
      key: dispatchActionKey("dispatch-merge", run.id),
      runId: run.id,
      label: "Merge reviewed work",
      buttonLabel: "Merge",
      confirm: "Merge dispatch run " + shortId(run.id) + " into the current branch?"
    }));
  }

  if (isDispatchTerminal(run.status)) {
    forms.push(renderDispatchCleanupForm(run));
  }

  if (forms.length === 0) {
    return panelState("No terminal worktree actions for this status.");
  }

  return "<div class=\"control-grid\">" + forms.join("") + "</div>";
}

function renderDispatchButtonWriteForm(options) {
  const pending = isWritePending(options.key);
  return "<form class=\"write-form write-form-card\" data-ui-write-form data-action=\"" + esc(options.action) + "\" data-action-key=\"" + esc(options.key) + "\" data-run-id=\"" + esc(options.runId) + "\" data-confirm=\"" + esc(options.confirm) + "\">" +
    "<div class=\"field\"><span>" + esc(options.label) + "</span></div>" +
    "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Working" : options.buttonLabel) + "</button></div>" +
    renderWriteActionStatus(options.key) +
  "</form>";
}

function renderDispatchFinishForm(run) {
  const actionKey = dispatchActionKey("dispatch-finish", run.id);
  const pending = isWritePending(actionKey);
  return "<form class=\"write-form write-form-card\" data-ui-write-form data-action=\"dispatch-finish\" data-action-key=\"" + esc(actionKey) + "\" data-run-id=\"" + esc(run.id) + "\" data-confirm=\"Finish dispatch run " + esc(shortId(run.id)) + "?\">" +
    "<label class=\"field\"><span>Result</span>" +
      "<select class=\"select-control\" name=\"status\"" + disabledAttr(pending) + ">" + renderOptions(DISPATCH_FINISH_STATUSES, "succeeded") + "</select>" +
    "</label>" +
    "<label class=\"field\"><span>Message</span>" +
      "<textarea class=\"textarea-control\" name=\"message\" rows=\"2\" maxlength=\"1000\"" + disabledAttr(pending) + "></textarea>" +
    "</label>" +
    "<label class=\"checkbox-field\"><input type=\"checkbox\" name=\"allow_missing_session\"" + disabledAttr(pending) + "> <span>Allow missing session</span></label>" +
    "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Finishing" : "Finish") + "</button></div>" +
    renderWriteActionStatus(actionKey) +
  "</form>";
}

function renderDispatchReconcileForm(run) {
  const actionKey = dispatchActionKey("dispatch-reconcile", run.id);
  const pending = isWritePending(actionKey);
  return "<form class=\"write-form write-form-card\" data-ui-write-form data-action=\"dispatch-reconcile\" data-action-key=\"" + esc(actionKey) + "\" data-run-id=\"" + esc(run.id) + "\" data-confirm=\"Reconcile dispatch run " + esc(shortId(run.id)) + "?\">" +
    "<label class=\"field\"><span>Older than</span>" +
      "<input class=\"input-control\" name=\"older_than\" placeholder=\"24h\" maxlength=\"24\"" + disabledAttr(pending) + ">" +
    "</label>" +
    "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Reconciling" : "Reconcile") + "</button></div>" +
    renderWriteActionStatus(actionKey) +
  "</form>";
}

function renderDispatchCleanupForm(run) {
  const actionKey = dispatchActionKey("dispatch-cleanup", run.id);
  const pending = isWritePending(actionKey);
  return "<form class=\"write-form write-form-card\" data-ui-write-form data-action=\"dispatch-cleanup\" data-action-key=\"" + esc(actionKey) + "\" data-run-id=\"" + esc(run.id) + "\" data-confirm=\"Clean up dispatch worktree for " + esc(shortId(run.id)) + "?\">" +
    "<label class=\"checkbox-field\"><input type=\"checkbox\" name=\"force\"" + disabledAttr(pending) + "> <span>Force</span></label>" +
    "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Cleaning" : "Clean up") + "</button></div>" +
    renderWriteActionStatus(actionKey) +
  "</form>";
}

function renderDispatchWorkspaceControls(run) {
  const workspaceKey = dispatchActionKey("dispatch-workspace", run.id);
  const diffKey = dispatchActionKey("dispatch-diff", run.id);
  const workspacePending = isReadPending(workspaceKey);
  const diffPending = isReadPending(diffKey);

  return "<div class=\"dispatch-review-stack\">" +
    "<div class=\"control-grid\">" +
      "<form class=\"write-form write-form-card\" data-ui-read-form data-action=\"dispatch-workspace\" data-action-key=\"" + esc(workspaceKey) + "\" data-run-id=\"" + esc(run.id) + "\">" +
        "<div class=\"field\"><span>Workspace</span></div>" +
        "<div class=\"form-actions\"><button class=\"button-secondary\" type=\"submit\"" + disabledAttr(workspacePending) + ">" + esc(workspacePending ? "Inspecting" : "Inspect") + "</button></div>" +
        renderReadActionStatus(workspaceKey) +
      "</form>" +
      "<form class=\"write-form write-form-card\" data-ui-read-form data-action=\"dispatch-diff\" data-action-key=\"" + esc(diffKey) + "\" data-run-id=\"" + esc(run.id) + "\">" +
        "<label class=\"field\"><span>Diff</span>" +
          "<select class=\"select-control\" name=\"mode\"" + disabledAttr(diffPending) + ">" + renderOptions(DISPATCH_DIFF_MODES, "full") + "</select>" +
        "</label>" +
        "<div class=\"form-actions\"><button class=\"button-secondary\" type=\"submit\"" + disabledAttr(diffPending) + ">" + esc(diffPending ? "Loading" : "Show diff") + "</button></div>" +
        renderReadActionStatus(diffKey) +
      "</form>" +
    "</div>" +
    renderDispatchReadOutput(workspaceKey, "workspace") +
    renderDispatchReadOutput(diffKey, "diff") +
  "</div>";
}

function renderDispatchReadOutput(actionKey, kind) {
  const entry = state.read.actions.get(actionKey);
  if (!entry || entry.status !== "success") {
    return "";
  }
  if (kind === "workspace") {
    return renderWorkspaceInspection(entry.body?.workspace);
  }
  if (kind === "diff") {
    return renderWorkspaceDiff(entry.body?.diff);
  }
  return "";
}

function renderWorkspaceInspection(workspace) {
  if (!workspace || typeof workspace !== "object") {
    return panelState("Workspace inspection response was empty.", true);
  }

  return "<div class=\"dispatch-output\">" +
    keyGrid([
      ["Workspace", workspace.workspace_path || "null"],
      ["Git root", workspace.git_root || "null"],
      ["Branch", workspace.branch || "detached"],
      ["Expected branch", workspace.expected_branch || "null"],
      ["Branch matches", workspace.branch_matches ? "yes" : "no"],
      ["Dirty", workspace.dirty ? "yes" : "no"],
      ["Ahead/behind", (workspace.ahead ?? "null") + "/" + (workspace.behind ?? "null")],
      ["Upstream", workspace.upstream || "null"]
    ]) +
    renderWorkspaceFiles(workspace) +
    renderWorkspaceCommits(workspace.recent_commits) +
  "</div>";
}

function renderWorkspaceFiles(workspace) {
  const changed = array(workspace.changed_files);
  const untracked = array(workspace.untracked_files).map((path) => ({
    path,
    index_status: "?",
    worktree_status: "?",
    original_path: null
  }));
  const files = changed.concat(untracked);
  if (files.length === 0) {
    return panelState("No workspace file changes.");
  }

  return "<div class=\"table-scroll\"><table class=\"data-table detail-table\"><thead><tr><th>Path</th><th>Index</th><th>Worktree</th><th>Original</th></tr></thead><tbody>" +
    files.map((file) =>
      "<tr>" +
        "<td class=\"mono\">" + esc(file.path || "") + "</td>" +
        "<td class=\"mono\">" + esc(file.index_status || "") + "</td>" +
        "<td class=\"mono\">" + esc(file.worktree_status || "") + "</td>" +
        "<td class=\"mono\">" + esc(file.original_path || "null") + "</td>" +
      "</tr>"
    ).join("") +
  "</tbody></table></div>";
}

function renderWorkspaceCommits(commits) {
  const rows = array(commits);
  if (rows.length === 0) {
    return "";
  }

  return "<div class=\"rows\">" + rows.map((commit) =>
    "<article class=\"row-card\">" +
      "<div><div class=\"item-title\"><span class=\"item-id\">" + esc(shortId(commit.sha || "")) + "</span><span>" + esc(commit.subject || "") + "</span></div>" +
      "<p class=\"item-copy\">" + esc([commit.author_name, formatDateTime(commit.date)].filter(Boolean).join(" - ")) + "</p></div>" +
    "</article>"
  ).join("") + "</div>";
}

function renderWorkspaceDiff(diff) {
  if (!diff || typeof diff !== "object") {
    return panelState("Diff response was empty.", true);
  }

  const text = String(diff.text || "");
  return "<div class=\"dispatch-output\">" +
    "<div class=\"panel-head\"><h3 class=\"panel-title\">" + esc(diff.mode || "diff") + "</h3></div>" +
    preBlock(text.trim().length > 0 ? text : "No tracked diff.") +
  "</div>";
}

function isDispatchTerminal(status) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function renderTaskChunkTable(task, chunks, extras, review) {
  if (chunks.length === 0) {
    return panelState("No chunks found.");
  }

  return "<div class=\"table-scroll\"><table class=\"data-table detail-table\"><thead><tr><th>Chunk</th><th>Work state</th><th>Dispatch gate</th><th>Questions</th><th>Decisions</th><th>Sessions</th><th>Cost</th></tr></thead><tbody>" +
    chunks.map((chunk) => {
      const extra = extras.get(chunk.id) || { readiness: { state: "unknown", message: "Unknown", blockers: [] }, questions: [], decisions: [] };
      const rollup = taskReviewRollup(review, chunk.id);
      const openQuestions = array(extra.questions).filter((question) => question.status === "open").length;
      return "<tr>" +
        "<td><div class=\"item-title\">" + linkToChunk(task.id, chunk.id, task.id + "/" + chunk.id) + "<span>" + esc(chunk.title || "Untitled chunk") + "</span></div></td>" +
        "<td><div class=\"meta-line\">" + chip("chunk " + (chunk.status || "unknown"), chunk.status) + chip("stage " + (chunk.stage || "unset"), chunk.stage) + "</div>" + renderChunkStateControls(task.id, chunk, true) + "</td>" +
        "<td>" + renderDispatchGateCell({ ...chunk, task }, extra.readiness) + "</td>" +
        "<td class=\"mono\">" + esc(openQuestions + " open / " + array(extra.questions).length + " total") + "</td>" +
        "<td class=\"mono\">" + esc(array(extra.decisions).length) + "</td>" +
        "<td class=\"mono\">" + esc(rollup?.linked_session_count ?? 0) + "</td>" +
        "<td class=\"mono\">" + esc(money(Number(rollup?.total_cost_usd || 0))) + "</td>" +
      "</tr>";
    }).join("") +
  "</tbody></table></div>";
}

function renderQuestionsByChunk(task, chunks, extras, openOnly) {
  const rows = chunks.flatMap((chunk) => {
    const questions = array(extras.get(chunk.id)?.questions).filter((question) => !openOnly || question.status === "open");
    return questions.map((question) => ({ chunk, question }));
  });

  if (rows.length === 0) {
    return panelState(openOnly ? "No open questions." : "No questions.");
  }

  return rows.map(({ chunk, question }) =>
    "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\">" + linkToChunk(task.id, chunk.id, task.id + "/" + chunk.id) + "<span>" + esc(question.id) + "</span></div>" +
        "<p class=\"item-copy\">" + esc(question.body) + "</p>" +
        (question.answer ? "<p class=\"item-copy\">" + esc(question.answer) + "</p>" : "") +
      "</div>" +
      "<div class=\"chips\">" + chip(question.status || "unknown", question.status) + "</div>" +
    "</article>"
  ).join("");
}

function renderDecisionsByChunk(task, chunks, extras) {
  const rows = chunks.flatMap((chunk) => array(extras.get(chunk.id)?.decisions).map((decision) => ({ chunk, decision })));
  if (rows.length === 0) {
    return panelState("No accepted decisions.");
  }

  return rows.map(({ chunk, decision }) =>
    "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\">" + linkToChunk(task.id, chunk.id, task.id + "/" + chunk.id) + "<span>" + esc(decision.id) + "</span></div>" +
        "<p class=\"item-copy\">" + esc(decision.body) + "</p>" +
      "</div>" +
      "<div class=\"chips\">" + chip(formatDate(decision.decided_at), "done") + "</div>" +
    "</article>"
  ).join("");
}

function renderQuestionList(questions, taskId = null, chunkId = null) {
  const rows = array(questions);
  if (rows.length === 0) {
    return panelState("No questions.");
  }

  return rows.map((question) => {
    const canAnswer = taskId !== null && chunkId !== null && question.status === "open";
    return "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(question.id) + "</span><span>" + esc(question.status || "unknown") + "</span></div>" +
        "<p class=\"item-copy\">" + esc(question.body) + "</p>" +
        (question.answer ? "<p class=\"item-copy\">" + esc(question.answer) + "</p>" : "") +
        (canAnswer ? renderQuestionAnswerForm(taskId, chunkId, question) : "") +
      "</div>" +
      "<div class=\"chips\">" + chip(question.status || "unknown", question.status) + chip(formatDate(question.answered_at || question.asked_at), question.status) + "</div>" +
    "</article>";
  }).join("");
}

function renderQuestionAnswerForm(taskId, chunkId, question) {
  const actionKey = writeActionKey("question-answer", taskId, chunkId, question.id);
  const pending = isWritePending(actionKey);
  return "<form class=\"write-form answer-form\" data-ui-write-form data-action=\"question-answer\" data-action-key=\"" + esc(actionKey) + "\" data-task-id=\"" + esc(taskId) + "\" data-chunk-id=\"" + esc(chunkId) + "\" data-question-id=\"" + esc(question.id) + "\">" +
    "<label class=\"field\"><span>Answer</span>" +
      "<textarea class=\"textarea-control\" name=\"answer\" rows=\"2\" maxlength=\"4000\" required" + disabledAttr(pending) + "></textarea>" +
    "</label>" +
    "<div class=\"form-actions\"><button class=\"button-primary\" type=\"submit\"" + disabledAttr(pending) + ">" + esc(pending ? "Saving" : "Answer") + "</button></div>" +
    renderWriteActionStatus(actionKey) +
  "</form>";
}

function renderDecisionList(decisions) {
  const rows = array(decisions);
  if (rows.length === 0) {
    return panelState("No accepted decisions.");
  }

  return rows.map((decision) =>
    "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(decision.id) + "</span><span>Accepted</span></div>" +
        "<p class=\"item-copy\">" + esc(decision.body) + "</p>" +
      "</div>" +
      "<div class=\"chips\">" + chip(formatDate(decision.decided_at), "done") + "</div>" +
    "</article>"
  ).join("");
}

function renderDispatchGateDetail(chunk, readiness, blockers, warnings) {
  const summary = dispatchGateSummary(chunk, readiness);
  if (chunk.status === "done") {
    return "<div class=\"detail-copy\">" +
      "<div class=\"chips\">" + chip(summary.label, summary.tone) + "</div>" +
      "<p class=\"item-copy\">" + esc(summary.note) + "</p>" +
    "</div>";
  }

  const blockerRows = blockers.map((blocker) => "<li><span class=\"item-id\">" + esc(blocker.code || "blocker") + "</span> " + esc(blocker.message || "") + "</li>");
  const warningRows = warnings.map((warning) => "<li><span class=\"item-id\">" + esc(warning.code || "warning") + "</span> " + esc(warning.message || "") + "</li>");
  return "<div class=\"detail-copy\">" +
    "<div class=\"chips\">" + chip(summary.label, summary.tone) + "</div>" +
    (blockerRows.length === 0 ? "<p class=\"item-copy\">No dispatch gate requirements are blocking launch.</p>" : "<ul class=\"detail-list\">" + blockerRows.join("") + "</ul>") +
    (warningRows.length === 0 ? "" : "<p class=\"detail-subtitle\">Warnings</p><ul class=\"detail-list\">" + warningRows.join("") + "</ul>") +
  "</div>";
}

function renderLinkedSessionEntries(entries) {
  const rows = array(entries);
  if (rows.length === 0) {
    return panelState("No linked sessions.");
  }

  return rows.map((entry) => {
    const session = entry.session || {};
    const link = entry.link || {};
    return "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\">" + linkToSession(session.id, session.id || "missing session") + "<span>" + esc([session.source, session.model].filter(Boolean).join(" - ") || "Session") + "</span></div>" +
        "<p class=\"item-copy\">" + esc(session.summary?.summary_md ? firstLine(session.summary.summary_md) : session.project_path || "") + "</p>" +
      "</div>" +
      "<div class=\"chips\">" + chip(link.stage || "stage unset", link.stage) + chip(formatCost(session.usage?.cost_usd), "active") + chip(formatDate(session.ended_at || session.started_at), "done") + "</div>" +
    "</article>";
  }).join("");
}

function renderDispatchRunTable(runs) {
  const rows = array(runs);
  if (rows.length === 0) {
    return panelState("No dispatch runs.");
  }

  return "<div class=\"table-scroll\"><table class=\"data-table detail-table\"><thead><tr><th>Run</th><th>Status</th><th>Tool</th><th>Session</th><th>Updated</th></tr></thead><tbody>" +
    rows.map((run) => {
      const attempt = array(run.attempts)[0] || {};
      const sessionId = attempt.session_id || attempt.session?.id || "";
      return "<tr>" +
        "<td>" + linkToDispatch(run.id, run.id) + "<p class=\"item-copy\">" + esc(lastEvent(run) || "") + "</p></td>" +
        "<td>" + chip(run.status || "unknown", run.status) + "</td>" +
        "<td>" + chip(run.tool || attempt.tool || "tool unset", run.tool || attempt.tool) + "</td>" +
        "<td>" + (sessionId ? linkToSession(sessionId, shortId(sessionId)) : esc("null")) + "</td>" +
        "<td class=\"mono\">" + esc(formatDateTime(run.updated_at || run.created_at)) + "</td>" +
      "</tr>";
    }).join("") +
  "</tbody></table></div>";
}

function renderAttempts(attempts) {
  const rows = array(attempts);
  if (rows.length === 0) {
    return panelState("No attempts.");
  }

  return "<div class=\"table-scroll\"><table class=\"data-table detail-table\"><thead><tr><th>Attempt</th><th>Status</th><th>Tool</th><th>Workspace</th><th>Process</th><th>Session</th></tr></thead><tbody>" +
    rows.map((attempt) => {
      const sessionId = attempt.session_id || attempt.session?.id || "";
      return "<tr>" +
        "<td><span class=\"item-id\">" + esc(attempt.id) + "</span><p class=\"item-copy\">#" + esc(attempt.attempt_number ?? "") + "</p></td>" +
        "<td>" + chip(attempt.status || "unknown", attempt.status) + "</td>" +
        "<td>" + chip(attempt.tool || "tool unset", attempt.tool) + "</td>" +
        "<td><div class=\"mono detail-path\">" + esc(attempt.workspace_path || "null") + "</div><p class=\"item-copy\">" + esc(attempt.worktree_branch || "branch unset") + "</p></td>" +
        "<td class=\"mono\">" + esc(attempt.process_id ?? "null") + "</td>" +
        "<td>" + (sessionId ? linkToSession(sessionId, sessionId) : esc("null")) + "</td>" +
      "</tr>";
    }).join("") +
  "</tbody></table></div>";
}

function renderEvents(events) {
  const rows = array(events);
  if (rows.length === 0) {
    return panelState("No events.");
  }

  return "<ol class=\"timeline\">" + rows.map((event) =>
    "<li>" +
      "<div class=\"timeline-dot\"></div>" +
      "<div class=\"timeline-body\">" +
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(event.type || "event") + "</span><span>" + esc(formatDateTime(event.ts)) + "</span></div>" +
        "<p class=\"item-copy\">" + esc(event.message || "") + "</p>" +
        (event.attempt_id ? "<p class=\"item-copy\">Attempt " + esc(event.attempt_id) + "</p>" : "") +
        renderEventData(event) +
      "</div>" +
    "</li>"
  ).join("") + "</ol>";
}

function renderEventData(event) {
  if (!event.data_json) {
    return "";
  }
  const parsed = parseMaybeJson(event.data_json);
  const body = parsed === null ? String(event.data_json) : JSON.stringify(parsed, null, 2);
  return "<pre class=\"detail-json\">" + esc(body) + "</pre>";
}

function renderNotes(notes) {
  const rows = array(notes);
  if (rows.length === 0) {
    return panelState("No notes.");
  }

  return rows.map((note) =>
    "<article class=\"row-card\"><div><div class=\"item-title\"><span>" + esc(formatDateTime(note.ts)) + "</span></div><p class=\"item-copy\">" + esc(note.body) + "</p></div></article>"
  ).join("");
}

function renderUsage(usage) {
  if (!usage) {
    return panelState("No usage data.");
  }

  return keyGrid([
    ["Input tokens", usage.input_tokens ?? 0],
    ["Output tokens", usage.output_tokens ?? 0],
    ["Cache read tokens", usage.cache_read_tokens ?? 0],
    ["Cache creation tokens", usage.cache_creation_tokens ?? 0],
    ["Estimated cost", money(Number(usage.cost_usd || 0))]
  ]);
}

function renderSessionChunkLinks(links) {
  const rows = array(links);
  if (rows.length === 0) {
    return panelState("No linked chunks.");
  }

  return rows.map((link) =>
    "<article class=\"row-card\">" +
      "<div><div class=\"item-title\">" + linkToChunk(link.task_id, link.chunk_id, link.task_id + "/" + link.chunk_id) + "</div><p class=\"item-copy\">" + esc(link.linked_by || "") + "</p></div>" +
      "<div class=\"chips\">" + chip(link.stage || "stage unset", link.stage) + chip(formatDate(link.linked_at), "done") + "</div>" +
    "</article>"
  ).join("");
}

function detailHeader(kicker, title, chipsHtml, metaHtml) {
  return "<div class=\"detail-header\">" +
    "<div class=\"detail-header-main\">" +
      "<a class=\"back-link\" href=\"#/\">Overview</a>" +
      "<p class=\"brand-kicker\">" + esc(kicker) + "</p>" +
      "<h2 class=\"detail-title\">" + esc(title) + "</h2>" +
      (metaHtml ? "<div class=\"detail-meta\">" + metaHtml + "</div>" : "") +
    "</div>" +
    (chipsHtml ? "<div class=\"chips detail-header-chips\">" + chipsHtml + "</div>" : "") +
  "</div>";
}

function detailPanel(title, meta, body, extraClass = "") {
  return "<section class=\"data-panel detail-panel " + esc(extraClass) + "\">" +
    "<div class=\"panel-head\"><h3 class=\"panel-title\">" + esc(title) + "</h3>" +
    (meta ? "<span class=\"panel-meta\">" + esc(meta) + "</span>" : "") +
    "</div>" +
    "<div class=\"detail-panel-body\">" + body + "</div>" +
  "</section>";
}

function detailWriteBanner() {
  const latest = state.write.last;
  if (!latest || latest.detailKey !== routeKey(state.route)) {
    return "";
  }

  return "<div class=\"write-banner write-banner-" + esc(latest.status) + "\" role=\"" + (latest.status === "error" ? "alert" : "status") + "\">" +
    esc(latest.message) +
  "</div>";
}

function renderWriteActionStatus(actionKey) {
  const entry = state.write.actions.get(actionKey);
  if (!entry) {
    return "";
  }

  return "<p class=\"form-status form-status-" + esc(entry.status) + "\" role=\"" + (entry.status === "error" ? "alert" : "status") + "\">" +
    esc(entry.message) +
  "</p>";
}

function renderReadActionStatus(actionKey) {
  const entry = state.read.actions.get(actionKey);
  if (!entry) {
    return "";
  }

  return "<p class=\"form-status form-status-" + esc(entry.status) + "\" role=\"" + (entry.status === "error" ? "alert" : "status") + "\">" +
    esc(entry.message) +
  "</p>";
}

function setWriteAction(actionKey, status, message) {
  const entry = {
    status,
    message,
    detailKey: routeKey(state.route),
    updatedAt: Date.now()
  };
  state.write.actions.set(actionKey, entry);
  state.write.last = entry;
}

function setReadAction(actionKey, status, message, body = null) {
  state.read.actions.set(actionKey, {
    status,
    message,
    body,
    detailKey: routeKey(state.route),
    updatedAt: Date.now()
  });
}

function isWritePending(actionKey) {
  return state.write.actions.get(actionKey)?.status === "pending";
}

function isReadPending(actionKey) {
  return state.read.actions.get(actionKey)?.status === "pending";
}

function writeActionKey(action, taskId, chunkId, extra = "") {
  return [action, taskId, chunkId, extra].filter((part) => String(part).length > 0).join(":");
}

function dispatchActionKey(action, runOrRef, extra = "") {
  return [action, runOrRef, extra].filter((part) => String(part).length > 0).join(":");
}

function renderOptions(values, current) {
  const allValues = optionValues(values, current);
  return allValues.map((value) =>
    "<option value=\"" + esc(value) + "\"" + (String(value) === String(current || "") ? " selected" : "") + ">" + esc(value) + "</option>"
  ).join("");
}

function optionValues(values, current) {
  const result = [];
  const seen = new Set();
  const add = (value) => {
    if (value === null || value === undefined || String(value).length === 0 || seen.has(String(value))) {
      return;
    }
    seen.add(String(value));
    result.push(String(value));
  };

  if (!values.includes(current)) {
    add(current);
  }

  values.forEach(add);
  return result;
}

function disabledAttr(disabled) {
  return disabled ? " disabled" : "";
}

function keyGrid(rows) {
  return "<dl class=\"key-grid\">" + rows.map(([key, value]) =>
    "<div><dt>" + esc(key) + "</dt><dd>" + (isHtmlValue(value) ? value.html : esc(value ?? "null")) + "</dd></div>"
  ).join("") + "</dl>";
}

function preBlock(value) {
  return "<pre class=\"pre-block\">" + esc(value) + "</pre>";
}

function matchingDispatchRuns(taskId, chunkId) {
  return getDispatchRuns().filter((run) => run.task_id === taskId && (chunkId === null || run.chunk_id === chunkId));
}

function matchingSessions(taskId, chunkId) {
  return getSessions().filter((session) =>
    array(session.linked_chunks).some((link) => link.task_id === taskId && (chunkId === null || link.chunk_id === chunkId))
  );
}

function taskReviewRollup(review, chunkId) {
  return array(review?.chunk_rollups).find((rollup) => rollup.chunk?.id === chunkId) || null;
}

function renderInlineChunkLinks(links) {
  const rows = array(links);
  if (rows.length === 0) {
    return "";
  }
  return rows.map((link) => linkToChunk(link.task_id, link.chunk_id, link.task_id + "/" + link.chunk_id)).join(", ");
}

function linkToTask(taskId, label) {
  return "<a class=\"detail-link\" href=\"" + routeHref(["task", taskId]) + "\">" + esc(label || taskId) + "</a>";
}

function linkToChunk(taskId, chunkId, label) {
  return "<a class=\"detail-link\" href=\"" + routeHref(["chunk", taskId, chunkId]) + "\">" + esc(label || taskId + "/" + chunkId) + "</a>";
}

function linkToDispatch(runId, label) {
  return "<a class=\"detail-link item-id\" href=\"" + routeHref(["dispatch", runId]) + "\">" + esc(label || runId) + "</a>";
}

function linkToSession(sessionId, label) {
  if (!sessionId) {
    return esc(label || "null");
  }
  return "<a class=\"detail-link item-id\" href=\"" + routeHref(["session", sessionId]) + "\">" + esc(label || sessionId) + "</a>";
}

function htmlValue(html) {
  return { html };
}

function isHtmlValue(value) {
  return value && typeof value === "object" && typeof value.html === "string";
}

function apiPath(parts) {
  return "/api/" + parts.map((part) => encodeURIComponent(part)).join("/");
}

function routeHref(parts) {
  return "#/" + parts.map((part) => encodeURIComponent(part)).join("/");
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "" || hash === "/") {
    return { kind: "overview" };
  }

  let parts;
  try {
    parts = hash.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { kind: "unknown", raw: hash };
  }

  if (parts.length === 2 && parts[0] === "task") {
    return { kind: "task", taskId: parts[1] };
  }

  if (parts.length === 3 && parts[0] === "chunk") {
    return { kind: "chunk", taskId: parts[1], chunkId: parts[2] };
  }

  if (parts.length === 2 && parts[0] === "dispatch") {
    return { kind: "dispatch", runId: parts[1] };
  }

  if (parts.length === 2 && parts[0] === "session") {
    return { kind: "session", sessionId: parts[1] };
  }

  return { kind: "unknown", raw: hash };
}

function routeKey(route) {
  if (route.kind === "task") {
    return "task:" + route.taskId;
  }
  if (route.kind === "chunk") {
    return "chunk:" + route.taskId + "/" + route.chunkId;
  }
  if (route.kind === "dispatch") {
    return "dispatch:" + route.runId;
  }
  if (route.kind === "session") {
    return "session:" + route.sessionId;
  }
  return route.kind;
}

function routeTitle(route) {
  if (route.kind === "task") {
    return "Task " + route.taskId;
  }
  if (route.kind === "chunk") {
    return "Chunk " + route.taskId + "/" + route.chunkId;
  }
  if (route.kind === "dispatch") {
    return "Dispatch " + shortId(route.runId);
  }
  if (route.kind === "session") {
    return "Session " + shortId(route.sessionId);
  }
  return "Work Backlog";
}

function parseMaybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function renderSectionErrors() {
  for (const key of Object.keys(state.errors)) {
    const endpoint = endpoints[key];
    if (!endpoint) {
      continue;
    }
    const target = document.querySelector("[data-endpoint=\"" + endpoint + "\"] tbody, [data-endpoint=\"" + endpoint + "\"] .rows, [data-endpoint=\"" + endpoint + "\"] #cost-rows");
    if (target) {
      const isTable = target.tagName.toLowerCase() === "tbody";
      target.innerHTML = isTable ? tableState(readErrorText(state.errors[key]), 4, true) : panelState(readErrorText(state.errors[key]), true);
    }
  }
}

function renderStaleState() {
  if (state.loadedAt === null) {
    return;
  }
  if (Date.now() - state.loadedAt.getTime() <= STALE_AFTER_MS || Object.keys(state.errors).length > 0) {
    return;
  }
  setLoadState("Stale", "stale");
}

function populateFilterOptions() {
  setOptions("filter-task-status", "All task statuses", unique(getTasks().map((task) => task.status)));
  setOptions("filter-chunk-status", "All chunk statuses", unique(getChunks().map((chunk) => chunk.status)));
  setOptions("filter-stage", "All stages", unique(getChunks().map((chunk) => chunk.stage)));
  setOptions("filter-dispatch-status", "All dispatch statuses", unique(getDispatchRuns().map((run) => run.status)));
  setOptions("filter-tool", "All tools", unique(getDispatchRuns().flatMap((run) => [run.tool, array(run.attempts)[0]?.tool])));
}

function setOptions(id, label, values) {
  const element = byId(id);
  if (!element) {
    return;
  }
  const current = element.value || "all";
  element.innerHTML = "<option value=\"all\">" + esc(label) + "</option>" +
    values.map((value) => "<option value=\"" + esc(value) + "\">" + esc(value) + "</option>").join("");
  element.value = values.includes(current) ? current : "all";
  const filterKey = id.replace("filter-", "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  if (state.filters[filterKey] !== undefined) {
    state.filters[filterKey] = element.value;
  }
}

function matchesChunkFilters(chunk) {
  const readiness = getReadinessState(chunk);
  return matchesSearch([chunk.task.id, chunk.task.title, chunk.id, chunk.title, chunk.spec]) &&
    matchesValue(state.filters.taskStatus, chunk.task.status) &&
    matchesValue(state.filters.chunkStatus, chunk.status) &&
    matchesValue(state.filters.stage, chunk.stage) &&
    matchesValue(state.filters.readiness, readiness);
}

function matchesDispatchFilters(run) {
  const attempt = array(run.attempts)[0] || {};
  const tool = run.tool || attempt.tool;
  return matchesSearch([run.id, run.task_id, run.chunk_id, run.repo_name, tool, run.status]) &&
    matchesValue(state.filters.dispatchStatus, run.status) &&
    matchesValue(state.filters.tool, tool);
}

function matchesSessionSearch(session) {
  return matchesSearch([session.id, session.source, session.model, session.project_path, array(session.linked_chunks).map((link) => link.task_id + "/" + link.chunk_id).join(" ")]);
}

function matchesSearch(values) {
  const needle = state.filters.search.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return values.some((value) => String(value || "").toLowerCase().includes(needle));
}

function matchesValue(filterValue, value) {
  return filterValue === "all" || String(value || "") === filterValue;
}

function sortChunks(chunks) {
  return [...chunks].sort((left, right) => {
    if (state.sort.work === "ref") {
      return (left.task.id + "/" + left.id).localeCompare(right.task.id + "/" + right.id);
    }
    if (state.sort.work === "readiness") {
      return getReadinessState(left).localeCompare(getReadinessState(right));
    }
    return dateValue(right.updated_at || right.created_at) - dateValue(left.updated_at || left.created_at);
  });
}

function sortDispatchRuns(runs) {
  return [...runs].sort((left, right) => {
    if (state.sort.dispatch === "ref") {
      return String(left.id || "").localeCompare(String(right.id || ""));
    }
    return dateValue(right.updated_at || right.created_at) - dateValue(left.updated_at || left.created_at);
  });
}

function getTasks() {
  return array(state.data.tasks?.tasks);
}

function getChunks() {
  return getTasks().flatMap((task) => array(task.chunks).map((chunk) => ({ ...chunk, task })));
}

function getDispatchRuns() {
  return array(state.data.dispatchRuns?.dispatch_runs ?? state.data.dispatchRuns?.runs);
}

function getSessions() {
  return array(state.data.sessions?.sessions);
}

function getCost() {
  return state.data.costs?.cost || {};
}

function getReadiness(chunk) {
  return state.readiness.get(chunkKey(chunk)) || {
    state: state.readinessLoading ? "checking" : "unknown",
    message: state.readinessLoading ? "Checking" : "Unknown",
    blockers: []
  };
}

function getReadinessState(chunk) {
  return getReadiness(chunk).state;
}

function readinessFromPayload(payload) {
  const blockers = array(payload.blockers);
  return {
    state: payload.ready ? "ready" : "blocked",
    message: payload.ready ? "Dispatchable" : "Not dispatchable",
    blockers
  };
}

function readinessChip(readiness) {
  if (readiness.state === "ready") {
    return chip("dispatchable", "done");
  }
  if (readiness.state === "blocked") {
    return chip(readiness.message || "not dispatchable", "failed");
  }
  if (readiness.state === "error") {
    return chip("dispatch gate error", "failed");
  }
  if (readiness.state === "checking") {
    return chip("checking", "warn");
  }
  return chip("unknown", "muted");
}

function dispatchReadinessNote(openChunks, notDispatchableChunks) {
  if (openChunks.length === 0) {
    return "No open chunks";
  }
  if (notDispatchableChunks.length === 0) {
    return "All open chunks are dispatchable";
  }
  return notDispatchableChunks.length + " open chunk" + (notDispatchableChunks.length === 1 ? "" : "s") + " not dispatchable";
}

function dispatchGateChip(chunk, readiness) {
  const summary = dispatchGateSummary(chunk, readiness);
  return chip(summary.label, summary.tone);
}

function dispatchGateDetailMeta(chunk, readiness, blockers) {
  if (chunk.status === "done") {
    return "not applicable";
  }
  if (readiness.state === "ready") {
    return "dispatchable";
  }
  if (readiness.state === "checking") {
    return "checking";
  }
  if (readiness.state === "unknown") {
    return "unknown";
  }
  if (readiness.state === "error") {
    return "error";
  }
  return blockers.length + " unmet requirement" + (blockers.length === 1 ? "" : "s");
}

function dispatchGateSummary(chunk, readiness) {
  if (chunk.status === "done") {
    return {
      label: "not applicable",
      tone: "muted",
      note: "Chunk is done."
    };
  }

  if (readiness.state === "ready") {
    return {
      label: "dispatchable",
      tone: "done",
      note: "Ready for agent launch."
    };
  }

  if (readiness.state === "checking") {
    return { label: "checking", tone: "warn", note: "" };
  }

  if (readiness.state === "error") {
    return { label: "gate error", tone: "failed", note: readiness.message || "Dispatch gate check failed." };
  }

  if (readiness.state === "unknown") {
    return { label: "unknown", tone: "muted", note: "" };
  }

  const blockers = array(readiness.blockers);
  const actionable = blockers.filter((blocker) => blocker.code !== "missing_dispatch_metadata");
  if (actionable.length === 0 && blockers.some((blocker) => blocker.code === "missing_dispatch_metadata")) {
    return {
      label: "not configured",
      tone: "warn",
      note: "Dispatch gate metadata is missing."
    };
  }

  const first = actionable[0] || blockers[0];
  return {
    label: "not dispatchable",
    tone: "failed",
    note: first?.message || "Dispatch gate has unmet requirements."
  };
}

function chunkKey(chunk) {
  return chunk.task.id + "/" + chunk.id;
}

function endpointKey(path) {
  if (path.startsWith("/api/readiness/")) {
    return "readiness";
  }
  return Object.entries(endpoints).find(([, value]) => value === path)?.[0] || "unknown";
}

function tableState(message, colspan, isError = false) {
  return "<tr><td class=\"table-state" + (isError ? " state-error" : "") + "\" colspan=\"" + colspan + "\">" + esc(message) + "</td></tr>";
}

function panelState(message, isError = false) {
  return "<div class=\"panel-state" + (isError ? " state-error" : "") + "\">" + esc(message) + "</div>";
}

function chip(label, value) {
  const normalized = String(value || label || "").toLowerCase();
  const tone = normalized.includes("done") || normalized.includes("succeeded") || normalized.includes("ready") ? " chip-done" :
    normalized.includes("fail") || normalized.includes("blocked") ? " chip-failed" :
    normalized.includes("todo") || normalized.includes("plan") || normalized.includes("review") || normalized.includes("check") ? " chip-warn" :
    normalized.includes("muted") || normalized.includes("unknown") ? " chip-muted" :
    " chip-active";
  return "<span class=\"chip" + tone + "\">" + esc(label || "unknown") + "</span>";
}

function countByStatus(items) {
  const counts = items.reduce((acc, item) => {
    const key = item.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([key, value]) => value + " " + key).join(", ");
}

function lastEvent(run) {
  const event = array(run.events).at(-1);
  return event?.message || "";
}

function latestTime(session) {
  return session ? "Latest " + formatDate(session.ended_at || session.started_at) : "";
}

function readErrorText(error) {
  return readErrorMessage(error.body) || error.message || "Unable to load data";
}

function readErrorMessage(body) {
  return body && body.error && body.error.message ? body.error.message : "";
}

function readWriteErrorMessage(body) {
  const nestedMessage = body?.error?.details?.stderr_json?.error?.message;
  if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
    return nestedMessage;
  }

  const message = readErrorMessage(body);
  const code = body?.error?.code;
  if (message && typeof code === "string") {
    return message + " (" + code + ")";
  }

  return message;
}

function firstLine(value) {
  return String(value || "").split("\n").find((line) => line.trim().length > 0) || "";
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => value !== null && value !== undefined && String(value).length > 0).map(String))).sort();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) {
    element.textContent = value;
  }
}

function setHtml(id, value) {
  const element = byId(id);
  if (element) {
    element.innerHTML = value;
  }
}

function setLoadState(label, tone) {
  const element = byId("load-state");
  if (!element) {
    return;
  }
  element.textContent = label;
  element.className = "load-pill " + (
    tone === "ok" ? "load-pill-ok" :
    tone === "warn" ? "load-pill-warn" :
    tone === "stale" ? "load-pill-stale" :
    ""
  );
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 12 ? text.slice(0, 12) : text;
}

function dateValue(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateTime(value) {
  if (!value) {
    return "null";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatCost(value) {
  return money(Number(value || 0));
}

function money(value) {
  return "$" + value.toFixed(value > 0 && value < 0.01 ? 4 : 2);
}
