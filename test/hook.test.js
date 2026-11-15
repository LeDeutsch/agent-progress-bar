"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const hook = require("../lib/hook");
const { formatDuration } = require("../lib/progress");

const SCRIPT = path.join(__dirname, "..", "bin", "agent-progress.js");
const T0 = new Date("2026-11-15T12:00:00Z");
const later = (seconds) => new Date(T0.getTime() + seconds * 1000);

// Shaped like the examples of Claude Code's hooks reference (common fields, Bash tool_input).
function toolEvent(name, fields = {}) {
  return {
    session_id: "abc123",
    transcript_path: "/home/user/.claude/projects/p/abc123.jsonl",
    cwd: "/home/user/my-project",
    permission_mode: "default",
    hook_event_name: name,
    tool_name: "Bash",
    tool_use_id: "toolu_01ABC123",
    tool_input: { command: "cargo test --release", description: "Run the tests", timeout: 120000, run_in_background: false },
    ...fields,
  };
}

/** Applies the hook's writes to a folder held in memory, as the command does on disk. */
function play(events) {
  const files = new Map();
  for (const [event, at] of events) {
    const existing = [...files].map(([id, data]) => ({ id, data }));
    for (const change of hook.onEvent(event, at, existing, formatDuration)) {
      if (change.onlyIfNew && files.has(change.id)) continue;
      files.set(change.id, { ...(files.get(change.id) || {}), ...change.data });
    }
  }
  return files;
}

test("a command in the foreground: a card when it starts, done when it ends", () => {
  const files = play([[toolEvent("PreToolUse"), T0]]);
  const card = files.get("claude-toolu_01ABC123");
  assert.equal(card.title, "Run the tests");
  assert.equal(card.state, "running");
  assert.equal(card.auto, true, "shown only once it lasts");
  assert.equal(card.heartbeat, false, "silent while it runs: never called stuck");
  assert.equal(card.started, T0.toISOString());

  const after = play([
    [toolEvent("PreToolUse"), T0],
    [toolEvent("PostToolUse", { tool_response: { stdout: "ok", stderr: "", interrupted: false }, duration_ms: 42000 }), later(42)],
  ]).get("claude-toolu_01ABC123");
  assert.equal(after.state, "done");
  assert.equal(after.detail, "finished in 40 s");
  assert.equal(after.started, T0.toISOString(), "the start written first is kept");
});

test("the end arriving before the start (both hooks run at once) still gives one finished card", () => {
  const files = play([
    [toolEvent("PostToolUse", { tool_response: { stdout: "" }, duration_ms: 30000 }), later(30)],
    [toolEvent("PreToolUse"), T0],
  ]);
  assert.equal(files.size, 1);
  const card = files.get("claude-toolu_01ABC123");
  assert.equal(card.state, "done", "the late start does not bring it back to running");
  assert.equal(card.started, T0.toISOString(), "the start is worked out from duration_ms");
});

test("a failed or interrupted command ends red, with the first line of the error", () => {
  const failed = play([
    [toolEvent("PreToolUse"), T0],
    [toolEvent("PostToolUseFailure", { error: "Exit code 101\nerror: test failed, to rerun pass `--lib`" }), later(9)],
  ]).get("claude-toolu_01ABC123");
  assert.equal(failed.state, "failed");
  assert.equal(failed.detail, "Exit code 101");

  const stopped = play([[toolEvent("PostToolUseFailure", { error: "", is_interrupt: true }), later(5)]]).get("claude-toolu_01ABC123");
  assert.equal(stopped.detail, "interrupted");

  const cut = play([[toolEvent("PostToolUse", { tool_response: { interrupted: true }, duration_ms: 65000 }), later(65)]]).get("claude-toolu_01ABC123");
  assert.equal(cut.state, "failed");
  assert.equal(cut.detail, "interrupted after 1 min");
});

