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
  element?.addEventListener("input", () => {
    state.filters[key] = element.value;
    render();
  });
}

async function loadForemanData() {
  setLoadState("Loading", "loading");
  state.errors = {};
  state.readiness = new Map();
  state.readinessLoading = false;
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

  if (key === "dispatchRuns" && !Array.isArray(body.dispatch_runs) && !Array.isArray(body.runs)) {
    throw payloadError(key, "Malformed dispatch response: expected dispatch_runs array.");
  }

  if (key === "sessions" && !Array.isArray(body.sessions)) {
    throw payloadError(key, "Malformed sessions response: expected sessions array.");
  }

  if (key === "costs" && (!body.cost || typeof body.cost !== "object")) {
    throw payloadError(key, "Malformed costs response: expected cost object.");
  }

  if (key === "readiness" && typeof body.ready !== "boolean") {
    throw payloadError(key, "Malformed readiness response: expected ready boolean.");
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
  const blockedChunks = chunks.filter((chunk) => getReadinessState(chunk) === "blocked");
  const failures = Object.keys(state.errors);

  setText("rail-tasks", String(tasks.length));
  setText("rail-open-chunks", String(openChunks.length));
  setText("rail-blocked-chunks", String(blockedChunks.length));
  setText("rail-dispatch", String(dispatchRuns.length));
  setText("rail-sessions", String(sessions.length));
  setText("rail-cost", money(totalCost));

  setText("metric-tasks", String(tasks.length));
  setText("metric-tasks-note", countByStatus(tasks));
  setText("metric-open-chunks", String(openChunks.length));
  setText("metric-open-note", chunks.length + " total chunks");
  setText("metric-blocked-chunks", String(blockedChunks.length));
  setText("metric-blocked-note", state.readinessLoading ? "Checking readiness" : readyCount(chunks) + " ready chunks");
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
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(chunk.task.id + "/" + chunk.id) + "</span><span>" + esc(chunk.title || "Untitled chunk") + "</span></div>" +
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
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(shortId(run.id)) + "</span><span>" + esc(title) + "</span></div>" +
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
        "<div class=\"item-title\"><span class=\"item-id\">" + esc(shortId(session.id)) + "</span><span>" + esc(title || "Session") + "</span></div>" +
        "<p class=\"item-copy\">" + esc(linked || session.project_path || "Unlinked") + "</p>" +
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

function readyCount(chunks) {
  return chunks.filter((chunk) => getReadinessState(chunk) === "ready").length;
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

function formatCost(value) {
  return money(Number(value || 0));
}

function money(value) {
  return "$" + value.toFixed(value > 0 && value < 0.01 ? 4 : 2);
}
