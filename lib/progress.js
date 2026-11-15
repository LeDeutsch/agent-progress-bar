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

/**
 * Seconds left, or null when it cannot be told. An `eta_seconds` given by the writer wins
 * (counted down since the last update); otherwise the pace so far gives the estimate.
 */
function remainingSeconds(task, now) {
  if (task.state !== "running") return 0;
  if (task.eta !== null) return Math.max(0, task.eta - (now - task.updated) / 1000);
  const percent = percentOf(task);
  if (task.started === null || percent === null || percent <= 0) return null;
  const elapsed = (now - task.started) / 1000;
  if (elapsed <= 0) return null;
  return (elapsed * (100 - percent)) / percent;
}

/** "under a minute", "12 min", "1 h 05 min". */
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "";
  if (seconds < 60) return "under a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** A running task that has not been updated for a while: maybe stuck. */
function isStale(task, now, staleMinutes) {
  return task.state === "running" && now - task.updated > staleMinutes * 60000;
}

/** What the panel shows for one task. */
function view(task, now, staleMinutes) {
  const percent = percentOf(task);
  const left = remainingSeconds(task, now);
  let count = "";
  if (task.done !== null && task.total !== null) {
    count = `${task.done.toLocaleString("en-US")} / ${task.total.toLocaleString("en-US")}`;
    if (task.unit) count += ` ${task.unit}`;
  }
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    stale: isStale(task, now, staleMinutes),
    percent: percent === null ? null : Math.floor(percent),
    count,
    left: task.state === "running" && left !== null ? `${formatDuration(left)} left` : "",
    detail: task.detail,
    updatedAgo: formatDuration(Math.max(0, (now - task.updated) / 1000)),
  };
}

/** The status bar text, or "" to hide it. Running tasks first, oldest first. */
function statusText(tasks, now) {
  const running = tasks.filter((t) => t.state === "running").sort((a, b) => (a.started ?? a.updated) - (b.started ?? b.updated));
  if (running.length) {
    const first = running[0];
    const percent = percentOf(first);
    const left = remainingSeconds(first, now);
    let text = `$(sync~spin) ${first.title}`;
    if (percent !== null) text += ` ${Math.floor(percent)}%`;
    if (left !== null) text += ` · ${formatDuration(left)} left`;
    if (running.length > 1) text += ` (+${running.length - 1})`;
    return text;
  }
  const failed = tasks.find((t) => t.state === "failed");
  if (failed) return `$(error) ${failed.title} failed`;
  const done = tasks.find((t) => t.state === "done");
  if (done) return `$(check) ${done.title} done`;
  return "";
}

module.exports = { parseTask, percentOf, remainingSeconds, formatDuration, isStale, view, statusText };
