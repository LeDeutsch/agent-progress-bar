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

test("without a start time or progress, the time left is unknown", () => {
  assert.equal(p.remainingSeconds(p.parseTask("a", '{"done": 3, "total": 10}', NOW), NOW), null);
  assert.equal(p.remainingSeconds(p.parseTask("a", '{"state": "done"}', NOW), NOW), 0);
});

test("durations read naturally", () => {
  assert.equal(p.formatDuration(30), "under a minute");
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

test("the panel view counts with separators and the unit", () => {
  const task = p.parseTask("a", JSON.stringify({ done: 1452, total: 5808, unit: "takes", detail: "Eva" }), NOW);
  const v = p.view(task, NOW, 10);
  assert.equal(v.count, "1,452 / 5,808 takes");
  assert.equal(v.percent, 25);
  assert.equal(v.detail, "Eva");
});
