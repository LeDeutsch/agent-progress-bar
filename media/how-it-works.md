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

## With an AI agent

Click **Add agent instructions** in the empty panel, or run **Agent Progress: Add Agent Instructions** from the Command Palette. It adds a short section to the file your agent reads (`CLAUDE.md` for Claude Code, `AGENTS.md` for most others, or the own file of Cursor, Copilot or Gemini), telling it to run its long commands through `agent-progress`. You see the change next to your file before anything is written, and Ctrl+Z undoes it. From then on, its long tasks show up here.

## What you see

| | |
|---|---|
| Blue | Running. The dot pulses. |
| Yellow | No news for 10 minutes: maybe stuck. |
| Red | Failed. |
| Green | Done. Finished tasks leave the panel after 5 minutes. |

Hover the time left to see how it is estimated. **Remove** takes a finished, failed or stuck task off the list. The status bar shows the oldest running task, and `(+2)` when others run too.

## Privacy

Everything stays on your computer. The extension reads the progress folder and the logs the tasks point to, and never connects to the network.
