"use strict";
// Pure logic: turns progress files into what the status bar and the panel show.
// No VS Code API here, so it is tested with plain `node --test`.

const STATES = new Set(["running", "done", "failed"]);

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function time(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Reads one progress file. `id` is the file name without `.json`, `mtime` the file's
 * modification time (ms), used when the file has no `updated` field.
 * Returns null when the text is not a valid progress object.
 */
function parseTask(id, text, mtime) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = STATES.has(raw.state) ? raw.state : "running";
  return {
    id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
    state,
    done: number(raw.done),
    total: number(raw.total),
    percent: number(raw.percent),
    unit: typeof raw.unit === "string" ? raw.unit : "",
    detail: typeof raw.detail === "string" ? raw.detail : "",
    started: time(raw.started),
    updated: time(raw.updated) ?? mtime,
    eta: number(raw.eta_seconds),
    log: typeof raw.log === "string" ? raw.log.trim() : "",
    // Filled by the extension: { at, percent } readings of this task over time.
    samples: [],
  };
}

/** Progress from 0 to 100, or null when unknown. */
function percentOf(task) {
  if (task.state === "done") return 100;
  let value = null;
  if (task.percent !== null) value = task.percent;
  else if (task.done !== null && task.total !== null && task.total > 0) value = (100 * task.done) / task.total;
  return value === null ? null : Math.min(100, Math.max(0, value));
}

/** The time left is estimated from the speed over this last stretch, when there is one. */
const RECENT_MS = 3 * 60000;
/** Readings older than this are dropped. */
const KEEP_MS = 2 * RECENT_MS;

/**
 * Adds a reading of `task` to its earlier ones (one per file update) and returns the list,
 * without readings that are too old to matter.
 */
function addSample(samples, task, now) {
  const percent = percentOf(task);
  const kept = samples.filter((s) => now - s.at <= KEEP_MS);
  if (percent === null || task.state !== "running") return kept;
  const last = kept[kept.length - 1];
  if (last && last.at === task.updated) return kept;
  if (last && percent < last.percent) return [{ at: task.updated, percent }]; // restarted
  return [...kept, { at: task.updated, percent }];
}

/** Percent per second over the last few minutes, or null when there is too little to tell. */
function recentPace(samples, now) {
  const recent = samples.filter((s) => now - s.at <= RECENT_MS);
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = (last.at - first.at) / 1000;
  if (span < 20 || last.percent <= first.percent) return null;
  return (last.percent - first.percent) / span;
}

/**
 * Seconds left and where the estimate comes from ("task", "recent", "start"), or seconds null
 * when it cannot be told. An `eta_seconds` given by the writer wins (counted down since the last
 * update); then the speed over the last few minutes, which follows a task that speeds up or slows
 * down; then the pace since the start.
 */
function estimate(task, now) {
  if (task.state !== "running") return { seconds: 0, source: "" };
  if (task.eta !== null) return { seconds: Math.max(0, task.eta - (now - task.updated) / 1000), source: "task" };
  const percent = percentOf(task);
  if (percent === null) return { seconds: null, source: "" };
  const pace = recentPace(task.samples || [], now);
  if (pace !== null) {
    const fromLast = (100 - percent) / pace - (now - task.updated) / 1000;
    return { seconds: Math.max(0, fromLast), source: "recent" };
  }
  if (task.started === null || percent <= 0) return { seconds: null, source: "" };
  const elapsed = (now - task.started) / 1000;
  if (elapsed <= 0) return { seconds: null, source: "" };
  return { seconds: (elapsed * (100 - percent)) / percent, source: "start" };
}

/** Seconds left, or null when it cannot be told. */
function remainingSeconds(task, now) {
  return estimate(task, now).seconds;
}

