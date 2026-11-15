"use strict";
// Pure helpers for setting things up: the launchers of the agent-progress command and the
// instructions added to an agent's file (CLAUDE.md, AGENTS.md...). Tested with `node --test`.

const START = "<!-- agent-progress:start -->";
const END = "<!-- agent-progress:end -->";

/**
 * The launchers written in `<progress folder>/bin`. They run the command with VS Code's own
 * runtime (`runtime`, started as plain Node), so Node.js need not be installed, and they are
 * rewritten at each start, so they follow updates of the extension and of VS Code.
 * `folder` is set only when it is not the default one.
 */
function launchers({ runtime, script, folder, windows }) {
  const files = {};
  const slash = (p) => (windows ? p.replace(/\\/g, "/") : p);
  const shDir = folder ? `AGENT_PROGRESS_DIR="${slash(folder)}" ` : "";
  files["agent-progress"] =
    "#!/bin/sh\n" +
    "# Written by the Agent Progress Bar extension at each start: edits are lost.\n" +
    `ELECTRON_RUN_AS_NODE=1 AGENT_PROGRESS_ELECTRON=1 ${shDir}exec "${slash(runtime)}" "${slash(script)}" "$@"\n`;
  if (windows) {
    files["agent-progress.cmd"] =
      "@echo off\r\n" +
      "rem Written by the Agent Progress Bar extension at each start: edits are lost.\r\n" +
      "setlocal\r\n" +
      "set ELECTRON_RUN_AS_NODE=1\r\n" +
      "set AGENT_PROGRESS_ELECTRON=1\r\n" +
      (folder ? `set "AGENT_PROGRESS_DIR=${folder}"\r\n` : "") +
      `"${runtime}" "${script}" %*\r\n`;
  }
  return files;
}

/**
 * The instructions for an agent. `folder` is the progress folder when it is not the default one.
 */
function instructions(folder) {
  const ps = folder ? `& "${folder}\\bin\\agent-progress.cmd"` : '& "$HOME\\.agent-progress\\bin\\agent-progress.cmd"';
  const sh = folder ? `"${folder.replace(/\\/g, "/")}/bin/agent-progress"` : "~/.agent-progress/bin/agent-progress";
  return [
    START,
    "## Long tasks: show their progress",
    "",
    "The user follows long tasks in VS Code with the Agent Progress Bar extension. When you run a command that may take more than a minute, run it through `agent-progress`, so it shows there with its progress and its log:",
    "",
    `- PowerShell: \`${ps} run --title "<what it does>" <command>\``,
    `- bash, zsh: \`${sh} run --title "<what it does>" <command>\``,
    "",
    'Options go before the command. Add `--parse` when the command prints counts like `12/100` or percentages. In a script you write yourself, report progress with `agent-progress set <id> --title "..." --done N --total N`, then `agent-progress done <id>` or `agent-progress fail <id>`. `agent-progress --help` lists the rest.',
    END,
  ].join("\n");
}

/**
 * Puts the instructions in a file's text: replaces the block added before, or adds it at the end.
 * Keeps the file's line endings.
 */
function upsertBlock(text, block) {
  const crlf = text.includes("\r\n");
  const ours = crlf ? block.replace(/\r?\n/g, "\r\n") : block;
  const nl = crlf ? "\r\n" : "\n";
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start >= 0 && end >= 0) {
    return { text: text.slice(0, start) + ours + text.slice(end + END.length), replaced: true };
  }
  if (!text.trim()) return { text: ours + nl, replaced: false };
  const gap = text.endsWith(nl + nl) ? "" : text.endsWith(nl) ? nl : nl + nl;
  return { text: text + gap + ours + nl, replaced: false };
}

/**
 * The smallest edit that turns `before` into `after`: replace `before.slice(start, end)` with
 * `text`. Applied through the editor, it touches only the agent section, and Ctrl+Z undoes it.
 */
function changedRange(before, after) {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start += 1;
  let same = 0;
  while (same < max - start && before[before.length - 1 - same] === after[after.length - 1 - same]) same += 1;
  return { start, end: before.length - same, text: after.slice(start, after.length - same) };
}

module.exports = { START, END, launchers, instructions, upsertBlock, changedRange };
