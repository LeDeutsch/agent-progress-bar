"use strict";
// Connecting Claude Code: the hooks added to its settings (~/.claude/settings.json), so the
// commands it runs show in the panel on their own (lib/hook.js). Pure functions, tested with
// `node --test`; the extension shows the change and writes it only once the user agrees.

const path = require("path");

/** The events the hook listens to, with the tools it watches. */
const EVENTS = [
  ["PreToolUse", "Bash|PowerShell"],
  ["PostToolUse", "Bash|PowerShell"],
  ["PostToolUseFailure", "Bash|PowerShell"],
  ["Stop", null],
  ["SubagentStop", null],
  ["SessionEnd", null],
];

/**
 * How Claude Code calls the hook: the launcher in `<progress folder>/bin`. Claude Code runs hook
 * commands with Git Bash on Windows when it is installed, else with PowerShell.
 */
function hookCall({ bin, windows, bash }) {
  if (windows && !bash) return { command: `& "${bin}\\agent-progress.cmd" hook`, shell: "powershell" };
  return { command: `"${windows ? bin.replace(/\\/g, "/") : bin}/agent-progress" hook` };
}

/** The launcher called as a hook: `... agent-progress hook`, `... agent-progress.cmd hook codex`. */
const OUR_CALL = /agent-progress(\.cmd)?"?\s+hook(\s|;|$)/;
/** The fields of a hook entry that hold a command, across the tools. */
const COMMAND_FIELDS = ["command", "commandWindows", "command_windows", "bash", "powershell"];

/** A hook this extension added. */
function isOurs(hook) {
  return Boolean(hook) && typeof hook === "object" && COMMAND_FIELDS.some((field) => typeof hook[field] === "string" && OUR_CALL.test(hook[field]));
}

/** Whether a parsed settings value holds one of this extension's hooks, anywhere in it. */
function hasOurs(value) {
  if (Array.isArray(value)) return value.some(hasOurs);
  if (!value || typeof value !== "object") return false;
  return isOurs(value) || Object.values(value).some(hasOurs);
}

/** The settings as an object. Throws when the file is not a plain JSON object. */
function parse(text) {
  const clean = String(text).replace(/^﻿/, "");
  if (!clean.trim()) return {};
  const value = JSON.parse(clean);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value;
}

/** The settings without this extension's hooks; a group or an event left empty goes too. */
function withoutOurs(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return settings;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const others = group.hooks.filter((hook) => !isOurs(hook));
      if (others.length === group.hooks.length) kept.push(group);
      else if (others.length) kept.push({ ...group, hooks: others });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  return settings;
}

/** Written like Claude Code writes it (two spaces), with the file's own line endings. */
function format(settings, original) {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  return String(original).includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * A settings text with this extension's hooks added (or brought up to date) in the layout Claude
 * Code, Codex and Gemini CLI share: hooks -> event -> [{ matcher, hooks: [hook] }]. `events` lists
 * [event, matcher or null]; `makeHook(event)` gives the hook. Throws on a broken file.
 */
function mergeHooks(text, events, makeHook) {
  const settings = withoutOurs(parse(text));
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const [event, matcher] of events) {
    const hook = makeHook(event);
    const group = matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = [...groups, group];
  }
  return format(settings, text);
}

/** Claude Code's settings text with the hooks added (or brought up to date). Throws on a broken file. */
function connect(text, call) {
  return mergeHooks(text, EVENTS, () => ({ type: "command", command: call.command, ...(call.shell ? { shell: call.shell } : {}), async: true, timeout: 30 }));
}

/** The settings text without the hooks. Throws on a broken file. */
function disconnect(text) {
  return format(withoutOurs(parse(text)), text);
}

/** Whether the settings have this extension's hooks. */
function isConnected(text) {
  try {
    const hooks = parse(text).hooks || {};
    return Object.values(hooks).some(
      (groups) => Array.isArray(groups) && groups.some((group) => group && Array.isArray(group.hooks) && group.hooks.some(isOurs)),
    );
  } catch {
    return false;
  }
}

/**
 * Whether Claude Code finds Git Bash on Windows (then it runs hooks with it): its own variable,
 * the usual install folders, or next to git on the PATH. `exists` checks a file.
 */
function hasGitBash(env, exists) {
  const candidates = [];
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")]) {
    if (base) candidates.push(path.win32.join(base, "Git", "bin", "bash.exe"));
  }
  for (const dir of String(env.PATH || env.Path || "").split(";")) {
    if (dir && /git[\\/](cmd|bin)[\\/]?$/i.test(dir)) candidates.push(path.win32.join(dir, "..", "bin", "bash.exe"));
  }
  return candidates.some((file) => exists(file));
}

/** "le•••@gmail.com": enough to recognize an address, not enough to read it over a shoulder. */
function maskEmail(email) {
  const at = String(email || "").lastIndexOf("@");
  if (at < 1) return "";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

/**
 * The account Claude Code is signed in with, from its own file (~/.claude.json): the name it
 * shows and the address, masked. Null when there is none or the file cannot be read.
 */
function account(text) {
  try {
    const signedIn = parse(text).oauthAccount;
    if (!signedIn || typeof signedIn !== "object") return null;
    const name = [signedIn.displayName, signedIn.fullName].find((v) => typeof v === "string" && v.trim()) || "";
    const email = typeof signedIn.emailAddress === "string" ? maskEmail(signedIn.emailAddress) : "";
    return name || email ? { name: name.trim(), email } : null;
  } catch {
    return null;
  }
}

/** The shell that runs the hooks: the one written in the settings, else the one Connect would pick. */
function shellName(settingsText, { windows, bash }) {
  try {
    for (const groups of Object.values(parse(settingsText).hooks || {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        const hook = group && Array.isArray(group.hooks) ? group.hooks.find(isOurs) : null;
        if (hook) return hook.shell === "powershell" ? "PowerShell" : windows ? "Git Bash" : "bash";
      }
    }
  } catch {
    // Unreadable: say what Connect would pick.
  }
  if (!windows) return "bash";
  return bash ? "Git Bash" : "PowerShell";
}

/**
 * What the Connections page shows for Claude Code. `state`: "connected", "available" or
 * "missing"; `stats`: { seen, shown, last: { title, at } } for today.
 */
function connectionView({ state, account: who, stats, shell, now, formatDuration }) {
  const lines = [];
  if (state === "connected") {
    const seen = stats ? stats.seen : 0;
    lines.push([`${seen} ${seen === 1 ? "command" : "commands"} seen today`, `${stats ? stats.shown : 0} shown`]);
    if (stats && stats.last) lines.push([`Last: ${stats.last.title}, ${formatDuration(Math.max(0, now - stats.last.at) / 1000)} ago`]);
  } else {
    lines.push([state === "available" ? "Found on this computer" : "Not found on this computer"]);
  }
  return {
    id: "claude",
    name: "Claude Code",
    state,
    who: who ? [who.name, who.email].filter(Boolean).join(" · ") : "",
    lines,
    hooks: state === "connected",
    shell: state === "missing" ? "" : shell,
  };
}

module.exports = {
  EVENTS,
  hookCall,
  isOurs,
  hasOurs,
  parse,
  format,
  withoutOurs,
  mergeHooks,
  connect,
  disconnect,
  isConnected,
  hasGitBash,
  maskEmail,
  account,
  shellName,
  connectionView,
};
