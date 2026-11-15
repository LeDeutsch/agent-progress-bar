"use strict";
// The agents' hooks: what to write in the progress folder for each event an AI coding tool sends
// on stdin when it runs a shell command. Pure functions, tested with `node --test`;
// bin/agent-progress.js reads stdin and writes the files (`agent-progress hook <tool> [event]`).
//
// A hook only watches: it never changes a command, never answers a permission, prints nothing
// (or the empty answer a tool requires), and always exits 0. Each tool's events become the same
// few steps (normalize), and the same steps write the same cards (onEvent):
//   start    a card starts, "auto": shown once it has lasted a while
//   end      a command in the foreground is done (or failed, when the tool says so)
//   fail     it failed, or was interrupted
//   turn     the agent's turn is over: what still runs in the foreground has ended; Claude Code
//            also lists its background commands, and the ones no longer listed have ended
//   session  the session is over: what still runs in it has ended
//
// Claude Code   https://code.claude.com/docs/en/hooks           (tool_use_id pairs start and end)
// Codex         https://learn.chatgpt.com/docs/hooks            (tool_use_id; its end can come
//               after the turn, when a long command finishes, so a turn ends nothing)
// GitHub Copilot https://docs.github.com/copilot/reference/hooks-reference (no id: a command is
//               found again by its session and command line; the event comes as an argument)
// Gemini CLI    https://geminicli.com/docs/hooks/reference/     (no id, as Copilot)

const crypto = require("crypto");

/** Stop's background_tasks gives each command's first 1000 characters. */
const COMMAND_CHARS = 1000;

/** The tools the hook knows: the name on the cards, and the prefix of their files. */
const AGENTS = {
  claude: { name: "Claude Code", prefix: "claude-" },
  codex: { name: "Codex", prefix: "codex-" },
  copilot: { name: "GitHub Copilot", prefix: "copilot-" },
  gemini: { name: "Gemini CLI", prefix: "gemini-" },
};
const PREFIX = AGENTS.claude.prefix;

function clean(text, max = 90) {
  return String(text || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, max);
}

/** The progress file id of a tool call (Claude Code's by default). */
function idOf(toolUseId, tool = "claude") {
  const id = clean(toolUseId);
  return id ? AGENTS[tool].prefix + id : null;
}

/** The card's title: the description the agent gave the command, else its first line. */
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

/** An object, from an object or a JSON string (Copilot may send its arguments either way). */
function objectOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** The command line, given as a string or as a list of words. */
function commandOf(input) {
  if (Array.isArray(input.command)) return input.command.map(String).join(" ");
  return typeof input.command === "string" ? input.command : "";
}

/** An exit code the tool reports in its answer, when it gives one. */
function exitCodeOf(response) {
  const value = objectOf(response);
  for (const key of ["exit_code", "exitCode", "returncode"]) if (typeof value[key] === "number") return value[key];
  return null;
}

/**
 * One event of a tool, as a step: { step, session, callId, input, background, ms, failed,
 * detail, list }. Null when the hook has nothing to do with it (another tool, an empty command).
 */
function normalize(tool, event, eventName) {
  const name = event.hook_event_name || eventName || "";
  if (tool === "claude") {
    const session = typeof event.session_id === "string" ? event.session_id : "";
    if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(name)) {
      if (!["Bash", "PowerShell"].includes(event.tool_name)) return null;
      const input = objectOf(event.tool_input);
      const background = Boolean(input.run_in_background) || wentToBackground(event.tool_response);
      const ms = typeof event.duration_ms === "number" ? event.duration_ms : null;
      const base = { session, callId: event.tool_use_id, input, background, ms };
      if (name === "PreToolUse") return { ...base, step: "start" };
      if (name === "PostToolUse") return { ...base, step: "end", failed: Boolean(event.tool_response && event.tool_response.interrupted) && "interrupted" };
      return { ...base, step: "fail", detail: event.is_interrupt ? "interrupted" : firstLine(event.error) || "failed" };
    }
    if (name === "Stop" || name === "SubagentStop") return { step: "turn", session, list: event.background_tasks, endsForeground: true };
    if (name === "SessionEnd") return { step: "session", session };
    return null;
  }
  if (tool === "codex") {
    const session = typeof event.session_id === "string" ? event.session_id : "";
    if (name === "PreToolUse" || name === "PostToolUse") {
      if (event.tool_name !== "Bash") return null;
      const base = { session, callId: event.tool_use_id, input: objectOf(event.tool_input), background: false, ms: null };
      if (name === "PreToolUse") return { ...base, step: "start" };
      const code = exitCodeOf(event.tool_response);
      return { ...base, step: "end", failed: code !== null && code !== 0 && `exit code ${code}` };
    }
    // A long command's end can come after the turn: only the end of the session ends it.
    if (name === "SessionEnd") return { step: "session", session };
    return null;
  }
  if (tool === "copilot") {
    const session = String(event.sessionId || event.session_id || "");
    const toolName = String(event.toolName || event.tool_name || "").toLowerCase();
    if (["preToolUse", "postToolUse", "postToolUseFailure"].includes(name)) {
      if (toolName !== "bash" && toolName !== "powershell") return null;
      const base = { session, input: objectOf(event.toolArgs ?? event.tool_input), background: false, ms: null };
      if (name === "preToolUse") return { ...base, step: "start" };
      if (name === "postToolUse") return { ...base, step: "end" };
      return { ...base, step: "fail", detail: firstLine(event.error) || "failed" };
    }
    if (name === "agentStop") return { step: "turn", session, endsForeground: true };
    if (name === "sessionEnd") return { step: "session", session };
    return null;
  }
  if (tool === "gemini") {
    const session = typeof event.session_id === "string" ? event.session_id : "";
    if (name === "BeforeTool" || name === "AfterTool") {
      if (event.tool_name !== "run_shell_command") return null;
      const input = objectOf(event.tool_input);
      const base = { session, input, background: Boolean(input.is_background), ms: null };
      if (name === "BeforeTool") return { ...base, step: "start" };
      const response = objectOf(event.tool_response);
      const error = response.error ? firstLine(typeof response.error === "string" ? response.error : response.error.message) || "failed" : "";
      return { ...base, step: error ? "fail" : "end", detail: error };
    }
    if (name === "AfterAgent") return { step: "turn", session, endsForeground: true };
    if (name === "SessionEnd") return { step: "session", session };
    return null;
  }
  return null;
}

