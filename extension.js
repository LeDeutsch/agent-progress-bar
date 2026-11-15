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
const claude = require("./lib/claude");
const agents = require("./lib/agents");
const { AGENTS: hookAgents } = require("./lib/hook");

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
    showAfterSeconds: config.get("commandsShowAfterSeconds", 20),
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
  const { folder, keepFinishedMinutes, deleteAfterHours, showAfterSeconds } = settings();
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
      const shown = progress.isShown(task, now, showAfterSeconds);
      countAgent(task, shown);
      // A command found on its own that was quick: never shown, its file goes at once.
      if (!shown) {
        if (task.state !== "running") {
          fs.rmSync(file, { force: true });
          forget(id);
        }
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
    if (task.state === "ended") vscode.window.showInformationMessage(`${task.title}: ended`);
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
    const states = agentStates();
    view.webview.postMessage({
      confirm: pending ? { question: pending.question, ok: pending.ok } : null,
      agents: states,
      connectButton: agents.connectButton(states),
      connectedText: agents.connectedText(states),
      page,
      connections: page === "connections" ? connectionRows(now) : [],
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
  try {
    const doc = pick.exists ? await vscode.workspace.openTextDocument(uri) : null;
    // An open file with unsaved changes: the preview and the edit start from what the editor shows.
    const before = doc ? doc.getText() : "";
    const { text: after, replaced } = setup.upsertBlock(before, block, pick.header);
    if (after === before) {
      vscode.window.showInformationMessage(`The agent instructions in ${pick.label} are already up to date.`);
      return;
    }

    const question = replaced ? `Update the agent instructions in ${pick.label}?` : `Add these lines to ${pick.label}?`;
    const done = replaced ? "updated in" : "added to";
    await previewAndWrite({
      file: pick.file,
      label: pick.label,
      doc,
      before,
      after,
      title: `${pick.label}: now / with the agent instructions`,
      question,
      ok: replaced ? "Update" : "Add",
      revealAt: setup.START,
      doneText: `Agent instructions ${done} ${pick.label}.`,
    });
  } catch (error) {
    vscode.window.showWarningMessage(`Could not change ${pick.file}: ${error.message}`);
  }
}

/**
 * Shows a change to `file` side by side (now / after), and writes it only once the user agrees.
 * The edit goes through the editor, so Ctrl+Z undoes it, and an open file with unsaved changes
 * keeps them. `after` null deletes the file (one the extension wrote whole). Returns true when written.
 */
async function previewAndWrite({ file, label, doc, before, after, title, question, ok, revealAt, doneText }) {
  const uri = vscode.Uri.file(file);
  const name = path.basename(file);
  const proposed = previewUri(name, after === null ? "" : after);
  const current = doc ? uri : previewUri(name, "");
  await vscode.commands.executeCommand("vscode.diff", current, proposed, title, { preview: true });
  const answer = await ask(question, ok, proposed);
  await closePreview(proposed, current);
  if (answer !== "ok") return false;
  const now = doc ? doc.getText() : fs.existsSync(file) ? null : "";
  if (now !== before) {
    vscode.window.showWarningMessage(`${label} changed while the preview was open: nothing was written. Try again.`);
    return false;
  }

  const edit = new vscode.WorkspaceEdit();
  if (after === null) {
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code refused to delete it");
    vscode.window.showInformationMessage(doneText);
    return true;
  }
  if (!doc) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
  const found = revealAt ? result.getText().indexOf(revealAt) : -1;
  const at = result.positionAt(Math.max(0, found));
  editor.selection = new vscode.Selection(at, at);
  editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
  const note = wasDirty ? " The file has unsaved changes: save it to keep them." : " Ctrl+Z in the editor undoes it.";
  vscode.window.showInformationMessage(`${doneText}${note}`);
  return true;
}

/** Where the tools keep their files: the home folder and the variables that move them. */
function where() {
  return { home: os.homedir(), env: process.env };
}

/** Whether Claude Code has Git Bash to run hooks with (always "yes" outside Windows). */
function hasBash() {
  return process.platform !== "win32" || claude.hasGitBash(process.env, (file) => fs.existsSync(file));
}

/** How the tools call the hook on this machine: the launchers' folder, the system, the shell. */
function hookCall() {
  return { bin: path.join(settings().folder, "bin"), windows: process.platform === "win32", bash: hasBash() };
}

/** Whether a tool is on this computer: its folder, or for Copilot its VS Code extension too. */
function isInstalled(agent) {
  if (fs.existsSync(agent.home(where()))) return true;
  return agent.id === "copilot" && Boolean(vscode.extensions && vscode.extensions.getExtension("GitHub.copilot-chat"));
}

/**
 * Each tool on this computer with its state: "connected" (its hooks file holds the panel's
 * hooks) or "available". Tools that are not there are left out. Files are read again only when
 * they change.
 */
function agentStates() {
  return agents.AGENTS.filter(isInstalled).map((agent) => ({
    id: agent.id,
    name: agent.name,
    state: cached(agent.file(where()), (text) => agents.isConnected(text)) ? "connected" : "available",
  }));
}

/** The page the panel shows: the tasks, or the Connections (the account button above the panel). */
let page = "tasks";

function showPage(next) {
  page = next;
  refresh();
}

function toggleConnections() {
  page = page === "connections" ? "tasks" : "connections";
  if (view) view.show(false);
  else showPanel();
  refresh();
}

/** Reads a small file again only when it changes: { file: { mtime, value } }. */
const fileCache = new Map();
function cached(file, read) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const hit = fileCache.get(file);
    if (hit && hit.mtime === mtime) return hit.value;
    const value = read(fs.readFileSync(file, "utf8"));
    fileCache.set(file, { mtime, value });
    return value;
  } catch {
    return read("");
  }
}

