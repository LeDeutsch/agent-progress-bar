"use strict";
// The panel's page. No VS Code API here, so a preview script can render it in a plain browser.
// The page receives { summary, tasks: [view, ...] } messages and updates each card in place, so
// the bars slide smoothly and their animations do not restart every second. Its buttons post
// { cmd: "log" | "remove", id } for a card, { cmd: "claude" | "setup" | "guide" | "connections" }
// from the empty panel, { cmd: "tasks" | "disconnect" | "claude-settings" } from the Connections
// page; it posts { cmd: "ready" } once loaded. As the panel gets narrow or short, cards turn into
// rows (fit()).

/** A plain four-point sparkle for Claude Code's button and mark (not Anthropic's logo). */
const SPARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0c.6 4.4 3.6 7.4 8 8-4.4.6-7.4 3.6-8 8-.6-4.4-3.6-7.4-8-8 4.4-.6 7.4-3.6 8-8z"/></svg>';

function panelHtml(nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  :root {
    --fg: var(--vscode-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #9d9d9d);
    --run: var(--vscode-charts-blue, #3794ff);
    --ok: var(--vscode-charts-green, #89d185);
    --bad: var(--vscode-charts-red, #f14c4c);
    --warn: var(--vscode-charts-yellow, #cca700);
    --track: color-mix(in srgb, var(--fg) 13%, transparent);
    --card: color-mix(in srgb, var(--fg) 4%, transparent);
    --line: var(--vscode-contrastBorder, color-mix(in srgb, var(--fg) 10%, transparent));
  }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 10px 14px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--fg); }
  .summary { margin: 0 2px 10px; color: var(--muted); font-size: .92em; }
  #tasks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 10px; }
  .task.leaving { opacity: 0; transform: scale(.97); transition: opacity .4s ease, transform .4s ease; }
  /* A finished card's countdown: the line empties until the card leaves the list. */
  .expire { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--track); }
  .expire > i { display: block; height: 100%; background: var(--c); opacity: .75; transition: width 1s linear; }
  .task { --c: var(--run); position: relative; overflow: hidden; display: flex; flex-direction: column; min-width: 0; padding: 12px 14px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
  .task.stalled { --c: var(--warn); }
  .task.done { --c: var(--ok); }
  .task.failed { --c: var(--bad); }
  .task.ended { --c: var(--muted); }
  .head { display: flex; align-items: center; gap: 8px; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .running .dot { animation: pulse 1.6s ease-in-out infinite; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .pct { font-size: 1.15em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .done .pct, .failed .pct, .ended .pct, .stalled .pct { color: var(--c); }
  .done .pct, .failed .pct, .ended .pct { font-size: 1em; }
  .bar { position: relative; height: 6px; margin: 10px 0 8px; overflow: hidden; border-radius: 3px; background: var(--track); }
  .fill { position: absolute; top: 0; bottom: 0; left: 0; width: 0; overflow: hidden; border-radius: 3px; background: var(--c); transition: width .6s ease; }
  .running .fill::after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .28), transparent); animation: sheen 2.2s linear infinite; }
  .unknown .fill { width: 30%; transition: none; animation: slide 1.4s ease-in-out infinite; }
  .unknown .fill::after { display: none; }
  .meta { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: .92em; line-height: 1.6; }
  .meta > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta > span:last-child { flex: none; text-align: right; }
  .meta.second { align-items: baseline; }
  .meta.second > .note { white-space: normal; overflow-wrap: anywhere; }
  .left { color: var(--fg); font-weight: 600; }
  .stalled .note { color: var(--warn); }
  .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: auto; padding-top: 8px; }
  .actions button { padding: 2px 10px; border: 1px solid var(--vscode-button-border, var(--line)); border-radius: 4px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--fg)); font: inherit; font-size: .9em; line-height: 1.6; cursor: pointer; }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--track)); }
  .actions button:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--run)); outline-offset: 1px; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: calc(100vh - 20px); color: var(--muted); text-align: center; }
  .empty p { margin: 0; }
  .empty .actions { justify-content: center; flex-wrap: wrap; margin: 2px 0 0; padding: 0; }
  .empty .actions button { padding: 4px 14px; font-size: 1em; }
  .empty .links { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 16px; }
  /* The extension's logo (icon.png), drawn with the theme's colors. */
  .logo { width: 44px; height: 44px; }
  .logo .l-bg { fill: color-mix(in srgb, var(--fg) 6%, transparent); stroke: var(--line); }
  .logo .l-dim { fill: color-mix(in srgb, var(--fg) 40%, transparent); }
  .logo .l-track { fill: color-mix(in srgb, var(--fg) 14%, transparent); }
  .logo .l-fill { fill: var(--run); }
  .actions button.primary { border-color: var(--vscode-button-border, transparent); background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
  .actions button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  /* Claude Code's button in Claude's own colors: its terracotta, rounded, a plain sparkle. */
  .actions button.claude { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 8px; background: #D97757; color: #fff; font-weight: 600; }
  .actions button.claude:hover { background: #C6613F; }
  .claude svg, .mark svg { flex: none; width: 12px; height: 12px; fill: currentColor; }
  /* Help and status read as links: they are not actions on a par with the buttons. */
  .linkish { padding: 1px 2px; border: none; background: none; color: var(--vscode-textLink-foreground, var(--run)); font: inherit; font-size: .92em; cursor: pointer; }
  .linkish:hover { text-decoration: underline; }
  .linkish:focus-visible, .back:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--run)); outline-offset: 1px; }
  .linkish.connected { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  .linkish.connected::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  /* Connections: one row per tool the panel is connected to (Claude Code for now). */
  .page { display: flex; flex-direction: column; gap: 10px; }
  .back { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 0; border: none; background: none; color: var(--muted); font: inherit; font-size: .85em; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
  .back:hover { color: var(--fg); }
  .back::before { content: "\\2039"; font-size: 1.6em; line-height: .6; }
  /* The name beside the mark and the button; the details under them, the whole width. */
  .conn { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "mark name action" ". lines lines" ". more more"; align-items: center; gap: 2px 12px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
  .mark { grid-area: mark; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 7px; background: #D97757; color: #fff; }
  .mark svg { width: 13px; height: 13px; }
  .conn.off .mark { background: var(--track); color: var(--muted); }
  .conn-text { display: contents; }
  .conn-name { grid-area: name; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 10px; }
  .conn-lines { grid-area: lines; min-width: 0; line-height: 1.6; }
  .conn .more { grid-area: more; justify-self: start; }
  .conn-name b { font-weight: 600; }
  .conn-who { color: var(--muted); font-size: .92em; overflow-wrap: anywhere; }
  .conn-line { color: var(--muted); font-size: .92em; }
  .conn-line > span + span::before { content: " \\00b7  "; white-space: pre; }
  .conn-line > span { display: inline-block; max-width: 100%; }
  .conn-line .linkish { padding: 0; font-size: 1em; }
  .conn .actions { grid-area: action; margin: 0; padding: 0; }
  .conn .actions button { padding: 2px 10px; font-size: .92em; }
  /* Disconnect is a quiet way out, not a call to action: small, plain, red only on hover. */
  .conn .actions button.quiet { border-color: transparent; background: none; color: var(--muted); }
  .conn .actions button.quiet:hover { border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 10%, transparent); color: var(--bad); }
  .conn .more { display: none; }
  /* Narrow: one line each, cut with "...", and only the first one until "Show more". */
  @media (max-width: 400px) {
    .conn { gap: 4px 10px; padding: 10px; }
    .conn-who, .conn-line { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conn-line > span { display: inline; }
    .conn:not(.open) .conn-line:not(:first-child) { display: none; }
    .conn.open .conn-line { white-space: normal; }
    .conn.open .conn-line > span { display: inline-block; max-width: 100%; }
    .conn .more { display: inline; padding: 0; font-size: .92em; }
  }
  @media (min-width: 760px) {
    .conn-lines { display: flex; flex-wrap: wrap; }
    .conn-line + .conn-line::before { content: " \\00b7  "; white-space: pre; }
  }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-bottom: 12px; padding: 10px 14px; border: 1px solid var(--vscode-focusBorder, var(--run)); border-radius: 6px; background: var(--card); }
  .confirm p { margin: 0; font-weight: 600; }
  .confirm .actions { margin: 0; padding: 0; }
  .confirm .actions button { padding: 4px 14px; font-size: 1em; }
  .confirm.alone { flex-direction: column; justify-content: center; min-height: calc(100vh - 20px); margin: 0; padding: 0; border: none; background: none; }
  /* Rows: one line per task, when the cards would not fit the panel (beside the terminal, a short
     panel, many tasks). Each row is a subgrid, so names, numbers and buttons line up. */
  body.rows .summary { margin-bottom: 6px; }
  body.rows #tasks { grid-template-columns: auto minmax(0, max-content) minmax(0, 1fr) auto auto; column-gap: 10px; row-gap: 0; }
  body.rows .task { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; row-gap: 5px; padding: 6px 8px 7px; border: none; border-bottom: 1px solid var(--line); border-radius: 0; background: none; }
  body.rows .task:is(:hover, :focus-within) { background: var(--card); }
  body.rows .head, body.rows .meta { display: contents; }
  body.rows .dot { grid-column: 1; grid-row: 1; }
  body.rows .title { grid-column: 2; grid-row: 1; }
  body.rows .meta.second > .note { grid-column: 3; grid-row: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .92em; }
  body.rows .pct { grid-column: 4; grid-row: 1; font-size: 1em; text-align: right; }
  body.rows .meta > .left { grid-column: 5; grid-row: 1; font-size: .92em; }
  body.rows .count, body.rows .when, body.rows .expire { display: none; }
  body.rows .bar { grid-column: 1 / -1; grid-row: 2; height: 3px; margin: 0; }
  body.rows .actions { grid-column: 4 / 6; grid-row: 1; justify-self: end; gap: 4px; margin: 0; padding: 0; opacity: 0; pointer-events: none; }
  body.rows .actions button { padding: 0 8px; font-size: .85em; line-height: 1.5; }
  body.rows .task:is(:hover, :focus-within) .actions { opacity: 1; pointer-events: auto; }
  body.rows .task:is(:hover, :focus-within):has(.actions:not([hidden])) :is(.pct, .left) { visibility: hidden; }
  @media (max-width: 380px) { body.rows .meta.second > .note { display: none; } }
  @keyframes pulse { 50% { opacity: .3; } }
  @keyframes sheen { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  @keyframes slide { from { left: -30%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<div class="confirm" id="confirm" hidden>
  <p id="confirm-question"></p>
  <div class="actions">
    <button type="button" class="primary" data-cmd="confirm" id="confirm-ok" title="Writes these lines in the file. Ctrl+Z in the editor undoes it.">Add</button>
    <button type="button" data-cmd="cancel" title="Closes the preview. Nothing is written.">Cancel</button>
  </div>
</div>
<p class="summary" id="summary" hidden></p>
<div id="tasks"></div>
<div class="empty" id="empty">
  <svg class="logo" viewBox="0 0 48 48" aria-hidden="true"><rect class="l-bg" x="1" y="1" width="46" height="46" rx="11"/><rect class="l-dim" x="11" y="13" width="20" height="4" rx="2"/><rect class="l-track" x="11" y="21.5" width="26" height="5" rx="2.5"/><rect class="l-fill" x="11" y="21.5" width="17" height="5" rx="2.5"/><rect class="l-dim" x="11" y="31" width="12" height="4" rx="2"/></svg>
  <p>No task running.</p>
  <div class="actions">
    <button type="button" class="claude" data-cmd="claude" id="claude-connect" hidden title="Adds hooks to Claude Code's settings, shown before anything is written: the commands it runs show here once they last">${SPARK}Connect Claude Code</button>
    <button type="button" data-cmd="setup" id="setup" title="Adds a short section to CLAUDE.md, AGENTS.md or another file your AI agent reads, so it shows its long tasks here">Add agent instructions</button>
  </div>
  <div class="links">
    <button type="button" class="linkish" data-cmd="guide" title="Opens a short guide: show any command or script here, with or without an AI agent">How it works</button>
    <button type="button" class="linkish connected" data-cmd="connections" id="claude-connected" hidden title="The commands Claude Code runs show here once they last. Opens the connections.">Claude Code connected</button>
  </div>
</div>
<section class="page" id="connections" hidden>
  <button type="button" class="back" data-cmd="tasks" title="Back to the tasks">Connections</button>
  <div id="connection-list"></div>
</section>
<script nonce="${nonce}">
  const host = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const box = document.getElementById("tasks");
  const summary = document.getElementById("summary");
  const empty = document.getElementById("empty");
  const confirmBox = document.getElementById("confirm");
  const confirmQuestion = document.getElementById("confirm-question");
  const confirmOk = document.getElementById("confirm-ok");
  const claudeConnect = document.getElementById("claude-connect");
  const claudeConnected = document.getElementById("claude-connected");
  const setupButton = document.getElementById("setup");
  const connections = document.getElementById("connections");
  const connectionList = document.getElementById("connection-list");
  const SPARK = ${JSON.stringify(SPARK)};
  const cards = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, cmd, hint, className = "") {
    const node = el("button", className, label);
    node.type = "button";
    node.dataset.cmd = cmd;
    node.title = hint;
    return node;
  }

  /** Rows opened with "Show more" (narrow panel), kept while the page refreshes. */
  const openRows = new Set();
  let shownConnections = "";

  /**
   * The Connections page: one row per tool, its account, what it did today, where its hooks are.
   * Rebuilt only when something changed, and the focused button keeps the focus.
   */
  function renderConnections(items) {
    const key = JSON.stringify(items);
    if (key === shownConnections) return;
    shownConnections = key;
    const focused = document.activeElement && connectionList.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused ? [focused.closest(".conn")?.dataset.id, focused.dataset.cmd || focused.dataset.local].join("|") : "";
    connectionList.replaceChildren(
      ...items.map((c) => {
        const row = el("div", c.state === "connected" ? "conn" : "conn off");
        row.dataset.id = c.id;
        row.classList.toggle("open", openRows.has(c.id));
        const mark = el("span", "mark");
        mark.innerHTML = SPARK;
        const name = el("div", "conn-name");
        name.append(el("b", "", c.name));
        if (c.who) name.append(el("span", "conn-who", c.who));
        const lines = el("div", "conn-lines");
        for (const parts of c.lines) {
          const line = el("div", "conn-line");
          for (const part of parts) line.append(el("span", "", part));
          lines.append(line);
        }
        if (c.hooks) {
          const where = el("div", "conn-line");
          const hooks = el("span", "", "Hooks in ");
          hooks.append(button("~/.claude/settings.json", "claude-settings", "Opens Claude Code's settings", "linkish"));
          where.append(hooks);
          if (c.shell) where.append(el("span", "", c.shell));
          lines.append(where);
        } else if (c.shell && lines.lastElementChild) {
          // Not connected: the shell joins the only line, so nothing hides behind "Show more".
          lines.lastElementChild.append(el("span", "", c.shell));
        }
        const text = el("div", "conn-text");
        text.append(name, lines);
        // A narrow panel shows the first line only: the rest on demand.
        if (lines.children.length > 1) {
          const more = el("button", "linkish more", openRows.has(c.id) ? "Show less" : "Show more");
          more.type = "button";
          more.dataset.local = "more";
          text.append(more);
        }
        const action = el("div", "actions");
        if (c.state === "connected") {
          action.append(button("Disconnect", "disconnect", "Takes the hooks out of Claude Code's settings, shown side by side before anything is written", "quiet"));
        } else if (c.state === "available") {
          const connect = button("Connect", "claude", "Adds hooks to Claude Code's settings, shown side by side before anything is written", "claude");
          connect.insertAdjacentHTML("afterbegin", SPARK);
          action.append(connect);
        }
        row.append(mark, text, action);
        return row;
      }),
    );
    if (focusKey) {
      for (const node of connectionList.querySelectorAll("button")) {
        if ([node.closest(".conn")?.dataset.id, node.dataset.cmd || node.dataset.local].join("|") === focusKey) node.focus();
      }
    }
  }
  const CARD =
    '<div class="head"><span class="dot"></span><span class="title"></span><span class="pct"></span></div>' +
    '<div class="bar"><div class="fill"></div></div>' +
    '<div class="meta first"><span class="count"></span><span class="left"></span></div>' +
    '<div class="meta second"><span class="note"></span><span class="when"></span></div>' +
    '<div class="actions">' +
    '<button type="button" data-cmd="log" title="Opens the log this task writes, in an editor">Open log</button>' +
    '<button type="button" data-cmd="remove" title="Takes the task off the list and deletes its progress file">Remove</button>' +
    '</div>' +
    '<div class="expire"><i></i></div>';

  function text(card, selector, value, hint) {
    const el = card.querySelector(selector);
    el.textContent = value || "";
    el.title = hint || "";
  }

  function update(card, t) {
    const known = t.percent !== null;
    card.dataset.id = t.id;
    card.className = "task " + t.kind + (t.kind === "running" && !known ? " unknown" : "");
    text(card, ".title", t.title, t.title);
    text(card, ".pct", t.state !== "running" ? t.state : known ? t.percent + "%" : "");
    // Set through the style object: the page's security policy blocks inline style attributes.
    card.querySelector(".fill").style.width = t.kind === "running" && !known ? "" : (known ? t.percent : 100) + "%";
    text(card, ".count", t.count);
    text(card, ".left", t.left, t.left ? t.leftHint : "");
    text(card, ".note", t.note, t.note);
    text(card, ".when", t.when, t.whenHint);
    card.querySelector(".first").hidden = !t.count && !t.left;
    card.querySelector(".second").hidden = !t.note && !t.when;
    card.querySelector('[data-cmd="log"]').hidden = !t.hasLog;
    card.querySelector('[data-cmd="remove"]').hidden = !t.removable;
    card.querySelector(".actions").hidden = !t.hasLog && !t.removable;
    const expire = card.querySelector(".expire");
    expire.hidden = t.leavesIn === null || !t.keepFor;
    expire.title = expire.hidden ? "" : t.whenHint;
    if (!expire.hidden) expire.firstChild.style.width = (100 * t.leavesIn) / t.keepFor + "%";
    // As rows, the count and the times only show on hover: the whole story in one tooltip.
    card.title = [t.title, t.count, t.left, t.note, t.when].filter(Boolean).join("\\n");
  }

  /**
   * Cards while they fit the panel; rows (one line per task) when the panel is too narrow or too
   * short for them. Worked out from the panel's size, not from what is on screen, so the choice
   * never flips back and forth.
   */
  const CARD_WIDTH = 260;
  const CARD_HEIGHT = 128;
  const GAP = 10;
  function fit() {
    const count = box.children.length;
    const columns = Math.max(1, Math.floor((box.clientWidth + GAP) / (CARD_WIDTH + GAP)));
    const lines = Math.ceil(count / columns);
    const needed = box.getBoundingClientRect().top + window.scrollY + lines * (CARD_HEIGHT + GAP);
    document.body.classList.toggle("rows", count > 0 && needed > window.innerHeight);
  }
  window.addEventListener("resize", fit);

  /** Shows "No task running." once no card is left, the last ones having faded out. */
  let lastMessage = { tasks: [], confirm: null, page: "tasks" };
  function updateEmpty() {
    const { tasks, confirm, page } = lastMessage;
    empty.hidden = page === "connections" || tasks.length > 0 || Boolean(confirm) || box.children.length > 0;
  }

  document.body.addEventListener("click", (event) => {
    const local = event.target.closest("button[data-local]");
    if (local) {
      const row = local.closest(".conn");
      const open = row.classList.toggle("open");
      if (open) openRows.add(row.dataset.id);
      else openRows.delete(row.dataset.id);
      local.textContent = open ? "Show less" : "Show more";
      shownConnections = "";
      return;
    }
    const button = event.target.closest("button[data-cmd]");
    if (!button) return;
    const card = button.closest(".task");
    host.postMessage(card ? { cmd: button.dataset.cmd, id: card.dataset.id } : { cmd: button.dataset.cmd });
  });

  window.addEventListener("message", (event) => {
    const tasks = event.data.tasks || [];
    const confirm = event.data.confirm;
    confirmBox.hidden = !confirm;
    if (confirm) {
      confirmQuestion.textContent = confirm.question;
      confirmOk.textContent = confirm.ok;
    }
    confirmBox.classList.toggle("alone", Boolean(confirm) && tasks.length === 0);
    // Claude Code there and not connected: connecting is the main way in, the instructions second;
    // without Claude Code, the instructions are the way in.
    const claude = event.data.claude || "missing";
    claudeConnect.hidden = claude !== "available";
    claudeConnected.hidden = claude !== "connected";
    setupButton.classList.toggle("primary", claude === "missing");
    // The Connections page takes the place of the tasks until its back arrow (a question waiting wins).
    const page = event.data.page === "connections" && !confirm ? "connections" : "tasks";
    connections.hidden = page !== "connections";
    box.hidden = page === "connections";
    if (page === "connections") renderConnections(event.data.connections || []);
    summary.textContent = event.data.summary || "";
    summary.hidden = !event.data.summary || page === "connections";
    lastMessage = { tasks, confirm, page };
    const seen = new Set();
    tasks.forEach((t, i) => {
      seen.add(t.id);
      let card = cards.get(t.id);
      if (!card) {
        card = document.createElement("div");
        card.innerHTML = CARD;
        cards.set(t.id, card);
      }
      update(card, t);
      if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
    });
    // A card that leaves fades out first; if its task comes back meanwhile, update() keeps it.
    for (const [id, card] of cards) {
      if (seen.has(id) || card.classList.contains("leaving")) continue;
      card.classList.add("leaving");
      setTimeout(() => {
        if (!card.classList.contains("leaving")) return;
        card.remove();
        if (cards.get(id) === card) cards.delete(id);
        updateEmpty();
        fit();
      }, 420);
    }
    updateEmpty();
    fit();
  });

  host.postMessage({ cmd: "ready" });
</script>
</body>
</html>`;
}

module.exports = { panelHtml, SPARK };
