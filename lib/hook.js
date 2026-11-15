"use strict";
// The Claude Code hook: what to write in the progress folder for each event Claude Code sends
// (its stdin JSON, see https://code.claude.com/docs/en/hooks). Pure functions, tested with
// `node --test`; bin/agent-progress.js reads stdin and writes the files.
//
// The hook only watches: it never changes a command and never answers a permission. It runs
// with "async": true, so Claude Code does not wait for it.
//   PreToolUse (Bash, PowerShell)  a card starts, "auto" (shown once it has lasted a while)
//   PostToolUse                    a command in the foreground is done
//   PostToolUseFailure             it failed, or was interrupted
//   Stop, SubagentStop             background commands no longer in Claude Code's list have ended
//   SessionEnd                     what still runs in that session has ended
// Claude Code does not say when a background command finishes, nor how: its cards end at the
// next Stop as "ended", unless the list gives a status.

const PREFIX = "claude-";
/** Stop's background_tasks gives each command's first 1000 characters. */
const COMMAND_CHARS = 1000;
const TOOLS = new Set(["Bash", "PowerShell"]);

/** The progress file id of a tool call. */
function idOf(toolUseId) {
  const clean = String(toolUseId || "").replace(/[^A-Za-z0-9._-]/g, "");
  return clean ? PREFIX + clean.slice(0, 90) : null;
}

/** The card's title: the description Claude gave the command, else its first line. */
function titleOf(input) {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description) return description.slice(0, 120);
  const first = String(input.command || "").trim().split(/\r?\n/)[0];
  return first.length > 80 ? `${first.slice(0, 79)}…` : first || "Command";
}

/** A command that shows itself through agent-progress: one card is enough. */
function reportsItself(command) {
  return /(^|[\s"'/\\&;(])agent-progress(\.cmd)?["']?\s+(run|set|done|fail)\b/.test(command);
}

/** "8 s", "2 min": how long it took. */
function took(ms, formatDuration) {
  return formatDuration(Math.max(0, ms) / 1000);
}

/** True when the tool's answer says the command went on in the background. */
function wentToBackground(response) {
  if (!response || typeof response !== "object") return false;
  return Object.entries(response).some(([key, value]) => /background/i.test(key) && Boolean(value));
}

/**
 * Whether an entry of Stop's background_tasks is this card's command. Same command (Claude Code
 * may cut it or wrap it), or else the same description.
 */
function sameTask(task, card) {
  if (!task || typeof task !== "object") return false;
  const ours = String(card.command || "").trim();
  const theirs = typeof task.command === "string" ? task.command.trim() : "";
  if (ours && theirs) {
    const head = ours.slice(0, 200);
    if (theirs === ours.slice(0, COMMAND_CHARS) || theirs.includes(head) || ours.includes(theirs)) return true;
  }
  return typeof task.description === "string" && task.description.trim() !== "" && task.description.trim() === card.title;
}

function firstLine(text, max = 160) {
  const line = String(text || "").trim().split(/\r?\n/)[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The files to write for one event. `now` is a Date; `existing` lists the cards already in the
 * folder that this hook wrote ({ id, data }). Returns [{ id, data, onlyIfNew }]: `data` is the
 * whole card (merged by the caller over what is there, unless `onlyIfNew`).
 */
function onEvent(event, now, existing, formatDuration) {
  if (!event || typeof event !== "object") return [];
  const at = now.toISOString();
  const kind = event.hook_event_name;
  const session = typeof event.session_id === "string" ? event.session_id : "";

  if (kind === "PreToolUse" || kind === "PostToolUse" || kind === "PostToolUseFailure") {
    if (!TOOLS.has(event.tool_name)) return [];
    const input = event.tool_input && typeof event.tool_input === "object" ? event.tool_input : {};
    const command = String(input.command || "");
    const id = idOf(event.tool_use_id);
    if (!id || !command.trim() || reportsItself(command)) return [];
    const before = existing.find((card) => card.id === id)?.data || {};
    const background = Boolean(input.run_in_background) || wentToBackground(event.tool_response);
    const ms = typeof event.duration_ms === "number" ? event.duration_ms : null;
    // A card that the PreToolUse hook has not written yet (both run at once): the end gives it all.
    const base = {
      title: titleOf(input),
      started: before.started || (ms !== null ? new Date(now.getTime() - ms).toISOString() : at),
      state: "running",
      auto: true,
      heartbeat: false,
      source: "Claude Code",
      session,
      command: command.slice(0, COMMAND_CHARS),
      background,
      detail: background ? "in the background" : "",
    };
    if (kind === "PreToolUse") return [{ id, data: { ...base, updated: at }, onlyIfNew: true }];
    const startedMs = Date.parse(base.started);
    const length = ms !== null ? ms : now.getTime() - startedMs;
    if (kind === "PostToolUse") {
      if (background) return [{ id, data: { ...base, ...before, background: true, detail: "in the background", updated: at } }];
      const interrupted = Boolean(event.tool_response && event.tool_response.interrupted);
      const end = interrupted
        ? { state: "failed", detail: `interrupted after ${took(length, formatDuration)}` }
        : { state: "done", detail: `finished in ${took(length, formatDuration)}` };
      return [{ id, data: { ...base, ...before, ...end, updated: at } }];
    }
    const why = event.is_interrupt ? "interrupted" : firstLine(event.error) || "failed";
    return [{ id, data: { ...base, ...before, state: "failed", detail: why, updated: at } }];
  }

  const mine = existing.filter((card) => card.data.session === session && card.data.state === "running");
  if (kind === "Stop" || kind === "SubagentStop") {
    const list = event.background_tasks;
    const writes = [];
    for (const card of mine) {
      // A turn is over: nothing of it runs in the foreground any more.
      if (!card.data.background) {
        writes.push({ id: card.id, data: { ...card.data, state: "ended", detail: "ended", updated: at } });
        continue;
      }
      // Without the list (Claude Code could not read it), nothing can be told.
      if (!Array.isArray(list)) continue;
      const entry = list.find((task) => sameTask(task, card.data));
      const status = entry && typeof entry.status === "string" ? entry.status.toLowerCase() : "";
      if (entry && (status === "" || /run|pend|start|progress/.test(status))) continue;
      let end = { state: "ended", detail: "ended, Claude Code does not say how" };
      if (/complet|success|succeed|done/.test(status)) end = { state: "done", detail: status };
      else if (/fail|error/.test(status)) end = { state: "failed", detail: status };
      else if (/kill|stop|cancel/.test(status)) end = { state: "failed", detail: `stopped (${status})` };
      writes.push({ id: card.id, data: { ...card.data, ...end, updated: at } });
    }
    return writes;
  }
  if (kind === "SessionEnd") {
    return mine.map((card) => ({
      id: card.id,
      data: { ...card.data, state: "ended", detail: "the Claude Code session ended", updated: at },
    }));
  }
  return [];
}

module.exports = { PREFIX, COMMAND_CHARS, idOf, titleOf, reportsItself, sameTask, onEvent };
