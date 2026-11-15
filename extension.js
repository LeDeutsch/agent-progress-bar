"use strict";
// Agent Progress Bar: watches a folder of small JSON files written by long background tasks
// (run by an AI agent, a script...) and shows their progress and time left in the status bar, with
// a panel of progress cards next to the terminal. Reads local files only; never touches the network.

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const progress = require("./lib/progress");
const { panelHtml } = require("./lib/panel");
const setup = require("./lib/setup");

const REFRESH_MS = 1000;
const VIEW_ID = "agentProgress.view";

let statusItem;
/** The panel's view, once VS Code has shown it. */
let view;
let timer;
/** Last known state per task id, to notify once when a task ends. */
const lastState = new Map();
/** Last good parse per task id: a file caught half-written keeps its previous value. */
const lastGood = new Map();
/** Progress readings per task id, for the time left from the recent speed. */
const history = new Map();

function settings() {
  const config = vscode.workspace.getConfiguration("agentProgress");
  const standard = path.join(os.homedir(), ".agent-progress");
  const folder = config.get("folder") || standard;
  return {
    folder,
    /** The folder, only when it is not the standard one (instructions and launchers spell it out). */
    customFolder: path.resolve(folder) === path.resolve(standard) ? null : path.resolve(folder),
    staleMinutes: config.get("staleMinutes", 10),
    notify: config.get("notify", true),
    keepFinishedMinutes: config.get("keepFinishedMinutes", progress.KEEP_FINISHED_MINUTES),
    deleteAfterHours: config.get("deleteFilesAfterHours", 24),
  };
}

/** Deletes an old task's progress file, and its log when the log is in the progress folder. */
function deleteOld(task, folder) {
  try {
    fs.unlinkSync(path.join(folder, `${task.id}.json`));
    if (task.log && progress.isInside(folder, logPath(task.log))) fs.rmSync(logPath(task.log), { force: true });
  } catch {
    // Locked or already gone: next time.
  }
  forget(task.id);
}

/**
 * Every task in the folder, finished ones kept for a few minutes. Files with no update for a day
 * (the setting) are deleted on the way, so the folder does not fill up.
 */
function readTasks(now) {
  const { folder, keepFinishedMinutes, deleteAfterHours } = settings();
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
      if (progress.isOld(task, now, deleteAfterHours)) {
        deleteOld(task, folder);
        continue;
      }
      lastGood.set(id, task);
      task.samples = progress.addSample(history.get(id) || [], task, now);
      history.set(id, task.samples);
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
  const { staleMinutes, keepFinishedMinutes } = settings();
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
  if (view && view.visible) {
    view.webview.postMessage({
      confirm: pending ? { question: pending.question, ok: pending.ok } : null,
      summary: progress.summaryText(tasks, now, staleMinutes),
      tasks: progress
        .panelOrder(tasks, now, staleMinutes)
        .map((task) => progress.view(task, now, staleMinutes, keepFinishedMinutes)),
    });
  }
}

function nonce() {
  return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

/** A task's log path: "~/" is the home folder, a relative path starts from the progress folder. */
function logPath(log) {
  if (log === "~" || log.startsWith("~/") || log.startsWith("~\\")) return path.join(os.homedir(), log.slice(1));
  return path.resolve(settings().folder, log);
}

async function openLog(task) {
  const file = logPath(task.log);
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    // The latest lines are what the agent is doing now.
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end));
  } catch {
    vscode.window.showWarningMessage(`${task.title}: cannot open the log ${file}`);
  }
}

function forget(id) {
  lastGood.delete(id);
  lastState.delete(id);
  history.delete(id);
}

/** Deletes a task's progress file. Running tasks are left alone: they would come back. */
function removeTask(task, now) {
  if (progress.kindOf(task, now, settings().staleMinutes) === "running") return;
  try {
    fs.unlinkSync(path.join(settings().folder, `${task.id}.json`));
  } catch {
    // Already gone.
  }
  forget(task.id);
}

/**
 * Writes the launchers of the agent-progress command in `<progress folder>/bin`, the place the
 * agent instructions point to. Rewritten at each start to follow updates; returns the folder.
 */
