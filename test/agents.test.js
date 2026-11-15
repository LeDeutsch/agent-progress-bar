"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const agents = require("../lib/agents");
const { formatDuration } = require("../lib/progress");

const WIN = { bin: "C:\\Users\\me\\.agent-progress\\bin", windows: true, bash: true };
const NIX = { bin: "/home/me/.agent-progress/bin", windows: false, bash: true };
const agent = (id) => agents.byId(id);
const hooksOf = (text) => JSON.parse(text).hooks;

test("Codex: its own hooks are kept, the panel's are async and called from any shell on Windows", () => {
  const mine = `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } }, null, 2)}\n`;
  const out = agent("codex").connect(mine, WIN);
  const hooks = hooksOf(out);
  assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "Stop"]);
  assert.equal(hooks.Stop[0].hooks[0].command, "notify-send done", "the user's own hook stays");
  const ours = hooks.PreToolUse[0];
  assert.equal(ours.matcher, "Bash");
  assert.equal(ours.hooks[0].async, true);
  assert.equal(ours.hooks[0].commandWindows, "C:\\Users\\me\\.agent-progress\\bin\\agent-progress.cmd hook codex", "bare: works in cmd and PowerShell");
  assert.equal(ours.hooks[0].command, '"C:/Users/me/.agent-progress/bin/agent-progress" hook codex');
  assert.ok(agents.isConnected(out));
  assert.equal(agent("codex").connect(out, WIN), out, "twice changes nothing");
  assert.equal(agent("codex").disconnect(out), mine, "disconnect gives the file back");
  assert.equal(agent("codex").connect("", NIX).includes("commandWindows"), false, "no Windows command elsewhere");
});

test("a launcher path with a space is quoted", () => {
  assert.equal(agents.windowsCall("C:\\Users\\Jo Ann\\.agent-progress\\bin", "hook codex"), '"C:\\Users\\Jo Ann\\.agent-progress\\bin\\agent-progress.cmd" hook codex');
});

test("Gemini CLI: hooks on run_shell_command, the end of a turn and of a session, the rest of its settings kept", () => {
  const mine = `${JSON.stringify({ theme: "Dracula", general: { vimMode: true } }, null, 2)}\n`;
  const out = agent("gemini").connect(mine, WIN);
  const settings = JSON.parse(out);
  assert.equal(settings.theme, "Dracula");
  assert.deepEqual(Object.keys(settings.hooks), ["BeforeTool", "AfterTool", "AfterAgent", "SessionEnd"]);
  const ours = settings.hooks.BeforeTool[0];
  assert.equal(ours.matcher, "run_shell_command");
  assert.deepEqual(ours.hooks[0], { name: "agent-progress", type: "command", command: "C:\\Users\\me\\.agent-progress\\bin\\agent-progress.cmd hook gemini", timeout: 10000 });
  assert.equal(agent("gemini").disconnect(out), mine);
  assert.equal(hooksOf(agent("gemini").connect("{}", NIX)).AfterTool[0].hooks[0].command, '"/home/me/.agent-progress/bin/agent-progress" hook gemini');
});

test("GitHub Copilot: a file of the panel's own, every hook ends well, Disconnect deletes it", () => {
  const out = agent("copilot").connect("", WIN);
  const file = JSON.parse(out);
  assert.equal(file.version, 1);
  assert.deepEqual(Object.keys(file.hooks), ["preToolUse", "postToolUse", "postToolUseFailure", "agentStop", "sessionEnd"]);
  const pre = file.hooks.preToolUse[0];
  assert.equal(pre.matcher, "bash|powershell");
  assert.equal(pre.powershell, '& "C:\\Users\\me\\.agent-progress\\bin\\agent-progress.cmd" hook copilot preToolUse; exit 0');
  for (const [event, [entry]] of Object.entries(file.hooks)) {
    assert.match(entry.bash, /; exit 0$/, `${event}: a failing preToolUse hook would deny the command`);
    assert.match(entry.bash, new RegExp(`hook copilot ${event}; exit 0$`), "the event is given to the hook");
  }
  assert.ok(agents.isConnected(out));
  assert.equal(agent("copilot").disconnect(out), null);
  assert.equal("powershell" in JSON.parse(agent("copilot").connect("", NIX)).hooks.sessionEnd[0], false);
  assert.equal(agent("copilot").own, true);
});

test("one button in the empty panel, whatever the number of agents", () => {
  const s = (id, state) => ({ id, name: agent(id).name, state });
  assert.equal(agents.connectButton([]), null, "no agent: the instructions are the way in");
  assert.deepEqual(agents.connectButton([s("claude", "available")]), { cmd: "connect", agent: "claude", label: "Connect Claude Code" });
  assert.deepEqual(agents.connectButton([s("claude", "connected"), s("codex", "available")]), { cmd: "connect", agent: "codex", label: "Connect Codex" });
  assert.deepEqual(agents.connectButton([s("claude", "available"), s("gemini", "available")]), { cmd: "connections", agent: "", label: "Connect an agent" });
  assert.equal(agents.connectButton([s("claude", "connected")]), null);
  assert.equal(agents.connectedText([s("claude", "connected")]), "Claude Code connected");
  assert.equal(agents.connectedText([s("claude", "connected"), s("copilot", "connected"), s("codex", "available")]), "2 agents connected");
  assert.equal(agents.connectedText([s("codex", "available")]), "");
});

test("a Connections row per tool: the account for Claude Code only, the step left to do for Codex", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  const base = { account: { name: "Alex", email: "al•••@example.com" }, stats: { seen: 3, shown: 1, last: null }, shell: "Git Bash", now, formatDuration };
  const claude = agents.rowOf(agent("claude"), { ...base, state: "connected" });
  assert.equal(claude.who, "Alex · al•••@example.com");
  assert.equal(claude.mark, "spark");
  assert.equal(claude.hooksLabel, "~/.claude/settings.json");
  const codex = agents.rowOf(agent("codex"), { ...base, state: "connected" });
  assert.equal(codex.who, "", "no account read for the other tools");
  assert.equal(codex.shell, "");
  assert.equal(codex.todo, "Trust the hook once in Codex: /hooks");
  assert.equal(agents.rowOf(agent("claude"), { ...base, state: "connected" }).todo, "");
  assert.equal(codex.mark, "Cx");
  assert.deepEqual(agents.rowOf(agent("codex"), { ...base, state: "available" }).lines, [["Found on this computer"]]);
});
