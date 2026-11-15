# How Agent Progress works

Any long task can show a card in the **Agent Progress** panel: a progress bar, the time left, what it is doing, and its log. A task shows up as soon as it writes a small file in the folder `~/.agent-progress`. You never have to write that file yourself: the `agent-progress` command does it.

The command is ready in every terminal VS Code opens (open a new terminal after installing the extension).

## Show any command

Put `agent-progress run --title "..."` in front of the command:

```sh
agent-progress run --title "Build" npm run build
agent-progress run --title "Tests" cargo test --release
```

The card appears right away and shows how long the command has run. **Open log** shows everything the command prints. At the end, the card turns green if the command succeeded, red if it failed.

If the command prints its progress, like `12/100` or `45%`, add `--parse` and the bar follows it:

```sh
agent-progress run --title "Convert videos" --parse --unit videos python convert.py
```

## From your own script

Your script can report its progress, one line per step:

```sh
agent-progress set export --title "Export images" --done 0 --total 500 --unit images
agent-progress set export --done 120
agent-progress done export
```

Use `agent-progress fail export --detail "disk full"` if it goes wrong. `set` keeps everything you do not repeat, so after the first line, `--done` is enough.

A script can also write the file itself: see the README for the format.

## With Claude Code, Codex, GitHub Copilot or Gemini CLI

Click the connect button in the empty panel (**Connect Claude Code**, the name of the tool found, or **Connect an agent** when there are several), or run **Agent Progress: Connect an Agent** from the Command Palette. You see the change to the tool's settings before anything is written. From then on, every command it runs that lasts more than 20 seconds shows here on its own, without the agent having to remember anything. A command Claude Code sends to the background turns grey (**ended**) once Claude Code no longer lists it: Claude Code does not say how it went. Codex asks you once to trust the new hook (`/hooks` in Codex). The account button at the top of the panel opens the **Connections** page: one row per tool on your computer, the Claude Code account in use, what each one ran today, and **Disconnect** to take it back out. The README shows the hooks to add by hand if your settings file has comments.

## With any AI agent

Click **Add agent instructions** in the empty panel, or run **Agent Progress: Add Agent Instructions** from the Command Palette. It adds a short section to the file your agent reads (`CLAUDE.md` for Claude Code, `AGENTS.md` for most others, or the own file of Cursor, Copilot or Gemini), telling it to run its long commands through `agent-progress`. You see the change next to your file before anything is written, and Ctrl+Z undoes it. From then on, its long tasks show up here.

## What you see

| | |
|---|---|
| Blue | Running. The dot pulses. |
| Yellow | No news for 10 minutes: maybe stuck. |
| Red | Failed. |
| Green | Done. |
| Grey | Ended, without knowing how (a background command of Claude Code). |

A finished card leaves the list after 2 minutes: the line at its bottom empties until then. When the cards do not fit (beside the terminal, a short panel), they turn into one line per task: hover a line for its buttons and details.

Hover the time left to see how it is estimated. **Remove** takes a finished, failed or stuck task off the list. The status bar shows the oldest running task, and `(+2)` when others run too.

## Settings

Click the gear at the top of the panel (or press `Ctrl+,` and type `agent progress`) to change how long a finished task stays, when a task counts as stuck, the notifications, and when old files are deleted. Changes apply right away.

## Privacy

Everything stays on your computer. The extension reads the progress folder and the logs the tasks point to, and never connects to the network.