/** For a tool without a call id: the same command of the same session finds its card again. */
function keyOf(session, command) {
  return crypto.createHash("sha1").update(`${session}\n${command}`).digest("hex").slice(0, 12);
}

/**
 * The files to write for one event of `tool` ("claude" by default). `now` is a Date; `existing`
 * lists the cards of that tool already in the folder ({ id, data }); `eventName` is the event
 * when the tool does not put it in the event (Copilot). Returns [{ id, data, onlyIfNew }]: `data`
 * is the whole card (merged by the caller over what is there, unless `onlyIfNew`).
 */
function onEvent(event, now, existing, formatDuration, tool = "claude", eventName = undefined) {
  if (!event || typeof event !== "object" || !AGENTS[tool]) return [];
  const step = normalize(tool, event, eventName);
  if (!step) return [];
  const at = now.toISOString();
  const { name: source, prefix } = AGENTS[tool];

  if (step.step === "start" || step.step === "end" || step.step === "fail") {
    const command = commandOf(step.input);
    if (!command.trim() || reportsItself(command)) return [];
    const key = step.callId ? null : keyOf(step.session, command);
    let id;
    let before = {};
    if (step.callId) {
      id = idOf(step.callId, tool);
      if (!id) return [];
      before = existing.find((card) => card.id === id)?.data || {};
    } else if (step.step === "start") {
      id = `${prefix}${key}-${now.getTime().toString(36)}`;
    } else {
      // The oldest card of this command still running: the end of the command that started first.
      const card = existing
        .filter((c) => c.data.key === key && c.data.state === "running")
        .sort((a, b) => Date.parse(a.data.started) - Date.parse(b.data.started))[0];
      if (!card) return [];
      id = card.id;
      before = card.data;
    }
    const base = {
      title: titleOf({ ...step.input, command }),
      // A card that the start has not written yet (both hooks run at once): the end gives it all.
      started: before.started || (step.ms !== null ? new Date(now.getTime() - step.ms).toISOString() : at),
      state: "running",
      auto: true,
      heartbeat: false,
      source,
      session: step.session,
      command: command.slice(0, COMMAND_CHARS),
      ...(key ? { key } : {}),
      background: step.background,
      detail: step.background ? "in the background" : "",
    };
    if (step.step === "start") return [{ id, data: { ...base, updated: at }, onlyIfNew: true }];
    const length = step.ms !== null ? step.ms : now.getTime() - Date.parse(base.started);
    const took = formatDuration(Math.max(0, length) / 1000);
    if (step.step === "fail") return [{ id, data: { ...base, ...before, state: "failed", detail: step.detail, updated: at } }];
    if (step.background) return [{ id, data: { ...base, ...before, background: true, detail: "in the background", updated: at } }];
    const end = step.failed
      ? { state: "failed", detail: step.failed === "interrupted" ? `interrupted after ${took}` : step.failed }
      : { state: "done", detail: `finished in ${took}` };
    return [{ id, data: { ...base, ...before, ...end, updated: at } }];
  }

  const mine = existing.filter((card) => card.data.session === step.session && card.data.state === "running");
  if (step.step === "turn") {
    const writes = [];
    for (const card of mine) {
      // A turn is over: nothing of it runs in the foreground any more.
      if (!card.data.background) {
        if (step.endsForeground) writes.push({ id: card.id, data: { ...card.data, state: "ended", detail: "ended", updated: at } });
        continue;
      }
      // Without the list (the tool could not read it, or has none), nothing can be told.
      if (!Array.isArray(step.list)) continue;
      const entry = step.list.find((task) => sameTask(task, card.data));
      const status = entry && typeof entry.status === "string" ? entry.status.toLowerCase() : "";
      if (entry && (status === "" || /run|pend|start|progress/.test(status))) continue;
      let end = { state: "ended", detail: `ended, ${source} does not say how` };
      if (/complet|success|succeed|done/.test(status)) end = { state: "done", detail: status };
      else if (/fail|error/.test(status)) end = { state: "failed", detail: status };
      else if (/kill|stop|cancel/.test(status)) end = { state: "failed", detail: `stopped (${status})` };
      writes.push({ id: card.id, data: { ...card.data, ...end, updated: at } });
    }
    return writes;
  }
  if (step.step === "session") {
    return mine.map((card) => ({
      id: card.id,
      data: { ...card.data, state: "ended", detail: `the ${source} session ended`, updated: at },
    }));
  }
  return [];
}

module.exports = { AGENTS, PREFIX, COMMAND_CHARS, idOf, titleOf, reportsItself, sameTask, keyOf, normalize, onEvent };
