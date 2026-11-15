# Changelog

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
