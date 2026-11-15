"use strict";
// Demo: writes a few fake tasks in the progress folder for about 90 seconds, so you can watch
// every state of the extension: a count with the time left, several tasks at once, a task with
// no known progress, a failure, a stalled task, and the notifications at the end.
// Run: npm run demo  (Ctrl+C to stop; the demo files are removed at the end)

const fs = require("fs");
const os = require("os");
const path = require("path");

const folder = process.env.AGENT_PROGRESS_DIR || path.join(os.homedir(), ".agent-progress");
fs.mkdirSync(folder, { recursive: true });
const start = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const ids = ["demo-build", "demo-model", "demo-search", "demo-upload", "demo-stalled"];

function write(id, data) {
  const file = path.join(folder, `${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

// The build also writes a log, so its card gets an "Open log" button.
const buildLog = path.join(folder, "demo-build.log");
fs.writeFileSync(buildLog, "Demo build log\n");
let logged = 0;

function cleanUp() {
  for (const file of [...ids.map((id) => `${id}.json`), "demo-build.log"]) {
    try {
      fs.unlinkSync(path.join(folder, file));
    } catch {
      // already gone
    }
  }
}

// A task that stopped sending news 15 minutes ago: shown as stalled.
write("demo-stalled", {
  title: "Demo: stalled task",
  percent: 40,
  detail: "no update for a while",
  started: iso(start - 30 * 60000),
  updated: iso(start - 15 * 60000),
});

function tick() {
  const t = (Date.now() - start) / 1000;

  // 120 files in 60 s, with a count and the time left from the pace.
  const files = Math.min(120, Math.floor(t * 2));
  for (; logged < files; logged += 1) fs.appendFileSync(buildLog, `compiled file ${logged + 1} of 120\n`);
  write("demo-build", {
    title: "Demo: build",
    done: files,
    total: 120,
    unit: "files",
    detail: files < 120 ? `compiling file ${files + 1}` : "all files compiled",
    started: iso(start),
    state: files < 120 ? "running" : "done",
    log: "demo-build.log",
  });

  // Percent only, with the writer's own estimate of the time left.
  const percent = Math.min(100, Math.round((t / 80) * 100));
  write("demo-model", {
    title: "Demo: model training",
    percent,
    eta_seconds: Math.max(0, Math.round(80 - t)),
    detail: `epoch ${Math.min(10, Math.floor(t / 8) + 1)} of 10`,
    started: iso(start),
    state: percent < 100 ? "running" : "done",
  });

  // No progress known: the bar just moves; done after 30 s.
  write("demo-search", {
    title: "Demo: searching the codebase",
    detail: "no progress figure, just alive",
    started: iso(start),
    state: t < 30 ? "running" : "done",
  });

  // Fails after 20 s.
  write("demo-upload", {
    title: "Demo: upload",
    done: Math.min(14, Math.floor(t * 0.7)),
    total: 50,
    unit: "MB",
    detail: t < 20 ? "uploading" : "connection lost",
    started: iso(start),
    state: t < 20 ? "running" : "failed",
  });

  if (t >= 90) {
    clearInterval(timer);
    console.log("Demo finished. The finished tasks stay visible for a few minutes; the demo files are removed in 60 s.");
    setTimeout(() => {
      cleanUp();
      console.log("Demo files removed.");
    }, 60000);
  }
}

process.on("SIGINT", () => {
  cleanUp();
  process.exit(0);
});

console.log(`Demo running for 90 s, writing to ${folder}`);
const timer = setInterval(tick, 1000);
tick();
