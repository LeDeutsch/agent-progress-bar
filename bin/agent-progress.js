#!/usr/bin/env node
"use strict";
// agent-progress: shows a task in the Agent Progress Bar extension without writing JSON by hand.
// See `agent-progress --help`. Writes files in ~/.agent-progress (or $AGENT_PROGRESS_DIR) only.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cli = require("../lib/cli");
const { formatDuration } = require("../lib/progress");

const HELP = `agent-progress: show a task in the Agent Progress Bar extension.

Wrap a command (the card shows it running, its output is the log, done or failed at the end):
  agent-progress run [--title T] [--id ID] [--parse] [--unit U] [--log FILE] <command...>
    --parse    read progress from the output: the last "12/100", "12 of 100" or "45%"
  Options go before the command; from the command on, everything is the command's own
  ("agent-progress run --title Tests cargo test --release"). A "--" before it works too.

Report progress yourself:
  agent-progress set <id> [--title T] [--done N --total N | --percent P] [--unit U]
                          [--detail D] [--log FILE] [--eta SECONDS] [--state running|done|failed]
  agent-progress done <id> [--detail D]
  agent-progress fail <id> [--detail D]
  agent-progress remove <id>

set keeps the fields it is not given, so "set build --done 42" is enough after the first call.
Files go in ~/.agent-progress (AGENT_PROGRESS_DIR to change it).`;

function folder() {
  return process.env.AGENT_PROGRESS_DIR || path.join(os.homedir(), ".agent-progress");
}

function fileOf(id) {
  return path.join(folder(), `${id}.json`);
}

function read(id) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes the progress file in one go: a temporary file, then a rename over the old one. */
function write(id, data) {
  fs.mkdirSync(folder(), { recursive: true });
  const file = fileOf(id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      // Windows refuses the rename while the extension is reading the old file: try again.
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) {
        fs.rmSync(tmp, { force: true });
        throw error;
      }
      pause(25);
    }
  }
}

function now() {
  return new Date().toISOString();
}

function needId(words) {
  const id = words[1];
  if (!id) throw new Error(`${words[0]} needs a task id`);
  if (!cli.isValidId(id)) throw new Error(`"${id}" is not a valid id: letters, digits, dot, dash, underscore`);
  return id;
}

function set(id, fields) {
  const data = { ...read(id), ...fields };
  if (fields.log) data.log = path.resolve(fields.log);
  if (!data.started) data.started = now();
  if (!data.state) data.state = "running";
  data.updated = now();
  write(id, data);
}

function run(options, args) {
  if (!args.length) throw new Error("run needs a command after --");
  const line = cli.commandLine(args);
  const id = options.id || cli.slug(options.title || line);
  if (!cli.isValidId(id)) throw new Error(`"${id}" is not a valid id: letters, digits, dot, dash, underscore`);
  const log = options.log ? path.resolve(options.log) : path.join(folder(), `${id}.log`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const logStream = fs.createWriteStream(log);
  logStream.write(`$ ${line}\n`);

  const startedAt = Date.now();
  const data = { title: options.title || line, started: new Date(startedAt).toISOString(), state: "running", log, detail: "" };
  if (options.unit) data.unit = options.unit;
  const save = () => {
    data.updated = now();
    try {
      write(id, data);
    } catch {
      // The command matters more than its progress card: keep going.
    }
  };
  save();

  let pending = "";
  let lastLine = "";
  const onOutput = (chunk, target) => {
    target.write(chunk);
    logStream.write(chunk);
    pending += chunk.toString("utf8");
    // Progress bars redraw with \r: each piece is a line of its own.
    const pieces = pending.split(/\r\n|\r|\n/);
    pending = pieces.pop();
    if (pending.length > 4096) pending = pending.slice(-4096);
    for (const piece of pieces) {
      const text = cli.cleanLine(piece);
      if (!text) continue;
      lastLine = text;
      if (options.parse) {
        const found = cli.progressFromLine(text);
        if (found) {
          delete data.done;
          delete data.total;
          delete data.percent;
          Object.assign(data, found);
        }
      }
    }
    data.detail = lastLine.slice(0, 160);
  };

  // Started by the extension's launcher with VS Code's runtime: that switch must not reach the
  // command, or an Electron app it starts would run as plain Node.
  const env = { ...process.env };
  if (env.AGENT_PROGRESS_ELECTRON === "1") {
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.AGENT_PROGRESS_ELECTRON;
  }
  const child = spawn(line, { shell: true, env, stdio: ["inherit", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => onOutput(chunk, process.stdout));
  child.stderr.on("data", (chunk) => onOutput(chunk, process.stderr));
  // Rewritten every 2 s even when the command is silent: the card never looks stalled while it runs.
  const timer = setInterval(save, 2000);
  // Ctrl+C reaches the command too; wait for it to stop and report how it ended.
  process.on("SIGINT", () => {});

  let ended = false;
  const end = (code, detail) => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    data.state = code === 0 ? "done" : "failed";
    data.detail = detail;
    save();
    logStream.end(() => {
      process.exitCode = code;
    });
  };
  child.on("error", (error) => end(127, `could not start: ${error.message}`));
  child.on("close", (code, signal) => {
    const tail = cli.cleanLine(pending) || lastLine;
    // The last line of a successful command often says little ("0 passed" of cargo's doc tests):
    // the time it took says more, and Open log has the rest.
    if (code === 0) end(0, `finished in ${formatDuration((Date.now() - startedAt) / 1000)}`);
    else {
      const how = code === null ? `stopped (${signal})` : `exit code ${code}`;
      end(code === null ? 1 : code, tail ? `${how}: ${tail}`.slice(0, 160) : how);
    }
  });
}

function main(argv) {
  const { options, words, command } = cli.parseArgs(argv);
  const action = words[0];
  if (options.help || !action) {
    console.log(HELP);
    return;
  }
  const fields = cli.fieldsOf(options);
  switch (action) {
    case "run":
      return run(options, command);
    case "set":
      return set(needId(words), fields);
    case "done":
      return set(needId(words), { ...fields, state: "done" });
    case "fail":
      return set(needId(words), { ...fields, state: "failed" });
    case "remove":
      return fs.rmSync(fileOf(needId(words)), { force: true });
    default:
      throw new Error(`unknown action "${action}" (run, set, done, fail, remove)`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`agent-progress: ${error.message}`);
  process.exitCode = 2;
}