/** The Connections page: one row per tool on this computer, Claude Code first. */
function connectionRows(now) {
  const day = dayOf(now);
  return agentStates().map(({ id, state }) => {
    const agent = agents.byId(id);
    const today = stats && stats.day === day && stats.tools[id] ? stats.tools[id] : null;
    return agents.rowOf(agent, {
      state,
      // The account Claude Code is signed in with: its name and its address, masked.
      account: id === "claude" ? cached(path.join(os.homedir(), ".claude.json"), (text) => claude.account(text)) : null,
      stats: today ? { seen: today.seen.length, shown: today.shown.length, last: today.last } : { seen: 0, shown: 0, last: null },
      shell: id === "claude" ? claude.shellName(cached(agent.file(where()), (text) => text), { windows: process.platform === "win32", bash: hasBash() }) : "",
      now,
      formatDuration: progress.formatDuration,
    });
  });
}

/** Today's commands of each tool, for the Connections page: { day, tools: { id: { seen: [ids], shown: [ids], last } } }. */
const STATS_KEY = "agentProgress.agentsToday";
let stats = null;

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Counts a command of a tool (a "claude-", "codex-"... card) the first time it is seen, and once shown. */
function countAgent(task, shown) {
  const agent = Object.entries(hookAgents).find(([, a]) => task.id.startsWith(a.prefix));
  if (!agent || task.started === null) return;
  const day = dayOf(task.started);
  if (day !== dayOf(Date.now())) return;
  if (!stats || stats.day !== day) stats = { day, tools: {} };
  const today = (stats.tools[agent[0]] ||= { seen: [], shown: [], last: null });
  let changed = false;
  if (!today.seen.includes(task.id)) {
    today.seen.push(task.id);
    changed = true;
  }
  if (shown && !today.shown.includes(task.id)) {
    today.shown.push(task.id);
    changed = true;
  }
  if (!today.last || task.started > today.last.at) {
    today.last = { title: task.title, at: task.started };
    changed = true;
  }
  if (changed && memory) memory.update(STATS_KEY, stats);
}

/**
 * Connects a tool: adds hooks to its settings so every command it runs is seen, and the ones
 * that last show in the panel on their own. Shown side by side first; nothing is written before Connect.
 */
async function connectAgent(id) {
  const agent = agents.byId(id);
  if (!agent) return;
  const doneText = `${agent.name} connected: the commands it runs from now on show here once they last.${agent.trust ? ` ${agent.trust}.` : ""}`;
  await changeAgent(agent, (text) => agent.connect(text, hookCall()), {
    title: `${agent.label}: now / connected`,
    question: `Connect ${agent.name}? Its commands that last will show here on their own.`,
    ok: "Connect",
    doneText,
    same: `${agent.name} is already connected.`,
  });
}

/** Takes the hooks out of a tool's settings (or deletes the file the panel wrote whole), shown side by side first. */
async function disconnectAgent(id) {
  const agent = agents.byId(id);
  if (!agent) return;
  await changeAgent(agent, (text) => (agents.isConnected(text) ? agent.disconnect(text) : text), {
    title: `${agent.label}: now / disconnected`,
    question: `Disconnect ${agent.name}?`,
    ok: "Disconnect",
    doneText: `${agent.name} disconnected.`,
    same: `${agent.name} is not connected.`,
  });
}

/** Picks a tool on this computer to connect or disconnect (Command Palette). */
async function pickAgent(wanted, action) {
  const choices = agentStates()
    .filter((s) => s.state === wanted)
    .map((s) => ({ label: s.name, id: s.id }));
  if (!choices.length) {
    vscode.window.showInformationMessage(wanted === "available" ? "Every agent found on this computer is connected." : "No agent is connected.");
    return;
  }
  const pick = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: wanted === "available" ? "Connect an agent" : "Disconnect an agent" });
  if (pick) await action(pick.id);
}