test("a command in the background runs until Claude Code's list no longer has it", () => {
  const input = { command: "npm run build", description: "Build the site", run_in_background: true };
  const start = [
    [toolEvent("PreToolUse", { tool_input: input }), T0],
    [toolEvent("PostToolUse", { tool_input: input, tool_response: { stdout: "" } }), later(1)],
  ];
  const launched = play(start).get("claude-toolu_01ABC123");
  assert.equal(launched.state, "running", "the tool returns at once: the command still runs");
  assert.equal(launched.detail, "in the background");

  const stop = (tasks) => ({ session_id: "abc123", hook_event_name: "Stop", stop_hook_active: false, background_tasks: tasks });
  const listed = [{ id: "task-001", type: "shell", status: "running", description: "Build the site", command: "npm run build" }];
  assert.equal(play([...start, [stop(listed), later(30)]]).get("claude-toolu_01ABC123").state, "running");

  const gone = play([...start, [stop([]), later(90)]]).get("claude-toolu_01ABC123");
  assert.equal(gone.state, "ended", "over, but Claude Code does not say how");
  assert.equal(gone.updated, later(90).toISOString());

  const unknown = play([...start, [{ session_id: "abc123", hook_event_name: "Stop" }, later(90)]]).get("claude-toolu_01ABC123");
  assert.equal(unknown.state, "running", "no list at all: nothing can be told");

  const status = (s) => play([...start, [stop([{ ...listed[0], status: s }]), later(90)]]).get("claude-toolu_01ABC123");
  assert.equal(status("completed").state, "done");
  assert.equal(status("failed").state, "failed");
  assert.equal(status("killed").detail, "stopped (killed)");
});

test("a background command is found in the list even cut or under its description only", () => {
  const long = `node build.js ${"--flag ".repeat(200)}`;
  const card = { command: long, title: "Build" };
  assert.ok(hook.sameTask({ command: long.slice(0, 1000) }, card), "cut at 1000 characters");
  assert.ok(hook.sameTask({ command: `cd /repo && ${long}` }, card), "wrapped");
  assert.ok(hook.sameTask({ command: "something else", description: "Build" }, card), "same description");
  assert.ok(!hook.sameTask({ command: "npm test", description: "Tests" }, card));
});

test("the end of a turn ends what is left of it, other sessions are left alone", () => {
  const other = toolEvent("PreToolUse", { session_id: "other", tool_use_id: "toolu_other" });
  const files = play([
    [toolEvent("PreToolUse"), T0],
    [other, T0],
    [{ session_id: "abc123", hook_event_name: "Stop", background_tasks: [] }, later(60)],
  ]);
  assert.equal(files.get("claude-toolu_01ABC123").state, "ended", "a foreground card whose end was missed");
  assert.equal(files.get("claude-toolu_other").state, "running");

  const end = play([
    [toolEvent("PreToolUse", { tool_input: { command: "sleep 600", run_in_background: true } }), T0],
    [{ session_id: "abc123", hook_event_name: "SessionEnd", reason: "exit" }, later(60)],
  ]);
  assert.equal(end.get("claude-toolu_01ABC123").detail, "the Claude Code session ended");
});

test("commands that show themselves, other tools and empty commands make no card", () => {
  const none = (command, tool = "Bash") => play([[toolEvent("PreToolUse", { tool_name: tool, tool_input: { command } }), T0]]).size === 0;
  assert.ok(none('agent-progress run --title "Tests" cargo test'));
  assert.ok(none('~/.agent-progress/bin/agent-progress run --title "Build" -- npm run build'));
  assert.ok(none('& "$HOME\\.agent-progress\\bin\\agent-progress.cmd" run --title "Build" npm run build', "PowerShell"));
  assert.ok(none("agent-progress set voices --done 4 --total 10"));
  assert.ok(!none("grep -rn agent-progress README.md"), "only mentions the name");
  assert.ok(none("cargo build", "Read"));
  assert.ok(none("   "));
  assert.equal(play([[toolEvent("PreToolUse", { tool_name: "PowerShell" }), T0]]).size, 1, "PowerShell counts");
});

test("without a description, the title is the first line of the command", () => {
  assert.equal(hook.titleOf({ command: "cargo test\ncargo clippy" }), "cargo test");
  assert.equal(hook.titleOf({ command: "x".repeat(100) }).length, 80);
  assert.equal(hook.idOf("toolu_01/../x"), "claude-toolu_01..x");
  assert.equal(hook.idOf(""), null);
});

