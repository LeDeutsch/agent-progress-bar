# Changelog

## 0.3.1

- **Show demo tasks**: a link in the extension's settings (and **Agent Progress: Show or Hide Demo Tasks** in the Command Palette) puts four made-up tasks in the panel and the status bar for a minute, one for each thing they show: a count with the time left, a percentage with the task's own estimate, a stalled task, and tests that end with their notification. They live in memory only, never in the progress folder; Remove works on them as on real tasks, and a second click hides them all. Setting `agentProgress.demoSeconds` for how long they stay.

## 0.3.0

- **Codex, GitHub Copilot and Gemini CLI** connect like Claude Code: hooks in their own settings show every command they run that lasts. Codex: `~/.codex/hooks.json` (Codex asks once to trust the hook: `/hooks`). GitHub Copilot: a file of the extension's own, `~/.copilot/hooks/agent-progress.json`, read by Copilot CLI and VS Code's agent mode; Disconnect deletes it. Gemini CLI: `~/.gemini/settings.json`. Each change shows side by side first.
- One connect button in the empty panel, whatever the number of agents: the name of the one tool found, or **Connect an agent** (the Connections page) when several are waiting. **Agent Progress: Connect an Agent** and **Disconnect an Agent** in the Command Palette.
- The Connections page lists the tools on the computer, one row each, with what each one ran today and what is left to do in it.
- The hook reads events that PowerShell passes on with a byte order mark.
- Left out for now, with the reason in the README: Cursor, Windsurf, Cline.

## 0.2.0

- **Connect Claude Code**: hooks in Claude Code's settings show every command it runs that lasts (20 seconds by default, `agentProgress.commandsShowAfterSeconds`), without the agent having to remember anything. Foreground commands turn done or failed; background ones turn **ended** (grey) once Claude Code no longer lists them, since it does not say how they went. The change is shown side by side before it is written; **Disconnect Claude Code** takes it out. The hooks only watch and never slow Claude Code down.
- A **Connections** page (the account button above the panel): Claude Code's account (name and masked address), its commands today, where the hooks are, and **Connect** or **Disconnect**. It lays itself out for the room it has.
- The empty panel shows the extension's logo; **Connect Claude Code** takes Claude's colors; **How it works** becomes a link under the buttons.
- The panel fits its box: when the cards do not fit (beside the terminal, a short panel, many tasks), each task becomes one line, with its buttons on hover or keyboard focus.
- A new `ended` state, and two fields for tasks found without their help: `auto` (shown once it lasts) and `heartbeat: false` (no news is not a sign of being stuck).
- The launchers stay quiet when a hook calls them after the extension is gone.

## 0.1.3

- A button at the top of the panel puts it beside the terminal (side by side in the bottom panel); clicking it again puts it back in its own tab. If VS Code ever changes the way this works, the button opens VS Code's own "Move View" chooser instead.

## 0.1.2

- A gear at the top of the panel opens the extension's settings; the README and the guide say where they are.

## 0.1.1

- A finished task stays 2 minutes in the list (was 5), and a line at the bottom of its card empties until it leaves; cards fade out instead of vanishing.
- A command run through `agent-progress run` that succeeds says how long it took ("finished in 1 min") instead of its last line, which often said little; **Open log** has the rest.
- Progress files with no update for a day are deleted by themselves, with the logs `agent-progress` wrote next to them (setting `agentProgress.deleteFilesAfterHours`, `0` to keep them).

## 0.1.0

- **Add agent instructions** also offers Cursor (`.cursor/rules/agent-progress.mdc`, applied in every chat), GitHub Copilot (`.github/copilot-instructions.md`) and Gemini CLI (`GEMINI.md`).
- The empty panel offers **Add agent instructions** (adds or updates a section in `CLAUDE.md`, `AGENTS.md` or `~/.claude/CLAUDE.md`, or copies it; the change shows side by side first, nothing is written before **Add**, in the panel or above the preview, and Ctrl+Z undoes it) and **How it works** (a short guide for using the panel without an AI agent).
- The `agent-progress` command: `run` wraps any command (card, log, done or failed at the end, progress read from the output with `--parse`); `set`, `done`, `fail`, `remove` report progress without writing JSON. Launchers in `~/.agent-progress/bin` run it with VS Code's own runtime (no Node.js needed); that folder is on the PATH of VS Code's terminals.
- The panel lives next to the terminal (it was an editor tab), cards side by side when there is room, colors from the theme (light, dark, high contrast checked).
- **Open log** and **Remove** buttons on the cards; a new `log` field points to the task's log.
- The time left follows the speed of the last 3 minutes; durations under a minute in seconds.
- Panel redone: one card per task with a colored state, the bar now shows the real progress (it always looked full), how long a task has run, a summary line when several tasks run, and `npm run demo` to see every state.
- Named Agent Progress Bar (first called Task Progress Bar). Progress files go in `~/.agent-progress/`.
- First version: progress and time left in the status bar, a panel of progress bars, notifications when a task ends, stalled tasks, settings for the folder and the delays.
