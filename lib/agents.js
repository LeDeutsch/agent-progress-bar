"use strict";
// The AI coding tools the panel connects to: where each one keeps its hooks, and the hooks the
// panel adds there, so the commands it runs show up on their own (lib/hook.js reads what they
// send). Pure functions, tested with `node --test`; the extension shows each change side by side
// and writes it only once the user agrees.
//
// Left out on purpose: Cursor (its "before a command" hook has to answer "allow", which could let
// a command run without the user's own approval: a watcher must never do that), Windsurf (its
// hooks moved to Devin, in another format) and Cline (its hooks became TypeScript plugins, and
// did not run on Windows).

const path = require("path");
const claude = require("./claude");

/**
 * The launcher, from a shell that may be cmd or PowerShell (Windows): a bare path works in both,
 * so it is quoted only when it has a space.
 */
function windowsCall(bin, args) {
  const cmd = path.win32.join(bin, "agent-progress.cmd");
  return `${/\s/.test(cmd) ? `"${cmd}"` : cmd} ${args}`;
}

/** The launcher, from bash (Git Bash on Windows, with forward slashes). */
function shCall(bin, args, windows) {
  return `"${windows ? bin.replace(/\\/g, "/") : bin}/agent-progress" ${args}`;
}

/** GitHub Copilot: a hooks file of the panel's own, every hook told to end well (a failing preToolUse hook denies the command). */
function copilotFile({ bin, windows }) {
  const entry = (event, matcher) => ({
    type: "command",
    bash: `${shCall(bin, `hook copilot ${event}`, windows)}; exit 0`,
    ...(windows ? { powershell: `& "${path.win32.join(bin, "agent-progress.cmd")}" hook copilot ${event}; exit 0` } : {}),
    timeoutSec: 10,
    ...(matcher ? { matcher } : {}),
  });
  const shell = "bash|powershell";
  const hooks = {
    preToolUse: [entry("preToolUse", shell)],
    postToolUse: [entry("postToolUse", shell)],
    postToolUseFailure: [entry("postToolUseFailure", shell)],
    agentStop: [entry("agentStop")],
    sessionEnd: [entry("sessionEnd")],
  };
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

function hasOurs(text) {
  try {
    return claude.hasOurs(claude.parse(text));
  } catch {
    return false;
  }
}

/**
 * Each tool: id (the hook's name for it), name, mark (the sign on its row: "spark" or letters),
 * home (its folder: there means installed), file (where the hooks go), label (that file, for
 * people), own (the whole file is the panel's: Disconnect deletes it), connect(text, call) and
 * disconnect(text) (the file's new text; null deletes it), trust (what to do once in the tool).
 * `where` is { home, env }; `call` is { bin, windows, bash }.
 */
const AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    mark: "spark",
    home: ({ home }) => path.join(home, ".claude"),
    file: ({ home }) => path.join(home, ".claude", "settings.json"),
    label: "~/.claude/settings.json",
    connect: (text, call) => claude.connect(text, claude.hookCall(call)),
    disconnect: (text) => claude.disconnect(text),
  },
  {
    id: "codex",
    name: "Codex",
    mark: "Cx",
    home: ({ home, env }) => env.CODEX_HOME || path.join(home, ".codex"),
    file: (where) => path.join(where.env.CODEX_HOME || path.join(where.home, ".codex"), "hooks.json"),
    label: "~/.codex/hooks.json",
    connect: (text, { bin, windows }) =>
      claude.mergeHooks(
        text,
        [
          ["PreToolUse", "Bash"],
          ["PostToolUse", "Bash"],
          ["SessionEnd", null],
        ],
        () => ({
          type: "command",
          command: shCall(bin, "hook codex", windows),
          ...(windows ? { commandWindows: windowsCall(bin, "hook codex") } : {}),
          async: true,
          timeout: 30,
        }),
      ),
    disconnect: (text) => claude.disconnect(text),
    trust: "Trust the hook once in Codex: /hooks",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    mark: "Cp",
    home: ({ home, env }) => env.COPILOT_HOME || path.join(home, ".copilot"),
    file: (where) => path.join(where.env.COPILOT_HOME || path.join(where.home, ".copilot"), "hooks", "agent-progress.json"),
    label: "~/.copilot/hooks/agent-progress.json",
    own: true,
    connect: (_text, call) => copilotFile(call),
    disconnect: () => null,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    mark: "G",
    home: ({ home }) => path.join(home, ".gemini"),
    file: ({ home }) => path.join(home, ".gemini", "settings.json"),
    label: "~/.gemini/settings.json",
    connect: (text, { bin, windows }) =>
      claude.mergeHooks(
        text,
        [
          ["BeforeTool", "run_shell_command"],
          ["AfterTool", "run_shell_command"],
          ["AfterAgent", null],
          ["SessionEnd", null],
        ],
        () => ({
          name: "agent-progress",
          type: "command",
          command: windows ? windowsCall(bin, "hook gemini") : shCall(bin, "hook gemini", false),
          timeout: 10000,
        }),
      ),
    disconnect: (text) => claude.disconnect(text),
  },
];

function byId(id) {
  return AGENTS.find((agent) => agent.id === id) || null;
}

/** Whether a tool's hooks file holds the panel's hooks. */
function isConnected(text) {
  return hasOurs(text);
}

/**
 * What the Connections page shows for one tool: Claude Code's row (lib/claude.js), named after
 * the tool, with where its hooks are and what is left to do once in it.
 */
function rowOf(agent, { state, account, stats, shell, now, formatDuration }) {
  const view = claude.connectionView({ state, account: agent.id === "claude" ? account : null, stats, shell, now, formatDuration });
  return {
    ...view,
    id: agent.id,
    name: agent.name,
    mark: agent.mark,
    hooksLabel: agent.label,
    shell: agent.id === "claude" ? view.shell : "",
    // The one thing left to do in the tool itself, shown last.
    todo: state === "connected" && agent.trust ? agent.trust : "",
  };
}

/**
 * The main button of the empty panel: { cmd, agent, label } to connect the one tool found and
 * not connected yet, or to open the Connections page when there are several; null when every
 * tool found is connected, or none is there.
 */
function connectButton(states) {
  const waiting = states.filter((s) => s.state === "available");
  if (!waiting.length) return null;
  if (waiting.length === 1) return { cmd: "connect", agent: waiting[0].id, label: `Connect ${waiting[0].name}` };
  return { cmd: "connections", agent: "", label: "Connect an agent" };
}

/** "Claude Code connected", "2 agents connected", or "" (shown under the buttons). */
function connectedText(states) {
  const on = states.filter((s) => s.state === "connected");
  if (!on.length) return "";
  return on.length === 1 ? `${on[0].name} connected` : `${on.length} agents connected`;
}

module.exports = { AGENTS, byId, isConnected, rowOf, connectButton, connectedText, windowsCall, shCall, copilotFile };
