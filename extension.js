"use strict";
// Task Progress Bar: watches a folder of small JSON files written by long background tasks
// (an AI agent, a script...) and shows their progress and time left in the status bar, with
// a panel of progress bars. Reads local files only; never touches the network.

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const progress = require("./lib/progress");

const REFRESH_MS = 1000;

let statusItem;
let panel;
let timer;
/** Last known state per task id, to notify once when a task ends. */
const lastState = new Map();
/** Last good parse per task id: a file caught half-written keeps its previous value. */
const lastGood = new Map();

function settings() {
  const config = vscode.workspace.getConfiguration("taskProgress");
  const folder = config.get("folder") || path.join(os.homedir(), ".task-progress");
  return {
    folder,
    staleMinutes: config.get("staleMinutes", 10),
    notify: config.get("notify", true),
    keepFinishedMinutes: config.get("keepFinishedMinutes", 5),
  };
}

/** Every task in the folder, finished ones kept for a few minutes. */
function readTasks(now) {
  const { folder, keepFinishedMinutes } = settings();
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const tasks = [];
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    const file = path.join(folder, name);
    try {
      const stat = fs.statSync(file);
      const task = progress.parseTask(id, fs.readFileSync(file, "utf8"), stat.mtimeMs) ?? lastGood.get(id);
      if (!task) continue;
      lastGood.set(id, task);
      if (task.state !== "running" && now - task.updated > keepFinishedMinutes * 60000) continue;
      tasks.push(task);
    } catch {
      // Removed or locked between listing and reading: next tick.
    }
  }
  return tasks;
}

function notifyEnds(tasks) {
  const { notify } = settings();
  for (const task of tasks) {
    const before = lastState.get(task.id);
    lastState.set(task.id, task.state);
    if (!notify || before !== "running") continue;
    if (task.state === "done") vscode.window.showInformationMessage(`${task.title}: done`);
    if (task.state === "failed") vscode.window.showErrorMessage(`${task.title}: failed`);
  }
}

function refresh() {
  const now = Date.now();
  const { staleMinutes } = settings();
  const tasks = readTasks(now);
  notifyEnds(tasks);
  const text = progress.statusText(tasks, now);
  if (text) {
    statusItem.text = text;
    const lines = tasks.map((task) => {
      const v = progress.view(task, now, staleMinutes);
      const parts = [v.percent === null ? null : `${v.percent}%`, v.left, v.stale ? "no news for a while" : null];
      return `**${v.title}**: ${parts.filter(Boolean).join(", ") || v.state}`;
    });
    statusItem.tooltip = new vscode.MarkdownString(`${lines.join("\n\n")}\n\nClick to open the panel.`);
    statusItem.show();
  } else {
    statusItem.hide();
  }
  if (panel) {
    panel.webview.postMessage({ tasks: tasks.map((task) => progress.view(task, now, staleMinutes)) });
  }
}

function nonce() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

function panelHtml() {
  const n = nonce();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${n}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; }
  .task { padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
  .head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .title { font-weight: 600; font-size: 1.05em; }
  .pct { font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar { height: 8px; border-radius: 4px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.2)); overflow: hidden; margin: 8px 0 6px; }
  .fill { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); transition: width .4s; }
  .done .fill { background: var(--vscode-testing-iconPassed, #3fb950); }
  .failed .fill { background: var(--vscode-errorForeground, #f14c4c); }
  .unknown .fill { width: 30% !important; animation: slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { margin-left: -30%; } to { margin-left: 100%; } }
  .meta { display: flex; justify-content: space-between; gap: 12px; color: var(--vscode-descriptionForeground); font-size: .92em; }
  .left { color: var(--vscode-foreground); }
  .stale { color: var(--vscode-editorWarning-foreground, #cca700); }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="tasks"><p class="empty">No task running.</p></div>
<script nonce="${n}">
  const box = document.getElementById("tasks");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  window.addEventListener("message", (event) => {
    const tasks = event.data.tasks || [];
    if (!tasks.length) { box.innerHTML = '<p class="empty">No task running.</p>'; return; }
    box.innerHTML = tasks.map((t) => {
      const known = t.percent !== null;
      const state = t.state === "running" ? (known ? "" : "unknown") : t.state;
      const right = t.state === "done" ? "done" : t.state === "failed" ? "failed" : known ? t.percent + "%" : "";
      const note = t.stale ? '<span class="stale">no news for ' + esc(t.updatedAgo) + '</span>' : esc(t.detail);
      return '<div class="task ' + state + '">' +
        '<div class="head"><span class="title">' + esc(t.title) + '</span><span class="pct">' + right + '</span></div>' +
        '<div class="bar"><div class="fill" style="width:' + (known ? t.percent : 100) + '%"></div></div>' +
        '<div class="meta"><span>' + esc(t.count) + '</span><span class="left">' + esc(t.left) + '</span></div>' +
        (note ? '<div class="meta"><span>' + note + '</span></div>' : '') +
        '</div>';
    }).join("");
  });
</script>
</body>
</html>`;
}

function showPanel() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel("taskProgress", "Task Progress", vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [],
  });
  panel.webview.html = panelHtml();
  panel.onDidDispose(() => {
    panel = undefined;
  });
  refresh();
}

function clearFinished() {
  const now = Date.now();
  const { folder } = settings();
  for (const task of readTasks(now)) {
    if (task.state === "running") continue;
    try {
      fs.unlinkSync(path.join(folder, `${task.id}.json`));
      lastGood.delete(task.id);
    } catch {
      // Already gone.
    }
  }
  refresh();
}

function openFolder() {
  const { folder } = settings();
  fs.mkdirSync(folder, { recursive: true });
  vscode.env.openExternal(vscode.Uri.file(folder));
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = "Task Progress";
  statusItem.command = "taskProgress.showPanel";
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("taskProgress.showPanel", showPanel),
    vscode.commands.registerCommand("taskProgress.clearFinished", clearFinished),
    vscode.commands.registerCommand("taskProgress.openFolder", openFolder),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("taskProgress")) refresh();
    }),
  );
  // Polling a small folder once a second is cheap and works the same everywhere.
  timer = setInterval(refresh, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh();
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
