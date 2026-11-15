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