/** Like play(), for another tool; `events` are [event, at, eventName]. */
function playTool(tool, events) {
  const files = new Map();
  for (const [event, at, name] of events) {
    const existing = [...files].map(([id, data]) => ({ id, data }));
    for (const change of hook.onEvent(event, at, existing, formatDuration, tool, name)) {
      if (change.onlyIfNew && files.has(change.id)) continue;
      files.set(change.id, { ...(files.get(change.id) || {}), ...change.data });
    }
  }
  return files;
}
const only = (files) => {
  assert.equal(files.size, 1, `one card, got ${[...files.keys()].join(", ")}`);
  return [...files.values()][0];
};

// Shaped like the examples of Codex's hooks page (common fields, Bash tool, tool_use_id).
const codex = (name, fields = {}) => ({
  session_id: "s-codex", transcript_path: null, cwd: "/repo", hook_event_name: name, model: "gpt",
  turn_id: "t1", tool_name: "Bash", tool_use_id: "call_7", tool_input: { command: "cargo test" }, permission_mode: "default", ...fields,
});

test("Codex: a card from its start to its end, paired by tool_use_id", () => {
  const card = playTool("codex", [[codex("PreToolUse"), T0], [codex("PostToolUse", { tool_response: { exit_code: 0 } }), later(42)]]).get("codex-call_7");
  assert.equal(card.source, "Codex");
  assert.equal(card.title, "cargo test");
  assert.equal(card.state, "done");
  assert.equal(card.detail, "finished in 40 s");
  const failed = playTool("codex", [[codex("PreToolUse"), T0], [codex("PostToolUse", { tool_response: { exit_code: 101 } }), later(9)]]).get("codex-call_7");
  assert.equal(failed.state, "failed");
  assert.equal(failed.detail, "exit code 101");
  const words = playTool("codex", [[codex("PreToolUse", { tool_input: { command: ["npm", "run", "build"] } }), T0]]).get("codex-call_7");
  assert.equal(words.command, "npm run build", "a command given as a list of words");
});

test("Codex: the end of a turn ends nothing (a long command ends later), the end of the session does", () => {
  const start = [[codex("PreToolUse"), T0]];
  assert.equal(playTool("codex", [...start, [codex("Stop", { stop_hook_active: false }), later(5)]]).get("codex-call_7").state, "running");
  assert.equal(playTool("codex", [...start, [{ session_id: "s-codex", hook_event_name: "SessionEnd", reason: "other" }, later(5)]]).get("codex-call_7").state, "ended");
  assert.equal(playTool("codex", [[codex("PreToolUse", { tool_name: "apply_patch" }), T0]]).size, 0, "only shell commands");
});

// Shaped like Copilot's hooks reference (camelCase payload, no event name in it, toolArgs as JSON text).
const copilot = (fields = {}) => ({
  sessionId: "s-cp", timestamp: T0.getTime(), cwd: "C:\\repo", toolName: "powershell",
  toolArgs: JSON.stringify({ command: "npm test", description: "Run the tests" }), ...fields,
});

test("GitHub Copilot: no call id, the command finds its card again; the event comes as an argument", () => {
  const card = only(playTool("copilot", [[copilot(), T0, "preToolUse"], [copilot({ toolResult: { resultType: "success", textResultForLlm: "ok" } }), later(30), "postToolUse"]]));
  assert.equal(card.source, "GitHub Copilot");
  assert.equal(card.title, "Run the tests");
  assert.equal(card.state, "done");
  assert.equal(card.detail, "finished in 30 s");
  const failed = only(playTool("copilot", [[copilot(), T0, "preToolUse"], [copilot({ error: "Exit code 1\nnpm ERR!" }), later(3), "postToolUseFailure"]]));
  assert.equal(failed.state, "failed");
  assert.equal(failed.detail, "Exit code 1");
  const bash = only(playTool("copilot", [[copilot({ toolName: "bash", toolArgs: { command: "make" } }), T0, "preToolUse"]]));
  assert.equal(bash.title, "make", "arguments as an object, the bash tool");
  assert.equal(playTool("copilot", [[copilot({ toolName: "view" }), T0, "preToolUse"]]).size, 0, "only shell commands");
});

test("GitHub Copilot: the same command twice, the first to start is the first to end", () => {
  const files = playTool("copilot", [
    [copilot(), T0, "preToolUse"],
    [copilot(), later(5), "preToolUse"],
    [copilot(), later(20), "postToolUse"],
  ]);
  const cards = [...files.values()].sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  assert.deepEqual(cards.map((c) => c.state), ["done", "running"]);
  assert.equal(cards[0].detail, "finished in 20 s");
  const stopped = playTool("copilot", [[copilot(), T0, "preToolUse"], [{ sessionId: "s-cp", timestamp: 1 }, later(60), "agentStop"]]);
  assert.equal(only(stopped).state, "ended", "the end of the agent's turn");
  assert.equal(playTool("copilot", [[copilot(), later(20), "postToolUse"]]).size, 0, "an end without its start writes nothing");
});

