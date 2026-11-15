"use strict";
// Pure helpers for the agent-progress command: argument parsing, reading progress out of a
// command's output, ids. Tested with plain `node --test`.

const OPTIONS = {
  id: "string",
  title: "string",
  done: "number",
  total: "number",
  percent: "number",
  unit: "string",
  detail: "string",
  log: "string",
  eta: "number",
  state: "string",
  parse: "flag",
  help: "flag",
};
const STATES = new Set(["running", "done", "failed"]);

/**
 * Splits the arguments into options (`--name value` or `--name=value`), positional words, and
 * the command to run. For `run`, the command is everything after `--`, or else everything from
 * the first word after `run` that is not an option: PowerShell drops `--` when it calls a script,
 * so `run --title T cargo test --release` must work without it.
 * Throws an Error with a readable message on a bad option.
 */
function parseArgs(argv) {
  const options = {};
  const words = [];
  let command = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
    if (arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      if (words[0] === "run") {
        command = argv.slice(i);
        break;
      }
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const type = OPTIONS[name];
    if (!type) throw new Error(`unknown option --${name}`);
    if (type === "flag") {
      options[name] = true;
      continue;
    }
    let value;
    if (eq >= 0) value = arg.slice(eq + 1);
    else {
      i += 1;
      if (i >= argv.length) throw new Error(`--${name} needs a value`);
      value = argv[i];
    }
    if (type === "number") {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n)) throw new Error(`--${name} needs a number, got "${value}"`);
      options[name] = n;
    } else {
      options[name] = value;
    }
  }
  if (options.state !== undefined && !STATES.has(options.state)) {
    throw new Error(`--state is running, done or failed, got "${options.state}"`);
  }
  return { options, words, command };
}

/** The progress file fields given as options. */
function fieldsOf(options) {
  const fields = {};
  for (const name of ["title", "done", "total", "percent", "unit", "detail", "log", "state"]) {
    if (options[name] !== undefined) fields[name] = options[name];
  }
  if (options.eta !== undefined) fields.eta_seconds = options.eta;
  return fields;
}

/** A file-name-safe id: "Build and test" gives "build-and-test". */
function slug(text) {
  const id = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return id || "task";
}

/** Ids name a file in the progress folder: letters, digits, dot, dash and underscore only. */
function isValidId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id);
}

/**
 * The command line to run. A single argument is taken as the whole line ("cargo test --release");
 * several are joined, quoting the ones with spaces.
 */
function commandLine(args) {
  if (args.length === 1) return args[0];
  return args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** A line of output without terminal colors and spaces at both ends. */
function cleanLine(line) {
  return line.replace(ANSI, "").trim();
}

/**
 * Progress read from one line of output: the last "12/100" or "12 of 100" as a count, else the
 * last "45%". Null when the line has neither. Dates like 2026/11/15 are not counts.
 */
function progressFromLine(line) {
  const counts = [...line.matchAll(/(?<![\d/.,])(\d[\d,]*)\s*(?:\/|\bof\b)\s*(\d[\d,]*)(?![\d/])/g)];
  for (const m of counts.reverse()) {
    const done = Number(m[1].replace(/,/g, ""));
    const total = Number(m[2].replace(/,/g, ""));
    if (total > 0 && done <= total) return { done, total };
  }
  const percents = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)];
  for (const m of percents.reverse()) {
    const percent = Number(m[1]);
    if (percent <= 100) return { percent };
  }
  return null;
}

module.exports = { parseArgs, fieldsOf, slug, isValidId, commandLine, cleanLine, progressFromLine };
