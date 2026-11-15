"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const setup = require("../lib/setup");

const SCRIPT = path.join(__dirname, "..", "bin", "agent-progress.js");
const ENV_FIXTURE = path.join(__dirname, "fixtures", "env.js");
const windows = process.platform === "win32";

test("the instructions are added once, then replaced in place", () => {
  const block = setup.instructions(null);
  assert.match(block, /~\/\.agent-progress\/bin\/agent-progress run --title/);
  assert.match(block, /\$HOME\\\.agent-progress\\bin\\agent-progress\.cmd/);

  const added = setup.upsertBlock("# My project\n\nSome rules.\n", block);
  assert.equal(added.replaced, false);
  assert.equal(added.text, `# My project\n\nSome rules.\n\n${block}\n`);

  const newer = block.replace("Long tasks", "Long jobs");
  const again = setup.upsertBlock(`${added.text}\nMore rules after.\n`, newer);
  assert.equal(again.replaced, true);
  assert.equal(again.text.split(setup.START).length, 2, "still one block");
  assert.match(again.text, /Long jobs/);
  assert.match(again.text, /More rules after\.\n$/, "what follows the block is kept");

  assert.equal(setup.upsertBlock("", block).text, `${block}\n`, "an empty or new file");
});

test("the edit touches only the agent section", () => {
  const apply = (text, r) => text.slice(0, r.start) + r.text + text.slice(r.end);
  const block = setup.instructions(null);
  const mine = "# My rules\n\nNever push on Friday.\n";
  const added = setup.upsertBlock(mine, block).text;
  const r1 = setup.changedRange(mine, added);
  assert.equal(apply(mine, r1), added);
  assert.equal(r1.start >= mine.length - 1, true, "nothing before the end of the file is rewritten");
  const updated = setup.upsertBlock(`${added}After.\n`, block.replace("Long tasks", "Long jobs")).text;
  const r2 = setup.changedRange(`${added}After.\n`, updated);
  assert.equal(apply(`${added}After.\n`, r2), updated);
  assert.equal(r2.text.length < 20, true, `only the changed words are replaced, got "${r2.text}"`);
  assert.deepEqual(setup.changedRange("same", "same"), { start: 4, end: 4, text: "" });
});

test("a new Cursor rule starts with its header, an existing one keeps its own", () => {
  const block = setup.instructions(null);
  const created = setup.upsertBlock("", block, setup.CURSOR_RULE_HEADER).text;
  assert.match(created, /^---\ndescription: .+\nalwaysApply: true\n---\n<!-- agent-progress:start -->/);
  const own = "---\ndescription: my rules\nalwaysApply: false\n---\nBe brief.\n";
  const added = setup.upsertBlock(own, block, setup.CURSOR_RULE_HEADER).text;
  assert.equal(added.startsWith(own), true, "the existing header and rules stay first, untouched");
  assert.equal(added.split("alwaysApply").length, 2, "no second header");
});

test("every target names a file and says who reads it", () => {
  const labels = setup.TARGETS.map((t) => t.label);
  assert.deepEqual(labels.slice(0, 2), ["CLAUDE.md", "AGENTS.md"]);
  for (const t of setup.TARGETS) {
    assert.ok(t.description && t.path.length, t.label);
    assert.equal(t.path.join("/"), t.label.replace(/^~\//, ""), `${t.label}: the label is the path`);
  }
});

test("a file with Windows line endings keeps them", () => {
  const out = setup.upsertBlock("# Rules\r\n", setup.instructions(null)).text;
  assert.equal(out.replace(/\r\n/g, "").includes("\n"), false, "no bare \\n added");
});

test("a custom progress folder is written in full in the instructions and the launchers", () => {
  const block = setup.instructions("D:\\work\\progress");
  assert.match(block, /& "D:\\work\\progress\\bin\\agent-progress\.cmd" run/);
  assert.match(block, /"D:\/work\/progress\/bin\/agent-progress" run/);
  const files = setup.launchers({ runtime: "C:\\VS Code\\Code.exe", script: "C:\\ext\\bin\\agent-progress.js", folder: "D:\\work\\progress", windows: true });
  assert.match(files["agent-progress.cmd"], /set "AGENT_PROGRESS_DIR=D:\\work\\progress"/);
  assert.match(files["agent-progress"], /AGENT_PROGRESS_DIR="D:\/work\/progress" exec "C:\/VS Code\/Code\.exe"/);
});

test("the launcher runs the command, and VS Code's switch does not reach the wrapped command", { skip: !windows }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-progress-launcher-"));
  const files = setup.launchers({ runtime: process.execPath, script: SCRIPT, folder: null, windows: true });
  const cmd = path.join(dir, "agent-progress.cmd");
  fs.writeFileSync(cmd, files["agent-progress.cmd"]);
  const env = { ...process.env, AGENT_PROGRESS_DIR: dir };
  // The launcher sets AGENT_PROGRESS_DIR only for a custom folder: here the test's folder wins.
  const r = spawnSync("cmd.exe", ["/d", "/c", cmd, "run", "--title", "Env check", process.execPath, ENV_FIXTURE], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "env-check.json"), "utf8"));
  assert.equal(data.state, "done");
  assert.match(fs.readFileSync(data.log, "utf8"), /^ELECTRON_RUN_AS_NODE=unset$/m);
});
