// copilot/src/hook.ts
import { appendFileSync, readFileSync as readFileSync2 } from "node:fs";

// hooks/model.ts
var LIVE_MS = 3 * 60 * 1e3;
var RECENT_CLOSED_MS = 24 * 60 * 60 * 1e3;
var newId = (prefix, now) => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${now.toString(36)}${rand}`;
};
var projectKey = (remote, root) => {
  const fromRemote = remote?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
  const name = fromRemote ?? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;
  const basis = fromRemote ?? root;
  const key = basis.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return { key: key || "unknown", name };
};
var parsePrUrl = (text) => {
  const found = text.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  const [url, repo, num] = found ?? [];
  if (!url || !repo || !num) return void 0;
  return { repo, number: Number(num), url };
};
var parseMergeTarget = (command) => {
  if (!/\bgh\s+pr\s+merge\b/.test(command)) return void 0;
  const url = parsePrUrl(command);
  if (url) return { repo: url.repo, number: url.number };
  const num = command.match(/\bgh\s+pr\s+merge\s+(?:[^\n]*?\s)?#?(\d+)\b/);
  return num ? { number: Number(num[1]) } : void 0;
};
var isPrCreate = (command) => /\bgh\s+pr\s+create\b/.test(command);
var clip = (text, max) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
};
var foldItem = (item, events) => {
  const mine = events.filter((ev) => ev.itemId === item.id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const delivered = new Set(mine.flatMap((ev) => ev.type === "delivered" ? [ev.ref] : []));
  const view = { ...item, owner: item.sessionId, status: "open", updatedAt: item.createdAt, feedback: [] };
  for (const ev of mine) {
    view.updatedAt = Math.max(view.updatedAt, ev.at);
    if (ev.type === "claim") view.owner = ev.by;
    if (ev.type === "promoted") view.issueUrl = ev.url;
    if (ev.type === "status") {
      view.status = ev.status;
      view.closedBy = ev.status === "open" ? void 0 : ev.actor;
      view.note = ev.note;
    }
    if (ev.type === "feedback") {
      const fb = { id: ev.id, text: ev.text, at: ev.at, isChoice: ev.isChoice, isDelivered: delivered.has(ev.id) };
      view.feedback.push(fb);
    }
  }
  return view;
};
var pendingFor = (owner, items, events) => {
  const delivered = new Set(events.flatMap((ev) => ev.type === "delivered" ? [ev.ref] : []));
  const replies = [];
  const notes = [];
  for (const item of items) {
    const view = foldItem(item, events);
    if (view.owner !== owner) continue;
    for (const ev of events) {
      if (ev.itemId !== item.id || delivered.has(ev.id)) continue;
      if (ev.type === "feedback") replies.push({ item: view, event: ev });
      if (ev.type === "status" && ev.actor === "user") notes.push({ item: view, event: ev });
    }
  }
  const byTime = (a, b) => a.event.at - b.event.at;
  return { replies: replies.sort(byTime), notes: notes.sort(byTime) };
};
var replyPrompt = (item, text, isChoice) => [
  `[Action Inbox] The user answered inbox item ${item.id} ("${item.title}") from the inbox pane.`,
  isChoice ? `They chose: ${text}` : `Their reply: ${text}`,
  `Act on it as their instruction. When the item is settled, call inbox_resolve with id ${item.id}; if it raises something new they must do or decide, call inbox_add.`
].join("\n");
var statusNote = (item, status, note) => `[Action Inbox] The user marked inbox item ${item.id} ("${item.title}") as ${status}${note ? `: ${note}` : ""}.`;
var HELP = [
  "/inbox                open the pane (/inbox all: every project)",
  "/inbox list           numbered list of open items, for the phone",
  "/inbox reply 3 text   reply to item #3; it goes to the session that raised it",
  "/inbox pick 3 2       choose option 2 of decision #3",
  "/inbox done 3 [note]  mark #3 done (dismiss works the same)",
  "/inbox issue 3        create a GitHub issue from #3",
  "/inbox open 3         open the session that raised #3 (desktop)",
  "/inbox add text       add your own item"
].join("\n");

// copilot/src/inbox.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
var GUIDE = [
  "# Action Inbox",
  "The user runs several agent sessions at once and loses track of what they owe each one. This session has an Action Inbox, a list shared across all their sessions (Copilot and Claude Code).",
  "- When you need the user to make a decision or do something by hand (a sign-off, a manual portal or secret setup, a device test, a review, a merge), call `inbox_add` once for that item, as well as saying it in chat. Give it a short imperative title and, for a decision, the options.",
  "- Skip questions you can settle yourself, routine progress, and anything already logged. PRs opened with `gh pr create` are logged automatically.",
  "- Context or a prompt that starts with `[Action Inbox]` is the user's own reply from their inbox: treat it as their instruction. When an item is settled, call `inbox_resolve`. `inbox_list` shows what is open.",
  '- When the user writes `inbox \u2026` (list, reply, pick, done, dismiss, add, issue), pass their words after "inbox" to `inbox_command` unchanged.'
].join("\n");
var inboxHome = () => process.env.ACTION_INBOX_HOME ?? join(homedir(), ".claude", "action-inbox");
var writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
};
var readJsonDir = (dir) => {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
    } catch {
    }
  }
  return out;
};
var git = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
var locate = (cwd) => {
  const remote = git(cwd, ["remote", "get-url", "origin"]) || null;
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const root = (common && /[\\/]\.git$/.test(common) ? dirname(common) : "") || git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const branch = git(cwd, ["branch", "--show-current"]) || void 0;
  return { ...projectKey(remote, root), root, branch };
};
var loadProject = (where) => {
  const dir = join(inboxHome(), where.key);
  return {
    key: where.key,
    name: where.name,
    dir,
    items: readJsonDir(join(dir, "items")),
    events: readJsonDir(join(dir, "events")),
    sessions: readJsonDir(join(dir, "sessions"))
  };
};
var saveProjectMeta = (where) => writeJson(join(inboxHome(), where.key, "project.json"), { key: where.key, name: where.name, root: where.root });
var heartbeat = (project, info) => {
  const prior = project.sessions.find((s) => s.sessionId === info.sessionId);
  const next = { ...prior, ...info, label: prior?.label ?? info.label, lastSeen: Date.now() };
  if (!next.isEnded) delete next.isEnded;
  writeJson(join(project.dir, "sessions", `${info.sessionId}.json`), next);
};
var addItem = (project, sessionId, fields) => {
  const now = Date.now();
  const item = { ...fields, id: newId("ib", now), sessionId, createdAt: now };
  writeJson(join(project.dir, "items", `${item.id}.json`), item);
  project.items.push(item);
  return item;
};
var addEvent = (project, by, body) => {
  const at = Date.now();
  const ev = { ...body, id: newId("ev", at), at, by };
  writeJson(join(project.dir, "events", `${ev.id}.json`), ev);
  project.events.push(ev);
  return ev;
};
var setStatus = (project, by, itemId, status, actor, note) => addEvent(project, by, { type: "status", itemId, status, actor, note });
var viewOf = (project, itemId) => {
  const item = project.items.find((i) => i.id === itemId);
  return item && foldItem(item, project.events);
};
var openOwnedBy = (project, sessionId) => project.items.map((i) => foldItem(i, project.events)).filter((v) => v.owner === sessionId && v.status === "open");
var takePending = (project, sessionId, opts = {}) => {
  const { replies, notes } = pendingFor(sessionId, project.items, project.events);
  if (opts.onlyIfReplies && replies.length === 0) return { replies: [], notes: [] };
  for (const { item, event: event2 } of [...replies, ...notes]) addEvent(project, sessionId, { type: "delivered", itemId: item.id, ref: event2.id });
  return {
    replies: replies.map(({ item, event: event2 }) => replyPrompt(item, event2.text, event2.isChoice)),
    notes: notes.map(({ item, event: event2 }) => statusNote(item, event2.status, event2.note))
  };
};
var USAGE = [
  "inbox list            numbered list of open items",
  "inbox reply 3 text    reply to item #3; it goes to the session that raised it",
  "inbox pick 3 2        choose option 2 of decision #3",
  "inbox done 3 [note]   mark #3 done (dismiss works the same)",
  "inbox issue 3         create a GitHub issue from #3",
  "inbox add text        add your own item"
].join("\n");
var cacheDir = () => process.env.PLUGIN_DATA ?? join(tmpdir(), "action-inbox-copilot");
var rememberWhere = (sessionId, where) => writeJson(join(cacheDir(), `${sessionId}.json`), where);
var recallWhere = (sessionId, cwd) => {
  const path = join(cacheDir(), `${sessionId}.json`);
  try {
    if (Date.now() - statSync(path).mtimeMs < 24 * 60 * 60 * 1e3) return JSON.parse(readFileSync(path, "utf8"));
  } catch {
  }
  const where = locate(cwd);
  rememberWhere(sessionId, where);
  return where;
};

// copilot/src/hook.ts
var INBOX_TOOL = /inbox_(add|resolve|list|command)$/;
var SHELL_TOOL = /^(bash|powershell|shell|run_in_terminal|runInTerminal)$/i;
var ASK_TOOL = /^(ask_user|AskUserQuestion)$/i;
var WAITING = "Waiting on your answer: ";
var parseMaybe = (value) => {
  if (typeof value === "string") {
    try {
      return parseMaybe(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
};
var textOf = (value) => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const v = value;
  if (typeof v.textResultForLlm === "string") return v.textResultForLlm;
  return JSON.stringify(value);
};
var normalise = (raw2) => ({
  sessionId: String(raw2.sessionId ?? raw2.session_id ?? ""),
  cwd: String(raw2.cwd ?? process.cwd()),
  toolName: String(raw2.toolName ?? raw2.tool_name ?? ""),
  toolArgs: parseMaybe(raw2.toolArgs ?? raw2.tool_input),
  resultText: textOf(raw2.toolResult ?? raw2.tool_response),
  prompt: typeof (raw2.initialPrompt ?? raw2.prompt) === "string" ? String(raw2.initialPrompt ?? raw2.prompt) : void 0,
  isClaudeShape: raw2.sessionId === void 0 && (raw2.session_id !== void 0 || raw2.hook_event_name !== void 0)
});
var contextOut = (p, event2, lines) => {
  if (lines.length === 0) return void 0;
  const additionalContext = lines.join("\n\n");
  return p.isClaudeShape ? { hookSpecificOutput: { hookEventName: event2, additionalContext } } : { additionalContext };
};
var closeWaiting = (project, sessionId, status, note) => {
  for (const item of openOwnedBy(project, sessionId)) {
    if (item.kind === "waiting") setStatus(project, sessionId, item.id, status, "auto", note);
  }
};
var handle = (event2, p) => {
  if (!p.sessionId) return void 0;
  if (event2 === "sessionStart") {
    const where2 = locate(p.cwd);
    rememberWhere(p.sessionId, where2);
    saveProjectMeta(where2);
    const project2 = loadProject(where2);
    heartbeat(project2, { sessionId: p.sessionId, branch: where2.branch, cwd: p.cwd, client: "copilot", label: p.prompt && clip(p.prompt, 60) });
    closeWaiting(project2, p.sessionId, "dismissed", "session restarted");
    const { replies, notes } = takePending(project2, p.sessionId);
    return contextOut(p, "SessionStart", [GUIDE, ...notes, ...replies]);
  }
  const where = recallWhere(p.sessionId, p.cwd);
  const project = loadProject(where);
  const beat = (isEnded) => heartbeat(project, { sessionId: p.sessionId, branch: where.branch, cwd: p.cwd, client: "copilot", isEnded });
  if (event2 === "userPromptSubmitted") {
    if (p.prompt && !p.prompt.startsWith("[Action Inbox]")) {
      heartbeat(project, { sessionId: p.sessionId, branch: where.branch, cwd: p.cwd, client: "copilot", label: clip(p.prompt, 60) });
    }
    if (!p.isClaudeShape) return void 0;
    const { replies, notes } = takePending(project, p.sessionId);
    return contextOut(p, "UserPromptSubmit", [...notes, ...replies]);
  }
  if (event2 === "preToolUse") {
    if (INBOX_TOOL.test(p.toolName)) {
      const modifiedArgs = { ...p.toolArgs, session: { id: p.sessionId, cwd: p.cwd } };
      return p.isClaudeShape ? void 0 : { modifiedArgs };
    }
    if (ASK_TOOL.test(p.toolName)) {
      const question = p.toolArgs.question ?? p.toolArgs.questions?.[0]?.question;
      addItem(project, p.sessionId, {
        kind: "waiting",
        title: `${WAITING}${clip(typeof question === "string" ? question : "a question", 110)}`,
        source: "auto",
        blocking: true
      });
    }
    return void 0;
  }
  if (event2 === "postToolUse") {
    beat();
    if (/inbox_add$/.test(p.toolName)) {
      const id = p.resultText.match(/\bib_[a-z0-9]+\b/)?.[0];
      const view = id ? viewOf(project, id) : void 0;
      if (view && view.owner !== p.sessionId) addEvent(project, p.sessionId, { type: "claim", itemId: view.id });
    }
    if (ASK_TOOL.test(p.toolName)) closeWaiting(project, p.sessionId, "done", "answered in the session");
    const command = typeof p.toolArgs.command === "string" ? p.toolArgs.command : "";
    if (SHELL_TOOL.test(p.toolName) && command) {
      if (isPrCreate(command)) {
        const pr = parsePrUrl(p.resultText);
        const isKnown = pr && project.items.some((i) => i.pr?.number === pr.number && i.pr?.repo === pr.repo);
        if (pr && !isKnown) {
          addItem(project, p.sessionId, {
            kind: "merge",
            title: `Review & merge PR #${pr.number}`,
            link: pr.url,
            pr: { repo: pr.repo, number: pr.number },
            source: "auto"
          });
        }
      }
      const merged = parseMergeTarget(command);
      if (merged && !/--auto\b/.test(command)) {
        for (const item of project.items) {
          const view = viewOf(project, item.id);
          const isTarget = view?.pr?.number === merged.number && (!merged.repo || view.pr.repo === merged.repo);
          if (view && isTarget && view.status === "open") setStatus(project, p.sessionId, view.id, "done", "auto", "merged with gh pr merge");
        }
      }
    }
    const { replies, notes } = takePending(project, p.sessionId);
    return contextOut(p, "PostToolUse", [...notes, ...replies]);
  }
  if (event2 === "agentStop") {
    beat();
    const { replies, notes } = takePending(project, p.sessionId, { onlyIfReplies: true });
    return replies.length ? { decision: "block", reason: [...notes, ...replies].join("\n\n") } : void 0;
  }
  if (event2 === "sessionEnd") {
    closeWaiting(project, p.sessionId, "dismissed", "session ended");
    beat(true);
  }
  return void 0;
};
var trace = (entry) => {
  const file = process.env.ACTION_INBOX_DEBUG;
  if (file) appendFileSync(file, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), ...entry })}
`);
};
var event = process.argv[2] ?? "";
var raw = {};
try {
  raw = parseMaybe(readFileSync2(0, "utf8"));
  const out = handle(event, normalise(raw));
  trace({ event, raw, out });
  if (out) process.stdout.write(JSON.stringify(out));
} catch (err) {
  try {
    trace({ event, raw, error: String(err.stack ?? err) });
  } catch {
  }
}
process.exitCode = 0;
