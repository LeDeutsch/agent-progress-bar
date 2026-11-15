"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const claude = require("../lib/claude");

const CALL = { command: '"C:/Users/me/.agent-progress/bin/agent-progress" hook' };
const SETTINGS = `${JSON.stringify(
  {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "npx prettier --write" }] }] },
    model: "opus",
  },
  null,
  2,
)}\n`;

test("connecting adds one async hook per event and keeps everything else", () => {
  const out = claude.connect(SETTINGS, CALL);
  const settings = JSON.parse(out);
  assert.deepEqual(settings.permissions, { allow: ["Bash(npm test)"] });
  assert.equal(settings.model, "opus");
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "Stop", "SubagentStop"]);
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "npx prettier --write", "the user's own hook stays first");
  const ours = settings.hooks.PreToolUse[0];
  assert.equal(ours.matcher, "Bash|PowerShell");
  assert.deepEqual(ours.hooks[0], { type: "command", command: CALL.command, async: true, timeout: 30 });
  assert.equal(settings.hooks.Stop[0].matcher, undefined);
  assert.ok(claude.isConnected(out));
  assert.ok(!claude.isConnected(SETTINGS));
});

test("connecting twice changes nothing, disconnecting gives the file back as it was", () => {
  const once = claude.connect(SETTINGS, CALL);
  assert.equal(claude.connect(once, CALL), once);
  assert.equal(claude.disconnect(once), SETTINGS);
  assert.equal(claude.disconnect(claude.connect("", CALL)), "{}\n", "a file that was empty");
});

test("a group shared with the user's own hooks loses only ours", () => {
  const shared = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }, { type: "command", command: CALL.command }] }] } });
  const settings = JSON.parse(claude.disconnect(shared));
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: "command", command: "say done" }] }]);
});

test("a file that is not plain JSON is refused, never rewritten", () => {
  assert.throws(() => claude.connect('{ "model": "opus", // mine\n}', CALL));
  assert.throws(() => claude.connect("[1, 2]", CALL));
  assert.equal(claude.isConnected("{ broken"), false);
});

test("Windows line endings are kept", () => {
  const out = claude.connect(SETTINGS.replace(/\n/g, "\r\n"), CALL);
  assert.equal(out.replace(/\r\n/g, "").includes("\n"), false);
});

test("the hook is called with Git Bash when Claude Code has it, else with PowerShell", () => {
  const bin = "C:\\Users\\me\\.agent-progress\\bin";
  assert.deepEqual(claude.hookCall({ bin, windows: true, bash: true }), { command: '"C:/Users/me/.agent-progress/bin/agent-progress" hook' });
  assert.deepEqual(claude.hookCall({ bin, windows: true, bash: false }), {
    command: '& "C:\\Users\\me\\.agent-progress\\bin\\agent-progress.cmd" hook',
    shell: "powershell",
  });
  assert.deepEqual(claude.hookCall({ bin: "/home/me/.agent-progress/bin", windows: false, bash: true }), {
    command: '"/home/me/.agent-progress/bin/agent-progress" hook',
  });
  const ps = claude.connect("{}", claude.hookCall({ bin, windows: true, bash: false }));
  assert.equal(JSON.parse(ps).hooks.Stop[0].hooks[0].shell, "powershell");
  assert.ok(claude.isConnected(ps), "the PowerShell form is recognized too");
});

test("the account shows its name and a masked address", () => {
  const file = JSON.stringify({ userID: "x", oauthAccount: { emailAddress: "alex.martin@example.com", displayName: "Alex", fullName: "Alex Martin" } });
  assert.deepEqual(claude.account(file), { name: "Alex", email: "al•••@example.com" });
  assert.equal(claude.maskEmail("a@b.io"), "a•••@b.io");
  assert.equal(claude.maskEmail("no-at-sign"), "");
  assert.deepEqual(claude.account(JSON.stringify({ oauthAccount: { emailAddress: "jo@x.fr" } })), { name: "", email: "jo•••@x.fr" });
  assert.equal(claude.account("{}"), null, "not signed in");
  assert.equal(claude.account("not json"), null);
});

test("the Connections page: numbers when connected, where it is found otherwise", () => {
  const { formatDuration } = require("../lib/progress");
  const now = Date.parse("2026-11-15T12:00:00Z");
  const on = claude.connectionView({
    state: "connected",
    account: { name: "Alex", email: "al•••@example.com" },
    stats: { seen: 38, shown: 4, last: { title: "Run the tests", at: now - 120000 } },
    shell: "Git Bash",
    now,
    formatDuration,
  });
  assert.equal(on.who, "Alex · al•••@example.com");
  assert.deepEqual(on.lines, [["38 commands seen today", "4 shown"], ["Last: Run the tests, 2 min ago"]]);
  assert.equal(on.hooks, true);
  const off = claude.connectionView({ state: "available", account: null, stats: null, shell: "Git Bash", now, formatDuration });
  assert.deepEqual(off.lines, [["Found on this computer"]]);
  assert.equal(off.who, "");
  assert.equal(off.hooks, false);
  assert.equal(claude.connectionView({ state: "missing", shell: "bash", now, formatDuration }).shell, "");
});

test("the shell named is the one the hooks use", () => {
  const ps = claude.connect("{}", { command: '& "C:\\x\\agent-progress.cmd" hook', shell: "powershell" });
  assert.equal(claude.shellName(ps, { windows: true, bash: true }), "PowerShell");
  assert.equal(claude.shellName(claude.connect("{}", CALL), { windows: true, bash: false }), "Git Bash");
  assert.equal(claude.shellName("{}", { windows: true, bash: false }), "PowerShell", "not connected: what Connect would pick");
  assert.equal(claude.shellName("{}", { windows: false, bash: true }), "bash");
});

test("Git Bash is found where Claude Code looks for it", () => {
  const at = (file) => (f) => f.toLowerCase() === file.toLowerCase();
  assert.ok(claude.hasGitBash({ ProgramFiles: "C:\\Program Files" }, at("C:\\Program Files\\Git\\bin\\bash.exe")));
  assert.ok(claude.hasGitBash({ PATH: "C:\\Windows;D:\\Tools\\Git\\cmd" }, at("D:\\Tools\\Git\\bin\\bash.exe")));
  assert.ok(claude.hasGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "E:\\bash.exe" }, at("E:\\bash.exe")));
  assert.ok(!claude.hasGitBash({ ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows" }, () => false));
});