// Shaped like Gemini CLI's hooks reference (base fields, run_shell_command, tool_response).
const gemini = (name, fields = {}) => ({
  session_id: "s-gm", transcript_path: "/t", cwd: "/repo", hook_event_name: name, timestamp: T0.toISOString(),
  tool_name: "run_shell_command", tool_input: { command: "npm run build", description: "Build the site" }, ...fields,
});

test("Gemini CLI: before and after a shell command, an error fails it, the end of the turn ends the rest", () => {
  const card = only(playTool("gemini", [[gemini("BeforeTool"), T0], [gemini("AfterTool", { tool_response: { llmContent: "ok", returnDisplay: "ok" } }), later(65)]]));
  assert.equal(card.source, "Gemini CLI");
  assert.equal(card.title, "Build the site");
  assert.equal(card.state, "done");
  assert.equal(card.detail, "finished in 1 min");
  const failed = only(playTool("gemini", [[gemini("BeforeTool"), T0], [gemini("AfterTool", { tool_response: { error: { message: "Command exited with code 2" } } }), later(4)]]));
  assert.equal(failed.state, "failed");
  assert.equal(failed.detail, "Command exited with code 2");
  const turn = only(playTool("gemini", [[gemini("BeforeTool"), T0], [{ session_id: "s-gm", hook_event_name: "AfterAgent" }, later(30)]]));
  assert.equal(turn.state, "ended");
  assert.equal(playTool("gemini", [[gemini("BeforeTool", { tool_name: "read_file" }), T0]]).size, 0);
});

test("the hook command for each tool: Gemini gets {} as its answer, the others nothing, and all end well", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-progress-hook-"));
  const run = (args, event) =>
    spawnSync(process.execPath, [SCRIPT, "hook", ...args], { input: JSON.stringify(event), env: { ...process.env, AGENT_PROGRESS_DIR: dir }, encoding: "utf8" });
  const g = run(["gemini"], gemini("BeforeTool"));
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.stdout, "{}");
  const c = run(["copilot", "preToolUse"], copilot());
  assert.equal(c.status, 0, c.stderr);
  assert.equal(c.stdout, "");
  const x = run(["codex"], codex("PreToolUse"));
  assert.equal(x.status, 0, x.stderr);
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names.map((n) => n.split("-")[0]), ["codex", "copilot", "gemini"], names.join(", "));
  const bom = spawnSync(process.execPath, [SCRIPT, "hook", "codex"], {
    input: `﻿${JSON.stringify(codex("PreToolUse", { tool_use_id: "call_bom" }))}\r\n`,
    env: { ...process.env, AGENT_PROGRESS_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(bom.status, 0);
  assert.ok(fs.existsSync(path.join(dir, "codex-call_bom.json")), "an event passed on by PowerShell (with its byte order mark) is read");
  const odd = run(["cursor"], {});
  assert.equal(odd.status, 0, "an unknown tool is ignored, never an error");
  assert.equal(odd.stdout, "");
});

test("the agent-progress hook command reads the event on stdin and writes the card", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-progress-hook-"));
  const run = (event) =>
    spawnSync(process.execPath, [SCRIPT, "hook"], { input: JSON.stringify(event), env: { ...process.env, AGENT_PROGRESS_DIR: dir }, encoding: "utf8" });
  const start = run(toolEvent("PreToolUse"));
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stdout, "", "a hook prints nothing");
  const file = path.join(dir, "claude-toolu_01ABC123.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).state, "running");
  run(toolEvent("PostToolUse", { tool_response: { stdout: "" }, duration_ms: 1000 }));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).state, "done");
  const bad = spawnSync(process.execPath, [SCRIPT, "hook"], { input: "not json", env: { ...process.env, AGENT_PROGRESS_DIR: dir }, encoding: "utf8" });
  assert.equal(bad.status, 0, "a broken event is ignored, never an error for Claude Code");
  assert.equal(bad.stderr, "");
});
