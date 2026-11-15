"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const cli = require("../lib/cli");
const progress = require("../lib/progress");

const BIN = path.join(__dirname, "..", "bin", "agent-progress.js");
const STEPS = path.join(__dirname, "fixtures", "steps.js");

/** Runs the real command with its own progress folder, never the user's. */
function agentProgress(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-progress-test-"));
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, AGENT_PROGRESS_DIR: dir },
    encoding: "utf8",
  });
  return { ...result, dir };
}

function again(dir, args) {
  return spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, AGENT_PROGRESS_DIR: dir }, encoding: "utf8" });
}

const readJson = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));

test("options, words and the command after --", () => {
  const { options, words, command } = cli.parseArgs(["run", "--title", "Tests", "--parse", "--done=3", "--", "cargo", "test", "--release"]);
  assert.deepEqual(words, ["run"]);
  assert.deepEqual(options, { title: "Tests", parse: true, done: 3 });
  assert.deepEqual(command, ["cargo", "test", "--release"]);
  // PowerShell drops the "--": the command starts at the first word after run and its options.
  const bare = cli.parseArgs(["run", "--title", "Tests", "cargo", "test", "--release"]);
  assert.deepEqual([bare.options, bare.words, bare.command], [{ title: "Tests" }, ["run"], ["cargo", "test", "--release"]]);
  assert.throws(() => cli.parseArgs(["set", "a", "--total", "lots"]), /--total needs a number/);
  assert.throws(() => cli.parseArgs(["set", "a", "--colour", "red"]), /unknown option --colour/);
  assert.throws(() => cli.parseArgs(["set", "a", "--state", "paused"]), /running, done, failed or ended/);
});

test("progress is read from the output, dates are not counts", () => {
  assert.deepEqual(cli.progressFromLine("Lucas : 2844/2904 prises, 0.45 s"), { done: 2844, total: 2904 });
  assert.deepEqual(cli.progressFromLine("Lucas: 1,728 / 2,904 left"), { done: 1728, total: 2904 });
  assert.deepEqual(cli.progressFromLine("test 12 of 340 passed"), { done: 12, total: 340 });
  assert.deepEqual(cli.progressFromLine("[=====>    ] 45%"), { percent: 45 });
  assert.equal(cli.progressFromLine("built on 2026/11/15"), null);
  assert.equal(cli.progressFromLine("compiling voxwheel"), null);
});

test("ids and command lines", () => {
  assert.equal(cli.slug("Build and test!"), "build-and-test");
  assert.equal(cli.slug("cargo test --release"), "cargo-test-release");
  assert.equal(cli.slug("***"), "task");
  assert.equal(cli.isValidId("../secret"), false);
  assert.equal(cli.isValidId("voice-packs_2.1"), true);
  assert.equal(cli.commandLine(["cargo test --release"]), "cargo test --release");
  assert.equal(cli.commandLine(["C:\\Program Files\\nodejs\\node.exe", "a.js"]), '"C:\\Program Files\\nodejs\\node.exe" a.js');
});

test("run shows the command, keeps its output as the log, and ends done", () => {
  const r = agentProgress(["run", "--title", "Steps", "--parse", "--unit", "steps", "--", process.execPath, STEPS, "0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /step 3 of 3/, "the output still reaches the terminal");
  const data = readJson(r.dir, "steps");
  assert.equal(data.state, "done");
  assert.equal(data.title, "Steps");
  assert.deepEqual([data.done, data.total, data.unit], [3, 3, "steps"]);
  assert.match(data.detail, /^finished in \d+ s$/, "a success says how long it took, not its last line");
  const log = fs.readFileSync(data.log, "utf8");
  assert.match(log, /starting/);
  assert.match(log, /warning: something/, "stderr goes to the log too");
  // What the extension makes of it.
  const task = progress.parseTask("steps", JSON.stringify(data), Date.now());
  assert.equal(progress.percentOf(task), 100);
  assert.equal(progress.view(task, Date.now(), 10).hasLog, true);
});

test("run reports a failure with its exit code and passes the code on", () => {
  // Without "--", as PowerShell passes it.
  const r = agentProgress(["run", "--id", "broken", process.execPath, STEPS, "3"]);
  assert.equal(r.status, 3, "the exit code of the command");
  const data = readJson(r.dir, "broken");
  assert.equal(data.state, "failed");
  assert.equal(data.detail, "exit code 3: step 3 of 3");
});

test("set keeps what it is not given; done and remove", () => {
  const first = agentProgress(["set", "build", "--title", "Build", "--done", "3", "--total", "10", "--unit", "files"]);
  assert.equal(first.status, 0, first.stderr);
  const before = readJson(first.dir, "build");
  assert.equal(before.state, "running");
  assert.ok(before.started, "a start time is set on the first call");
  assert.equal(again(first.dir, ["set", "build", "--done", "7"]).status, 0);
  const after = readJson(first.dir, "build");
  assert.deepEqual([after.title, after.done, after.total, after.unit, after.started], ["Build", 7, 10, "files", before.started]);
  assert.equal(again(first.dir, ["done", "build", "--detail", "all built"]).status, 0);
  assert.deepEqual([readJson(first.dir, "build").state, readJson(first.dir, "build").detail], ["done", "all built"]);
  assert.equal(again(first.dir, ["remove", "build"]).status, 0);
  assert.equal(fs.existsSync(path.join(first.dir, "build.json")), false);
  assert.equal(fs.readdirSync(first.dir).length, 0, "no temporary file left behind");
});

test("a bad call says what is wrong and changes nothing", () => {
  const r = agentProgress(["set", "../outside", "--done", "1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a valid id/);
  assert.equal(fs.readdirSync(r.dir).length, 0);
});