function installLaunchers(context) {
  const { folder, customFolder } = settings();
  const dir = path.join(folder, "bin");
  const files = setup.launchers({
    // The extension host runs on VS Code's own runtime: it serves as Node for the command.
    runtime: process.execPath,
    script: path.join(context.extensionPath, "bin", "agent-progress.js"),
    folder: customFolder,
    windows: process.platform === "win32",
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(dir, name);
      let current = null;
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        // Not there yet.
      }
      if (current !== text) fs.writeFileSync(file, text, { mode: 0o755 });
    }
  } catch {
    // Without launchers the panel still works; the instructions tell how to write files directly.
  }
  return dir;
}

/** Text of the previews shown before adding the agent instructions, by preview path. */
const previews = new Map();
let previewCount = 0;
const PREVIEW_SCHEME = "agent-progress-preview";

function previewUri(name, text) {
  previewCount += 1;
  const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${previewCount}/${name}` });
  previews.set(uri.path, text);
  return uri;
}

async function closePreview(...uris) {
  const [modified] = uris;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === modified.toString()) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }
  for (const uri of uris) if (uri.scheme === PREVIEW_SCHEME) previews.delete(uri.path);
}

/** The question waiting while a preview is open: { question, ok, preview, settle(answer) }. */
let pending = null;

/**
 * Asks to confirm a change shown in the preview `previewUri`. The answer comes from the first of:
 * the Add or Cancel buttons in the panel, the check and cross above the preview, the Cancel of the
 * notification, or closing the preview (Cancel). Resolves with "ok" or "cancel".
 */
function ask(question, ok, previewUri) {
  if (pending) pending.settle("cancel");
  return new Promise((resolve) => {
    let settled = false;
    let closeNote = null;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      pending = null;
      vscode.commands.executeCommand("setContext", "agentProgress.pending", false);
      if (closeNote) closeNote();
      refresh();
      resolve(answer);
    };
    pending = { question, ok, preview: previewUri.toString(), settle };
    vscode.commands.executeCommand("setContext", "agentProgress.pending", true);
    if (view) view.show(true);
    refresh();
    // A progress notification closes itself once answered: no button left behind that does nothing.
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${question} ${ok} or Cancel in the Agent Progress panel.`, cancellable: true },
      (_progress, token) =>
        new Promise((done) => {
          if (settled) return done();
          closeNote = done;
          token.onCancellationRequested(() => settle("cancel"));
        }),
    );
  });
}

/**
 * Adds the agent instructions to the file the user picks. Nothing is written before the user has
 * seen the change side by side and clicked Add; the edit goes through the editor, so Ctrl+Z undoes
 * it, and a file open with unsaved changes keeps them.
 */
async function addInstructions() {
  const block = setup.instructions(settings().customFolder);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const choices = [];
  for (const t of setup.TARGETS) {
    if (!t.home && !root) continue;
    const file = path.join(t.home ? os.homedir() : root, ...t.path);
    const exists = fs.existsSync(file);
    const detail = exists ? `Adds a section at the end of ${file}` : `Creates ${file}`;
    choices.push({ label: t.label, description: t.description, detail, file, exists, header: t.header || "" });
  }
  choices.push({ label: "Copy to clipboard", description: "Paste it where your agent reads its instructions", file: null });
  const pick = await vscode.window.showQuickPick(choices, {
    title: "Add agent instructions",
    placeHolder: "Which file does your AI agent read? You will see the change before anything is written.",
  });
  if (!pick) return;
  if (!pick.file) {
    await vscode.env.clipboard.writeText(block);
    vscode.window.showInformationMessage("Agent instructions copied.");
    return;
  }

  const uri = vscode.Uri.file(pick.file);
  const name = path.basename(pick.file);
  try {
    const doc = pick.exists ? await vscode.workspace.openTextDocument(uri) : null;
    // An open file with unsaved changes: the preview and the edit start from what the editor shows.
    const before = doc ? doc.getText() : "";
    const { text: after, replaced } = setup.upsertBlock(before, block, pick.header);
    if (after === before) {
      vscode.window.showInformationMessage(`The agent instructions in ${pick.label} are already up to date.`);
      return;
    }

    const proposed = previewUri(name, after);
    const current = doc ? uri : previewUri(name, "");
    await vscode.commands.executeCommand("vscode.diff", current, proposed, `${pick.label}: now / with the agent instructions`, { preview: true });
    const question = replaced ? `Update the agent instructions in ${pick.label}?` : `Add these lines to ${pick.label}?`;
    const answer = await ask(question, replaced ? "Update" : "Add", proposed);
    await closePreview(proposed, current);
    if (answer !== "ok") return;
    const now = doc ? doc.getText() : fs.existsSync(pick.file) ? null : "";
    if (now !== before) {
      vscode.window.showWarningMessage(`${pick.label} changed while the preview was open: nothing was written. Try again.`);
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    if (!doc) {
      fs.mkdirSync(path.dirname(pick.file), { recursive: true });
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), after);
    } else {
      const change = setup.changedRange(before, after);
      edit.replace(uri, new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.text);
    }
    const wasDirty = Boolean(doc && doc.isDirty);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code refused the edit");
    const result = await vscode.workspace.openTextDocument(uri);
    // Saved, unless the user had unsaved changes of their own in that file: those stay theirs to save.
    if (!wasDirty) await result.save();
    const editor = await vscode.window.showTextDocument(result, { preview: false });
    const at = result.positionAt(result.getText().indexOf(setup.START));
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
    const done = replaced ? "updated in" : "added to";
    const note = wasDirty ? " The file has unsaved changes: save it to keep them." : " Ctrl+Z in the editor undoes it.";
    vscode.window.showInformationMessage(`Agent instructions ${done} ${pick.label}.${note}`);
  } catch (error) {
    vscode.window.showWarningMessage(`Could not change ${pick.file}: ${error.message}`);
  }
}

