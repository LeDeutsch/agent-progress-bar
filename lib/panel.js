"use strict";
// The panel's page. No VS Code API here, so a preview script can render it in a plain browser.
// The page receives { summary, tasks: [view, ...] } messages and updates each card in place, so
// the bars slide smoothly and their animations do not restart every second.

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
    --line: color-mix(in srgb, var(--fg) 10%, transparent);
  }
  [hidden] { display: none !important; }
  body { margin: 0; padding: 14px 16px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--fg); }
  .summary { margin: 0 2px 10px; color: var(--muted); font-size: .92em; }
  .task { --c: var(--run); margin-bottom: 10px; padding: 12px 14px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
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
  .second { align-items: baseline; }
  .meta.second > .note { white-space: normal; overflow-wrap: anywhere; }
  .left { color: var(--fg); font-weight: 600; }
  .stalled .note { color: var(--warn); }
  .empty { margin-top: 32px; color: var(--muted); text-align: center; }
  @keyframes pulse { 50% { opacity: .3; } }
  @keyframes sheen { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  @keyframes slide { from { left: -30%; } to { left: 100%; } }
  @media (prefers-reduced-motion: reduce) { *, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<p class="summary" id="summary" hidden></p>
<div id="tasks"></div>
<p class="empty" id="empty">No task running.</p>
<script nonce="${nonce}">
  const box = document.getElementById("tasks");
  const summary = document.getElementById("summary");
  const empty = document.getElementById("empty");
  const cards = new Map();
  const CARD =
    '<div class="head"><span class="dot"></span><span class="title"></span><span class="pct"></span></div>' +
    '<div class="bar"><div class="fill"></div></div>' +
    '<div class="meta first"><span class="count"></span><span class="left"></span></div>' +
    '<div class="meta second"><span class="note"></span><span class="when"></span></div>';

  function text(card, selector, value, hint) {
    const el = card.querySelector(selector);
    el.textContent = value || "";
    el.title = hint || "";
  }

  function update(card, t) {
    const known = t.percent !== null;
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
  }

  window.addEventListener("message", (event) => {
    const tasks = event.data.tasks || [];
    summary.textContent = event.data.summary || "";
    summary.hidden = !event.data.summary;
    empty.hidden = tasks.length > 0;
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
</script>
</body>
</html>`;
}

module.exports = { panelHtml };
