"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const p = require("../lib/progress");
const demo = require("../lib/demo");

const START = Date.parse("2026-11-16T12:00:00Z");
const at = (seconds) => START + seconds * 1000;
// What the panel shows for each demo task, through the same steps as a real task.
const shown = (seconds, options) =>
  Object.fromEntries(demo.demoTasks(START, at(seconds), options).map((task) => [task.id, p.view(task, at(seconds), options?.staleMinutes ?? 10, 1)]));

test("the demo shows four tasks, each one a different thing the panel shows", () => {
  const views = shown(30);
  assert.deepEqual(Object.keys(views), ["demo:build", "demo:training", "demo:stalled", "demo:tests"]);
  for (const v of Object.values(views)) assert.match(v.title, /^Demo: /);
  assert.equal(views["demo:build"].kind, "running");
  assert.equal(views["demo:build"].count, "60 / 200 files");
  assert.notEqual(views["demo:build"].left, "", "a count with the time left");
  assert.equal(views["demo:training"].percent, 33);
  assert.equal(views["demo:training"].left, "1 min left", "the task's own estimate: 60 s");
  assert.equal(views["demo:stalled"].kind, "stalled");
  assert.equal(views["demo:tests"].kind, "done");
});

test("the tests run, then end a third of the way in, and start leaving the list", () => {
  const before = shown(10)["demo:tests"];
  assert.equal(before.kind, "running");
  assert.equal(before.count, "24 / 48 tests");
  const after = shown(50)["demo:tests"];
  assert.equal(after.kind, "done");
  assert.equal(after.when, "30 s ago", "ended at 20 s, not at every update");
  assert.equal(after.leavesIn, 30);
});

test("the stalled task is stalled whatever the setting", () => {
  assert.equal(shown(5, { staleMinutes: 45 })["demo:stalled"].kind, "stalled");
  assert.equal(shown(5, { staleMinutes: 1 })["demo:stalled"].kind, "stalled");
});

test("the demo ends after its seconds, and a short demo still shows the tests ending", () => {
  assert.equal(demo.demoTasks(START, at(59.9)).length, 4);
  assert.deepEqual(demo.demoTasks(START, at(60)), []);
  assert.deepEqual(demo.demoTasks(START, at(-1)), []);
  assert.equal(shown(6, { seconds: 15 })["demo:tests"].kind, "done");
  assert.deepEqual(demo.demoTasks(START, at(15), { seconds: 15 }), []);
});

test("only demo ids are taken for demo tasks: the npm run demo files are real tasks", () => {
  assert.equal(demo.isDemo("demo:build"), true);
  assert.equal(demo.isDemo("demo-build"), false);
  assert.equal(demo.isDemo(undefined), false);
});

test("the link in the settings runs a command the extension declares and registers", () => {
  const root = path.join(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const link = pkg.contributes.configuration.properties["agentProgress.demoSeconds"].markdownDescription.match(/\(command:([\w.]+)\)/);
  assert.ok(link, "the setting has a command link");
  assert.ok(pkg.contributes.commands.some((c) => c.command === link[1]), "declared");
  assert.ok(fs.readFileSync(path.join(root, "extension.js"), "utf8").includes(`registerCommand("${link[1]}"`), "registered");
  assert.equal(pkg.contributes.configuration.properties["agentProgress.demoSeconds"].default, demo.DEMO_SECONDS);
});
