const STALE_AFTER_MS = 5 * 60 * 1000;

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
  const needsAttentionChunks = openChunks.filter((chunk) => getReadinessState(chunk) === "blocked");
  const failures = Object.keys(state.errors);

  setText("rail-tasks", String(tasks.length));
  setText("rail-open-chunks", String(openChunks.length));
  setText("rail-needs-attention", String(needsAttentionChunks.length));
  setText("rail-dispatch", String(dispatchRuns.length));
  setText("rail-sessions", String(sessions.length));
  setText("rail-cost", money(totalCost));

  setText("metric-tasks", String(tasks.length));
  setText("metric-tasks-note", countByStatus(tasks));
  setText("metric-open-chunks", String(openChunks.length));
  setText("metric-open-note", chunks.length + " total chunks");
  setText("metric-ready-chunks", String(readyDispatchChunks.length));
  setText("metric-ready-note", state.readinessLoading ? "Checking readiness" : dispatchReadinessNote(openChunks, needsAttentionChunks));
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
    const blockers = readiness.blockers.map((blocker) => blocker.message || blocker.code).filter(Boolean);
    const description = chunk.spec ? firstLine(chunk.spec) : chunk.title || "";
    return "<tr>" +
      "<td>" +
        "<div class=\"item-title\"><a class=\"item-id detail-link\" href=\"" + routeHref(["chunk", chunk.task.id, chunk.id]) + "\">" + esc(chunk.task.id + "/" + chunk.id) + "</a><span>" + esc(chunk.title || "Untitled chunk") + "</span></div>" +
        "<p class=\"item-copy\">" + esc(description) + "</p>" +
        (blockers.length > 0 ? "<p class=\"item-copy\">" + esc(blockers.slice(0, 2).join("; ")) + "</p>" : "") +
      "</td>" +
      "<td><div class=\"meta-line\">" + chip(chunk.task.status || "unknown", chunk.task.status) + chip(chunk.status || "unknown", chunk.status) + chip(chunk.stage || "stage unset", chunk.stage) + "</div></td>" +
      "<td>" + readinessChip(readiness) + "</td>" +
      "<td class=\"mono\">" + esc(formatDate(chunk.updated_at || chunk.created_at)) + "</td>" +
    "</tr>";
  }).join("");
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
    chip(data.chunk.status || "unknown", data.chunk.status) + chip(data.chunk.stage || "stage unset", data.chunk.stage) + readinessChip(data.readiness),
    linkToTask(data.task.id, data.task.title || data.task.id)
  ) +
    "<div class=\"detail-grid\">" +
      detailPanel("Chunk State", "", keyGrid([
        ["Full chunk ref", ref],
        ["Updated", formatDateTime(data.chunk.updated_at)],
        ["Created", formatDateTime(data.chunk.created_at)],
        ["Linked cost", money(Number(data.review?.total_cost_usd || 0))],
        ["Dispatch runs", dispatchRuns.length]
      ])) +
      detailPanel("Spec", "", preBlock(data.chunk.spec || "No spec."), "detail-panel-wide") +
      detailPanel("Readiness", blockers.length + " blockers", renderReadinessDetail(data.readiness, blockers, warnings)) +
      detailPanel("Open Questions", String(array(data.questions).filter((question) => question.status === "open").length), renderQuestionList(data.questions)) +
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

function renderTaskChunkTable(task, chunks, extras, review) {
  if (chunks.length === 0) {
    return panelState("No chunks found.");
  }

  return "<div class=\"table-scroll\"><table class=\"data-table detail-table\"><thead><tr><th>Chunk</th><th>Status</th><th>Readiness</th><th>Questions</th><th>Decisions</th><th>Sessions</th><th>Cost</th></tr></thead><tbody>" +
    chunks.map((chunk) => {
      const extra = extras.get(chunk.id) || { readiness: { state: "unknown", message: "Unknown", blockers: [] }, questions: [], decisions: [] };
      const rollup = taskReviewRollup(review, chunk.id);
      const openQuestions = array(extra.questions).filter((question) => question.status === "open").length;
      return "<tr>" +
        "<td><div class=\"item-title\">" + linkToChunk(task.id, chunk.id, task.id + "/" + chunk.id) + "<span>" + esc(chunk.title || "Untitled chunk") + "</span></div></td>" +
        "<td><div class=\"meta-line\">" + chip(chunk.status || "unknown", chunk.status) + chip(chunk.stage || "stage unset", chunk.stage) + "</div></td>" +
        "<td>" + readinessChip(extra.readiness) + "</td>" +
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

function renderQuestionList(questions) {
  const rows = array(questions);
  if (rows.length === 0) {
    return panelState("No questions.");
  }

  return rows.map((question) =>
    "<article class=\"row-card\">" +
      "<div>" +
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(question.id) + "</span><span>" + esc(question.status || "unknown") + "</span></div>" +
        "<p class=\"item-copy\">" + esc(question.body) + "</p>" +
        (question.answer ? "<p class=\"item-copy\">" + esc(question.answer) + "</p>" : "") +
      "</div>" +
      "<div class=\"chips\">" + chip(question.status || "unknown", question.status) + chip(formatDate(question.answered_at || question.asked_at), question.status) + "</div>" +
    "</article>"
  ).join("");
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

function renderReadinessDetail(readiness, blockers, warnings) {
  const blockerRows = blockers.map((blocker) => "<li><span class=\"item-id\">" + esc(blocker.code || "blocker") + "</span> " + esc(blocker.message || "") + "</li>");
  const warningRows = warnings.map((warning) => "<li><span class=\"item-id\">" + esc(warning.code || "warning") + "</span> " + esc(warning.message || "") + "</li>");
  return "<div class=\"detail-copy\">" +
    "<div class=\"chips\">" + readinessChip(readiness) + "</div>" +
    (blockerRows.length === 0 ? "<p class=\"item-copy\">No blockers.</p>" : "<ul class=\"detail-list\">" + blockerRows.join("") + "</ul>") +
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
    message: payload.ready ? "Ready" : blockers.length + " blocker" + (blockers.length === 1 ? "" : "s"),
    blockers
  };
}

function readinessChip(readiness) {
  if (readiness.state === "ready") {
    return chip("ready", "done");
  }
  if (readiness.state === "blocked") {
    return chip(readiness.message || "blocked", "failed");
  }
  if (readiness.state === "error") {
    return chip("readiness error", "failed");
  }
  if (readiness.state === "checking") {
    return chip("checking", "warn");
  }
  return chip("unknown", "muted");
}

function dispatchReadinessNote(openChunks, needsAttentionChunks) {
  if (openChunks.length === 0) {
    return "No open chunks";
  }
  return needsAttentionChunks.length + " need attention";
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
