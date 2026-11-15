# Agent Progress Bar

When an AI agent starts something long in the background (a build, a big batch of files, model work...), you usually get no sign of life until it is over. This extension gives you one: a progress bar and the time left, in the VS Code status bar, with a panel of bars when you click it.

It works with any agent, and with any script too: the task writes a small JSON file, the extension reads it once a second. That's the whole contract.

## Install

- From a `.vsix` file: in VS Code, **Extensions** view, `...` menu, **Install from VSIX...**.
- From the source folder: Command Palette, **Developer: Install Extension from Location...**, then pick the folder.
- To build the `.vsix` yourself: `npm run package` (uses the official `@vscode/vsce` tool).

## What you see

- In the status bar: `Voice packs 42% · 35 min left`, and `(+1)` when other tasks run too.
- Click it: a panel with one card per task, the count (`2,440 / 5,808 takes`), the time left, a detail line and how long it has run. Several agents at once each get their own card: running tasks first, then stalled, failed and done.
- A task with no news for 10 minutes is shown as stalled (yellow).
- A notification when a task finishes or fails.

## Try it

`npm run demo` writes a few fake tasks for 90 seconds: a count with the time left, several tasks at once, a task with no known progress, a failure, a stalled task. Watch the status bar and click it.

## Reporting progress

Write one JSON file per task in `~/.agent-progress/` (on Windows: `C:\Users\<you>\.agent-progress\`). The file name is the task id: `voice-packs.json`. Rewrite it as the task moves on.

```json
{
  "title": "Voice packs",
  "done": 2440,
  "total": 5808,
  "unit": "takes",
  "detail": "Eva done, Lucas 1,536 / 2,904",
  "started": "2026-11-15T10:12:00Z",
  "state": "running"
}
```

| Field | Needed | Meaning |
|---|---|---|
| `title` | no | What the task is. Default: the file name. |
| `done`, `total` | one of the two ways | Progress as a count. |
| `percent` | one of the two ways | Progress from 0 to 100, if you have no count. |
| `unit` | no | Shown after the count: `takes`, `files`, `tests`. |
| `detail` | no | One line about what is happening right now. |
| `started` | for the time left | When the task started (ISO 8601). The time left comes from the pace so far. |
| `eta_seconds` | no | Your own estimate of the time left, if you know better. |
| `state` | no | `running` (default), `done` or `failed`. |
| `updated` | no | Last update (ISO 8601). Default: the file's modification time. |

Without `done`/`total` or `percent`, the bar just moves to show the task is alive. Write the file in one go (write to a temporary file, then rename) so it is never read half-written; if it is, the extension keeps the previous value.

When the task ends, set `"state": "done"` (or `"failed"`). Finished tasks disappear after 5 minutes, or with the command **Agent Progress: Clear Finished Tasks**, which deletes their files.

### Examples

Python:

```python
import json, os, time
from pathlib import Path

folder = Path.home() / ".agent-progress"
folder.mkdir(exist_ok=True)
started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def report(done, total, state="running"):
    tmp = folder / "my-task.json.tmp"
    tmp.write_text(json.dumps({"title": "My task", "done": done, "total": total,
                               "started": started, "state": state}))
    os.replace(tmp, folder / "my-task.json")
```

Node:

```js
const fs = require("fs"), os = require("os"), path = require("path");
const folder = path.join(os.homedir(), ".agent-progress");
fs.mkdirSync(folder, { recursive: true });
const started = new Date().toISOString();
function report(done, total, state = "running") {
  const file = path.join(folder, "my-task.json");
  fs.writeFileSync(file + ".tmp", JSON.stringify({ title: "My task", done, total, started, state }));
  fs.renameSync(file + ".tmp", file);
}
```

### Telling an AI agent

Add this to the instructions your agent reads (for example `CLAUDE.md` or `AGENTS.md`):

> When you start a task that runs in the background for more than a minute, report its progress in `~/.agent-progress/<task-id>.json` with `title`, `done`, `total`, `started` (ISO 8601) and `state` (`running`, then `done` or `failed`), as described in the Agent Progress Bar README. Update it at least every few seconds and write it atomically (temporary file, then rename).

If the task's own program cannot be changed, the agent can run a small watcher next to it that reads the task's log and writes the file.

## Settings

| Setting | Default | |
|---|---|---|
| `agentProgress.folder` | `~/.agent-progress` | Folder watched for progress files. |
| `agentProgress.staleMinutes` | `10` | No update for this long: shown as stalled. |
| `agentProgress.keepFinishedMinutes` | `5` | How long a finished task stays visible. |
| `agentProgress.notify` | `true` | Notification when a task finishes or fails. |

## Privacy

The extension only reads the progress folder (and deletes finished task files when you ask it to). It never connects to the network and collects nothing.

## License

MIT, see [LICENSE](LICENSE).
