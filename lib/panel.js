"use strict";
// The panel's page. No VS Code API here, so a preview script can render it in a plain browser.
// The page receives { summary, tasks: [view, ...] } messages and updates each card in place, so
// the bars slide smoothly and their animations do not restart every second. Its buttons post
// { cmd: "log" | "remove", id } for a card, { cmd: "setup" | "guide" } from the empty panel; it
// posts { cmd: "ready" } once loaded.

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
  #tasks { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
  .task { --c: var(--run); display: flex; flex-direction: column; min-width: 0; padding: 12px 14px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
  .task.stalled { --c: var(--warn); }
  .task.done { --c: var(--ok); }
  .task.failed { --c: var(--bad); }
  .head { display: flex; align-items: center; gap: 8px; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
  .running .dot { animation: pulse 1.6s ease-in-out infinite; }
  .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .pct { font-size: 1.15em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .done .pct, .failed .pct, .stalled .pct { color: var(--c); }
  .done .pct, .failed .pct { font-size: 1em; }
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
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; min-height: calc(100vh - 20px); color: var(--muted); text-align: center; }
  .empty p { margin: 0; }
  .empty .actions { justify-content: center; flex-wrap: wrap; margin: 0; padding: 0; }
  .empty .actions button { padding: 4px 14px; font-size: 1em; }
  .actions button.primary { border-color: var(--vscode-button-border, transparent); background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
  .actions button.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-bottom: 12px; padding: 10px 14px; border: 1px solid var(--vscode-focusBorder, var(--run)); border-radius: 6px; background: var(--card); }
  .confirm p { margin: 0; font-weight: 600; }
  .confirm .actions { margin: 0; padding: 0; }
  .confirm .actions button { padding: 4px 14px; font-size: 1em; }
  .confirm.alone { flex-direction: column; justify-content: center; min-height: calc(100vh - 20px); margin: 0; padding: 0; border: none; background: none; }
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
  <p>No task running.</p>
  <div class="actions">
    <button type="button" class="primary" data-cmd="setup" title="Adds a short section to CLAUDE.md, AGENTS.md or another file your AI agent reads, so it shows its long tasks here">Add agent instructions</button>
    <button type="button" data-cmd="guide" title="Opens a short guide: show any command or script here, with or without an AI agent">How it works</button>
  </div>
</div>
<script nonce="${nonce}">
  const host = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage() {} };
  const box = document.getElementById("tasks");
  const summary = document.getElementById("summary");
  const empty = document.getElementById("empty");
  const confirmBox = document.getElementById("confirm");
  const confirmQuestion = document.getElementById("confirm-question");
  const confirmOk = document.getElementById("confirm-ok");
  const cards = new Map();
  const CARD =
    '<div class="head"><span class="dot"></span><span class="title"></span><span class="pct"></span></div>' +
    '<div class="bar"><div class="fill"></div></div>' +
    '<div class="meta first"><span class="count"></span><span class="left"></span></div>' +
    '<div class="meta second"><span class="note"></span><span class="when"></span></div>' +
    '<div class="actions">' +
    '<button type="button" data-cmd="log" title="Opens the log this task writes, in an editor">Open log</button>' +
    '<button type="button" data-cmd="remove" title="Takes the task off the list and deletes its progress file">Remove</button>' +
    '</div>';

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
    text(card, ".pct", t.state === "done" ? "done" : t.state === "failed" ? "failed" : known ? t.percent + "%" : "");
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
  }

  document.body.addEventListener("click", (event) => {
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
    summary.textContent = event.data.summary || "";
    summary.hidden = !event.data.summary;
    empty.hidden = tasks.length > 0 || Boolean(confirm);
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
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
  });

  host.postMessage({ cmd: "ready" });
</script>
</body>
</html>`;
}

module.exports = { panelHtml };