/** "8 s", "45 s", "12 min", "1 h 05 min". */
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 10) return `${Math.max(1, Math.round(seconds))} s`;
  const rounded = Math.round(seconds / 5) * 5;
  if (rounded < 60) return `${rounded} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A running task that has not been updated for a while: maybe stuck. */
function isStale(task, now, staleMinutes) {
  return task.state === "running" && now - task.updated > staleMinutes * 60000;
}

/** "running", "stalled", "done" or "failed": what the panel colors a task by. */
function kindOf(task, now, staleMinutes) {
  if (task.state === "running") return isStale(task, now, staleMinutes) ? "stalled" : "running";
  return task.state;
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What the panel shows for one task. */
function view(task, now, staleMinutes) {
  const percent = percentOf(task);
  const kind = kindOf(task, now, staleMinutes);
  const { seconds: left, source } = estimate(task, now);
  const ago = formatDuration(Math.max(0, (now - task.updated) / 1000));
  let count = "";
  if (task.done !== null && task.total !== null) {
    count = `${task.done.toLocaleString("en-US")} / ${task.total.toLocaleString("en-US")}`;
    if (task.unit) count += ` ${task.unit}`;
  }
  let when = "";
  let whenHint = "";
  if (kind === "running" && task.started !== null) {
    when = `running for ${formatDuration(Math.max(0, (now - task.started) / 1000))}`;
    whenHint = `Started at ${clock(task.started)}`;
  } else if (kind === "done" || kind === "failed") {
    when = `${ago} ago`;
    if (task.started !== null) whenHint = `Took ${formatDuration(Math.max(0, (task.updated - task.started) / 1000))}`;
  }
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    kind,
    stale: kind === "stalled",
    percent: percent === null ? null : Math.floor(percent),
    count,
    // A stalled task's time left means nothing: the panel says "no news" instead.
    left: kind === "running" && left !== null ? `${formatDuration(left)} left` : "",
    leftHint: LEFT_HINTS[source] || "",
    detail: task.detail,
    note: kind === "stalled" ? `no news for ${ago}` : task.detail,
    when,
    whenHint,
    updatedAgo: ago,
    hasLog: task.log !== "",
    // A running task would come back on its next update: only the others can be removed.
    removable: kind !== "running",
  };
}

const LEFT_HINTS = {
  task: "Estimated by the task",
  recent: "From the speed over the last 3 minutes",
  start: "From the pace since the start",
};

const ORDER = { running: 0, stalled: 1, failed: 2, done: 3 };

/** Panel order: moving tasks (oldest first), then stalled, failed, and done (latest first). */
function panelOrder(tasks, now, staleMinutes) {
  return [...tasks].sort((a, b) => {
    const ka = ORDER[kindOf(a, now, staleMinutes)];
    const kb = ORDER[kindOf(b, now, staleMinutes)];
    if (ka !== kb) return ka - kb;
    if (ka >= ORDER.failed) return b.updated - a.updated;
    return (a.started ?? a.updated) - (b.started ?? b.updated);
  });
}

/** "2 running · 1 done" above the list, or "" when there is only one task. */
function summaryText(tasks, now, staleMinutes) {
  if (tasks.length < 2) return "";
  const counts = { running: 0, stalled: 0, failed: 0, done: 0 };
  for (const task of tasks) counts[kindOf(task, now, staleMinutes)] += 1;
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");
}

/**
 * The status bar text, or "" to hide it. Tasks that are moving come first, oldest first; a
 * stalled task only shows when nothing else runs.
 */
function statusText(tasks, now, staleMinutes = 10) {
  const running = tasks.filter((t) => t.state === "running").sort((a, b) => (a.started ?? a.updated) - (b.started ?? b.updated));
  const others = running.length > 1 ? ` (+${running.length - 1})` : "";
  const moving = running.filter((t) => !isStale(t, now, staleMinutes));
  if (moving.length) {
    const first = moving[0];
    const percent = percentOf(first);
    const left = remainingSeconds(first, now);
    let text = `$(sync~spin) ${first.title}`;
    if (percent !== null) text += ` ${Math.floor(percent)}%`;
    if (left !== null) text += ` · ${formatDuration(left)} left`;
    return text + others;
  }
  if (running.length) {
    const first = running[0];
    return `$(warning) ${first.title}: no news for ${formatDuration((now - first.updated) / 1000)}${others}`;
  }
  const failed = tasks.find((t) => t.state === "failed");
  if (failed) return `$(error) ${failed.title} failed`;
  const done = tasks.find((t) => t.state === "done");
  if (done) return `$(check) ${done.title} done`;
  return "";
}

module.exports = {
  parseTask,
  percentOf,
  addSample,
  recentPace,
  estimate,
  remainingSeconds,
  formatDuration,
  isStale,
  kindOf,
  view,
  panelOrder,
  summaryText,
  statusText,
};
