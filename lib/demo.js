"use strict";
// The demo: four made-up tasks, one for each thing the panel shows (a count with the time left, a
// percentage with the task's own estimate, a stalled task, a task that ends and notifies), kept in
// memory for about a minute. No file is written, so they never mix with real tasks.
// Pure, like progress.js: tested with plain `node --test`.

const progress = require("./progress");

/** How long the demo lasts unless the setting says otherwise. */
const DEMO_SECONDS = 60;
/** Ids of demo tasks. A file name cannot hold ":" on Windows, so no real task gets one there. */
const PREFIX = "demo:";

function isDemo(id) {
  return typeof id === "string" && id.startsWith(PREFIX);
}

/**
 * The demo tasks `now` ms into a demo started at `start` (ms), read the way progress files are;
 * none once the demo has lasted `seconds`. The stalled task's silence follows `staleMinutes`, so
 * it shows as stalled whatever the setting.
 */
function demoTasks(start, now, { seconds = DEMO_SECONDS, staleMinutes = 10 } = {}) {
  const t = (now - start) / 1000;
  if (t < 0 || t >= seconds) return [];
  const iso = (ms) => new Date(ms).toISOString();
  const task = (id, fields) =>
    progress.parseTask(PREFIX + id, JSON.stringify({ started: iso(start), updated: iso(now), ...fields }), now);

  const files = Math.floor(t * 2);
  // The tests end a third of the way in (20 s in a one-minute demo), to show the notification.
  const testsEnd = Math.min(20, seconds / 3);
  const tests = Math.min(48, Math.floor((t / testsEnd) * 48));
  return [
    task("build", { title: "Demo: build", done: files, total: 200, unit: "files", detail: `compiling file ${files + 1}` }),
    task("training", {
      title: "Demo: model training",
      percent: Math.min(100, (t / 90) * 100),
      eta_seconds: Math.max(0, 90 - t),
      detail: `epoch ${Math.min(10, Math.floor(t / 9) + 1)} of 10`,
    }),
    task("stalled", {
      title: "Demo: stalled task",
      percent: 40,
      detail: "waiting for the GPU",
      started: iso(start - (staleMinutes + 20) * 60000),
      updated: iso(start - (staleMinutes + 5) * 60000),
    }),
    t < testsEnd
      ? task("tests", { title: "Demo: tests", done: tests, total: 48, unit: "tests", detail: `test ${tests + 1} of 48` })
      : task("tests", {
          title: "Demo: tests",
          done: 48,
          total: 48,
          unit: "tests",
          detail: "48 passed",
          state: "done",
          updated: iso(start + testsEnd * 1000),
        }),
  ];
}

module.exports = { DEMO_SECONDS, PREFIX, isDemo, demoTasks };
