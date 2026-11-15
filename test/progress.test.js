"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../lib/progress");

const NOW = Date.parse("2026-11-15T12:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

test("a file with done and total gives the percentage", () => {
  const task = p.parseTask("voices", JSON.stringify({ title: "Voice packs", done: 1452, total: 5808 }), NOW);
  assert.equal(task.title, "Voice packs");
  assert.equal(task.state, "running");
  assert.equal(Math.floor(p.percentOf(task)), 25);
});

test("a percent field works on its own and is kept between 0 and 100", () => {
  assert.equal(p.percentOf(p.parseTask("a", '{"percent": 42}', NOW)), 42);
  assert.equal(p.percentOf(p.parseTask("a", '{"percent": 140}', NOW)), 100);
  assert.equal(p.percentOf(p.parseTask("a", "{}", NOW)), null);
  assert.equal(p.percentOf(p.parseTask("a", '{"state": "done"}', NOW)), 100);
});

test("the time left comes from the pace so far", () => {
  // 25 % done in 20 minutes: 60 minutes left.
  const task = p.parseTask("a", JSON.stringify({ done: 25, total: 100, started: minutesAgo(20) }), NOW);
  assert.equal(Math.round(p.remainingSeconds(task, NOW) / 60), 60);
  assert.equal(p.formatDuration(p.remainingSeconds(task, NOW)), "1 h 00 min");
});

test("an eta given by the writer wins and counts down since the last update", () => {
  const text = JSON.stringify({ percent: 10, eta_seconds: 600, updated: minutesAgo(2), started: minutesAgo(1) });
  const task = p.parseTask("a", text, NOW);
  assert.equal(Math.round(p.remainingSeconds(task, NOW)), 480);
});

test("the time left follows the speed of the last few minutes", () => {
  // 50 % in 60 minutes, but only 4 % in the last 2 minutes: it slowed down to 2 % a minute.
  const at = (m, percent) => p.parseTask("a", JSON.stringify({ percent, started: minutesAgo(60), updated: minutesAgo(m) }), NOW);
  let samples = [];
  for (const [m, percent] of [[2, 46], [1, 48], [0, 50]]) samples = p.addSample(samples, at(m, percent), NOW);
  const task = at(0, 50);
  assert.equal(Math.round(p.remainingSeconds(task, NOW) / 60), 60, "without readings: the pace since the start");
  task.samples = samples;
  const { seconds, source } = p.estimate(task, NOW);
  assert.equal(Math.round(seconds / 60), 25, "with readings: 50 % left at 2 % a minute");
  assert.equal(source, "recent");
  assert.equal(p.view(task, NOW, 10).leftHint, "From the speed over the last 3 minutes");
});

test("readings: one per update, old ones dropped, a restart starts over", () => {
  const at = (m, percent) => p.parseTask("a", JSON.stringify({ percent, updated: minutesAgo(m) }), NOW);
  let samples = p.addSample([], at(9, 10), NOW);
  samples = p.addSample(samples, at(2, 20), NOW);
  samples = p.addSample(samples, at(2, 20), NOW);
  assert.deepEqual(samples.map((s) => s.percent), [20], "the 9 minute old reading is dropped, the same update counted once");
  samples = p.addSample(samples, at(1, 5), NOW);
  assert.deepEqual(samples.map((s) => s.percent), [5], "progress went back: the task restarted");
});

test("a finished task stays 2 minutes by default, a running one has no countdown", () => {
  const done = p.parseTask("d", JSON.stringify({ state: "done", updated: minutesAgo(0.5) }), NOW);
  const v = p.view(done, NOW, 10);
  assert.deepEqual([v.keepFor, v.leavesIn], [120, 90]);
  const running = p.parseTask("r", JSON.stringify({ percent: 5 }), NOW);
  assert.equal(p.view(running, NOW, 10).leavesIn, null);
});

test("old progress files, and only logs inside the progress folder, can go", () => {
  const old = p.parseTask("o", JSON.stringify({ state: "done", updated: minutesAgo(25 * 60) }), NOW);
  const recent = p.parseTask("n", JSON.stringify({ state: "done", updated: minutesAgo(60) }), NOW);
  assert.equal(p.isOld(old, NOW, 24), true);
  assert.equal(p.isOld(recent, NOW, 24), false);
  assert.equal(p.isOld(old, NOW, 0), false, "0 hours: never");
  assert.equal(p.isInside("C:/Users/me/.agent-progress", "C:/Users/me/.agent-progress/build.log"), true);
  assert.equal(p.isInside("C:/Users/me/.agent-progress", "C:/work/build.log"), false, "a log of the user's stays");
  assert.equal(p.isInside("C:/Users/me/.agent-progress", "C:/Users/me/.agent-progress/../x.log"), false);
  assert.equal(p.isInside("C:/Users/me/.agent-progress", "C:/Users/me/.agent-progress"), false);
});

test("the panel knows which tasks have a log and which can be removed", () => {
  const running = p.parseTask("a", JSON.stringify({ percent: 5, log: " C:/logs/build.txt " }), NOW);
  assert.equal(running.log, "C:/logs/build.txt");
  assert.equal(p.view(running, NOW, 10).hasLog, true);
  assert.equal(p.view(running, NOW, 10).removable, false);
  const done = p.parseTask("b", '{"state": "done"}', NOW);
  assert.equal(p.view(done, NOW, 10).hasLog, false);
  assert.equal(p.view(done, NOW, 10).removable, true);
});

test("without a start time or progress, the time left is unknown", () => {
  assert.equal(p.remainingSeconds(p.parseTask("a", '{"done": 3, "total": 10}', NOW), NOW), null);
  assert.equal(p.remainingSeconds(p.parseTask("a", '{"state": "done"}', NOW), NOW), 0);
});

test("durations read naturally", () => {
  assert.equal(p.formatDuration(0.2), "1 s");
  assert.equal(p.formatDuration(8), "8 s");
  assert.equal(p.formatDuration(42), "40 s");
  assert.equal(p.formatDuration(58), "1 min");
  assert.equal(p.formatDuration(12 * 60), "12 min");
  assert.equal(p.formatDuration(65 * 60), "1 h 05 min");
  assert.equal(p.formatDuration(null), "");
});

test("a broken or half-written file is ignored", () => {
  assert.equal(p.parseTask("a", '{"done": 3, "tot', NOW), null);
  assert.equal(p.parseTask("a", "[1, 2]", NOW), null);
  assert.equal(p.parseTask("a", "null", NOW), null);
});

test("a running task with no news for a while is shown as stalled", () => {
  const task = p.parseTask("a", JSON.stringify({ percent: 5, updated: minutesAgo(15) }), NOW);
  assert.equal(p.isStale(task, NOW, 10), true);
  assert.equal(p.isStale(task, NOW, 20), false);
  assert.equal(p.view(task, NOW, 10).stale, true);
});

test("the status bar shows the oldest running task, then how many others", () => {
  const first = p.parseTask("a", JSON.stringify({ title: "Voice packs", done: 25, total: 100, started: minutesAgo(20) }), NOW);
  const second = p.parseTask("b", JSON.stringify({ title: "Tests", percent: 50, started: minutesAgo(1) }), NOW);
  assert.equal(p.statusText([second, first], NOW), "$(sync~spin) Voice packs 25% · 1 h 00 min left (+1)");
  const done = p.parseTask("c", JSON.stringify({ title: "Build", state: "done" }), NOW);
  assert.equal(p.statusText([done], NOW), "$(check) Build done");
  assert.equal(p.statusText([], NOW), "");
});

test("a stalled task never hides the tasks that are moving", () => {
  const stalled = p.parseTask("s", JSON.stringify({ title: "Old", percent: 40, started: minutesAgo(30), updated: minutesAgo(15) }), NOW);
  const moving = p.parseTask("m", JSON.stringify({ title: "Build", done: 25, total: 100, started: minutesAgo(20) }), NOW);
  assert.equal(p.statusText([stalled, moving], NOW, 10), "$(sync~spin) Build 25% · 1 h 00 min left (+1)");
  assert.equal(p.statusText([stalled], NOW, 10), "$(warning) Old: no news for 15 min");
  assert.equal(p.view(stalled, NOW, 10).left, "", "no time left for a stalled task");
});

test("the panel view counts with separators and the unit", () => {
  const task = p.parseTask("a", JSON.stringify({ done: 1452, total: 5808, unit: "takes", detail: "Eva" }), NOW);
  const v = p.view(task, NOW, 10);
  assert.equal(v.count, "1,452 / 5,808 takes");
  assert.equal(v.percent, 25);
  assert.equal(v.detail, "Eva");
});

test("the panel lists moving tasks first, then stalled, failed and done", () => {
  const task = (id, fields) => p.parseTask(id, JSON.stringify(fields), NOW);
  const tasks = [
    task("done-old", { state: "done", updated: minutesAgo(4) }),
    task("late", { percent: 10, started: minutesAgo(2) }),
    task("failed", { state: "failed", updated: minutesAgo(1) }),
    task("stalled", { percent: 40, started: minutesAgo(60), updated: minutesAgo(15) }),
    task("done-new", { state: "done", updated: minutesAgo(1) }),
    task("early", { percent: 50, started: minutesAgo(30) }),
  ];
  const order = p.panelOrder(tasks, NOW, 10).map((t) => t.id);
  assert.deepEqual(order, ["early", "late", "stalled", "failed", "done-new", "done-old"]);
  assert.equal(p.summaryText(tasks, NOW, 10), "2 running · 1 stalled · 1 failed · 2 done");
  assert.equal(p.summaryText([tasks[0]], NOW, 10), "", "no summary for a single task");
});

test("the panel says how long a task has run, or when it ended", () => {
  const running = p.parseTask("a", JSON.stringify({ percent: 50, started: minutesAgo(12) }), NOW);
  assert.equal(p.view(running, NOW, 10).when, "running for 12 min");
  const done = p.parseTask("b", JSON.stringify({ state: "done", started: minutesAgo(30), updated: minutesAgo(3) }), NOW);
  const v = p.view(done, NOW, 10, 5);
  assert.equal(v.when, "3 min ago");
  assert.equal(v.whenHint, "Took 27 min. Leaves the list in 2 min");
  assert.deepEqual([v.leavesIn, v.keepFor], [120, 300], "2 of its 5 minutes left");
  const stalled = p.parseTask("c", JSON.stringify({ percent: 40, detail: "step 2", updated: minutesAgo(15) }), NOW);
  assert.equal(p.view(stalled, NOW, 10).note, "no news for 15 min");
  assert.equal(p.view(stalled, NOW, 10).kind, "stalled");
});

test("a command found on its own shows once it has lasted, a quick one never", () => {
  const auto = (fields) => p.parseTask("claude-x", JSON.stringify({ auto: true, heartbeat: false, ...fields }), NOW);
  assert.equal(p.isShown(auto({ started: minutesAgo(0.25) }), NOW, 20), false, "running for 15 s");
  assert.equal(p.isShown(auto({ started: minutesAgo(0.5) }), NOW, 20), true, "running for 30 s");
  assert.equal(p.isShown(auto({ state: "done", started: minutesAgo(1), updated: minutesAgo(0.9) }), NOW, 20), false, "took 6 s");
  assert.equal(p.isShown(auto({ state: "done", started: minutesAgo(3), updated: minutesAgo(1) }), NOW, 20), true, "took 2 min");
  assert.equal(p.isShown(p.parseTask("a", JSON.stringify({ started: minutesAgo(0) }), NOW), NOW, 20), true, "a task that reports itself shows at once");
});

test("a task that says nothing while it runs is never called stalled", () => {
  const quiet = p.parseTask("a", JSON.stringify({ heartbeat: false, started: minutesAgo(40), updated: minutesAgo(40) }), NOW);
  assert.equal(p.kindOf(quiet, NOW, 10), "running");
  assert.equal(p.view(quiet, NOW, 10).when, "running for 40 min");
});

test("an ended task: over, without saying how it went", () => {
  const ended = p.parseTask("a", JSON.stringify({ title: "Build", state: "ended", started: minutesAgo(5), updated: minutesAgo(1) }), NOW);
  const v = p.view(ended, NOW, 10);
  assert.equal(v.kind, "ended");
  assert.equal(v.percent, null, "no 100 %: it may not have finished its work");
  assert.equal(v.removable, true);
  assert.equal(v.leavesIn, 60);
  assert.equal(p.statusText([ended], NOW), "$(circle-outline) Build ended");
  const done = p.parseTask("b", JSON.stringify({ state: "done", updated: minutesAgo(1) }), NOW);
  assert.equal(p.summaryText([ended, done], NOW, 10), "1 done · 1 ended");
});
