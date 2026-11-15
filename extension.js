"use strict";
// Agent Progress Bar: watches a folder of small JSON files written by long background tasks
// (run by an AI agent, a script...) and shows their progress and time left in the status bar, with
// a panel of progress bars. Reads local files only; never touches the network.

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const progress = require("./lib/progress");
const { panelHtml } = require("./lib/panel");

const REFRESH_MS = 1000;

let statusItem;
let panel;
let timer;
/** Last known state per task id, to notify once when a task ends. */
const lastState = new Map();
/** Last good parse per task id: a file caught half-written keeps its previous value. */
const lastGood = new Map();

function settings() {
  const config = vscode.workspace.getConfiguration("agentProgress");
  const folder = config.get("folder") || path.join(os.homedir(), ".agent-progress");
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
  const text = progress.statusText(tasks, now, staleMinutes);
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
    panel.webview.postMessage({
      summary: progress.summaryText(tasks, now, staleMinutes),
      tasks: progress.panelOrder(tasks, now, staleMinutes).map((task) => progress.view(task, now, staleMinutes)),
    });
  }
}

function nonce() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

function showPanel() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel("agentProgress", "Agent Progress", vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [],
  });
  panel.webview.html = panelHtml(nonce());
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
  statusItem.name = "Agent Progress";
  statusItem.command = "agentProgress.showPanel";
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("agentProgress.showPanel", showPanel),
    vscode.commands.registerCommand("agentProgress.clearFinished", clearFinished),
    vscode.commands.registerCommand("agentProgress.openFolder", openFolder),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentProgress")) refresh();
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