async function changeAgent(agent, change, { title, question, ok, doneText, same }) {
  const file = agent.file(where());
  try {
    const exists = fs.existsSync(file);
    const doc = exists ? await vscode.workspace.openTextDocument(vscode.Uri.file(file)) : null;
    const before = doc ? doc.getText() : "";
    let after;
    try {
      after = change(before);
    } catch {
      vscode.window.showWarningMessage(`${agent.label} is not plain JSON: nothing was changed. The README shows the hooks to add by hand.`);
      return;
    }
    if (after === before || (after === null && !exists)) {
      vscode.window.showInformationMessage(same);
      return;
    }
    await previewAndWrite({ file, label: agent.label, doc, before, after, title, question, ok, revealAt: '"hooks"', doneText });
    fileCache.delete(file);
    refresh();
  } catch (error) {
    vscode.window.showWarningMessage(`Could not change ${file}: ${error.message}`);
  }
}

let extensionUri;
let extensionId;

/** The Settings editor, showing only this extension's settings. */
function openSettings() {
  vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${extensionId}`);
}

/** VS Code's own view containers: the terminal's, and the panel tab this extension adds. */
const TERMINAL_CONTAINER = "terminal";
const OWN_CONTAINER = "workbench.view.extension.agentProgress";
const BESIDE_KEY = "agentProgress.besideTerminal";
let memory;

/**
 * Puts the panel beside the terminal (both side by side in the bottom panel), or back in its own
 * tab. Uses VS Code's "vscode.moveViews" command (not in the public API: it could change); if it
 * fails, VS Code's "Move View" chooser lets the user pick the place instead.
 */
async function toggleBesideTerminal() {
  const beside = memory.get(BESIDE_KEY, false);
  try {
    await vscode.commands.executeCommand("vscode.moveViews", {
      viewIds: [VIEW_ID],
      destinationId: beside ? OWN_CONTAINER : TERMINAL_CONTAINER,
    });
    await setBeside(!beside);
    if (!beside) vscode.commands.executeCommand("workbench.action.terminal.focus");
  } catch {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await vscode.commands.executeCommand("workbench.action.moveFocusedView");
  }
}

async function setBeside(beside) {
  await memory.update(BESIDE_KEY, beside);
  await vscode.commands.executeCommand("setContext", BESIDE_KEY, beside);
}

function howItWorks() {
  const guide = vscode.Uri.joinPath(extensionUri, "media", "how-it-works.md");
  vscode.commands.executeCommand("markdown.showPreview", guide).then(undefined, () => vscode.window.showTextDocument(guide));
}

function onViewMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.cmd === "ready") return refresh();
  if (message.cmd === "setup") return addInstructions();
  const agentId = typeof message.agent === "string" ? message.agent : "";
  if (message.cmd === "connect") return connectAgent(agentId);
  if (message.cmd === "disconnect") return disconnectAgent(agentId);
  if (message.cmd === "agent-settings") {
    const agent = agents.byId(agentId);
    if (agent) vscode.window.showTextDocument(vscode.Uri.file(agent.file(where()))).then(undefined, () => undefined);
    return;
  }
  if (message.cmd === "connections") return showPage("connections");
  if (message.cmd === "tasks") return showPage("tasks");
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
    vscode.commands.registerCommand("agentProgress.connectClaude", () => connectAgent("claude")),
    vscode.commands.registerCommand("agentProgress.disconnectClaude", () => disconnectAgent("claude")),
    vscode.commands.registerCommand("agentProgress.connectAgent", () => pickAgent("available", connectAgent)),
    vscode.commands.registerCommand("agentProgress.disconnectAgent", () => pickAgent("connected", disconnectAgent)),
    vscode.commands.registerCommand("agentProgress.connections", toggleConnections),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent: (uri) => previews.get(uri.path) ?? "",
    }),
    vscode.commands.registerCommand("agentProgress.howItWorks", howItWorks),
    vscode.commands.registerCommand("agentProgress.openSettings", openSettings),
    vscode.commands.registerCommand("agentProgress.besideTerminal", toggleBesideTerminal),
    vscode.commands.registerCommand("agentProgress.ownTab", toggleBesideTerminal),
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
  // Where the panel was left last time (beside the terminal or in its own tab): the button
  // above it shows the move that makes sense.
  memory = context.globalState;
  stats = memory.get(STATS_KEY, null);
  if (stats && !stats.tools) stats = null;
  vscode.commands.executeCommand("setContext", BESIDE_KEY, memory.get(BESIDE_KEY, false));
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