let extensionUri;
let extensionId;

/** The Settings editor, showing only this extension's settings. */
function openSettings() {
  vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionId}`);
}

function howItWorks() {
  const guide = vscode.Uri.joinPath(extensionUri, "media", "how-it-works.md");
  vscode.commands.executeCommand("markdown.showPreview", guide).then(undefined, () => vscode.window.showTextDocument(guide));
}

function onViewMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.cmd === "ready") return refresh();
  if (message.cmd === "setup") return addInstructions();
  if (message.cmd === "guide") return howItWorks();
  if (message.cmd === "confirm") return pending?.settle("ok");
  if (message.cmd === "cancel") return pending?.settle("cancel");
  // Only ids read from the folder are accepted.
  const task = typeof message.id === "string" ? lastGood.get(message.id) : undefined;
  if (!task) return;
  if (message.cmd === "log" && task.log) openLog(task);
  if (message.cmd === "remove") {
    removeTask(task, Date.now());
    refresh();
  }
}

const viewProvider = {
  resolveWebviewView(webviewView) {
    view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = panelHtml(nonce());
    webviewView.webview.onDidReceiveMessage(onViewMessage);
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) refresh();
    });
    webviewView.onDidDispose(() => {
      if (view === webviewView) view = undefined;
    });
  },
};

function showPanel() {
  vscode.commands.executeCommand(`${VIEW_ID}.focus`);
}

function clearFinished() {
  const now = Date.now();
  for (const task of readTasks(now)) {
    if (task.state !== "running") removeTask(task, now);
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
    vscode.window.registerWebviewViewProvider(VIEW_ID, viewProvider),
    vscode.commands.registerCommand("agentProgress.showPanel", showPanel),
    vscode.commands.registerCommand("agentProgress.clearFinished", clearFinished),
    vscode.commands.registerCommand("agentProgress.openFolder", openFolder),
    vscode.commands.registerCommand("agentProgress.addInstructions", addInstructions),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent: (uri) => previews.get(uri.path) ?? "",
    }),
    vscode.commands.registerCommand("agentProgress.howItWorks", howItWorks),
    vscode.commands.registerCommand("agentProgress.openSettings", openSettings),
    vscode.commands.registerCommand("agentProgress.confirmAdd", () => pending?.settle("ok")),
    vscode.commands.registerCommand("agentProgress.cancelAdd", () => pending?.settle("cancel")),
    // Closing the preview answers Cancel.
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (!pending) return;
      for (const tab of event.closed) {
        if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === pending.preview) {
          pending.settle("cancel");
          return;
        }
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("agentProgress")) refresh();
    }),
  );
  extensionUri = context.extensionUri;
  extensionId = context.extension.id;
  // The agent-progress command: launchers in a fixed place, and in every terminal VS Code opens.
  const launchers = installLaunchers(context);
  const terminals = context.environmentVariableCollection;
  terminals.description = "Adds the agent-progress command (Agent Progress Bar).";
  terminals.prepend("PATH", launchers + path.delimiter);
  // Polling a small folder once a second is cheap and works the same everywhere.
  timer = setInterval(refresh, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh();
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
