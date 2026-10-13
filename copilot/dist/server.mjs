// copilot/src/server.ts
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

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
var buildSnapshot = (loaded, self, now, showClosed) => {
  let openCount = 0;
  let blockingCount = 0;
  let selfOpenCount = 0;
  const projects = [];
  for (const project of loaded) {
    const sessions = new Map(project.sessions.map((s) => [s.sessionId, s]));
    const groups = /* @__PURE__ */ new Map();
    for (const item of project.items) {
      const view = foldItem(item, project.events);
      const isOpen = view.status === "open";
      if (isOpen) {
        openCount += 1;
        if (view.blocking) blockingCount += 1;
        if (view.owner === self.sessionId) selfOpenCount += 1;
      }
      const isRecent = now - view.updatedAt < RECENT_CLOSED_MS;
      if (!isOpen && !showClosed && !isRecent) continue;
      let group = groups.get(view.owner);
      if (!group) {
        const info = sessions.get(view.owner);
        const presence = info?.isEnded ? "ended" : info && now - info.lastSeen < LIVE_MS ? "live" : "idle";
        group = {
          sessionId: view.owner,
          branch: info?.branch,
          label: info?.label,
          client: info?.client,
          presence,
          isSelf: view.owner === self.sessionId,
          items: []
        };
        groups.set(view.owner, group);
      }
      group.items.push(view);
    }
    const rank = (v) => v.status === "open" ? v.blocking ? 0 : 1 : 2;
    const list = [...groups.values()];
    for (const group of list) group.items.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    const openIn = (g) => g.items.filter((i) => i.status === "open").length;
    list.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || openIn(b) - openIn(a));
    if (list.length > 0 || project.key === self.projectKey) {
      projects.push({ key: project.key, name: project.name, isSelf: project.key === self.projectKey, groups: list });
    }
  }
  projects.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));
  return { projects, openCount, blockingCount, selfOpenCount, updatedAt: now };
};
var openInOrder = (project) => (project?.groups ?? []).flatMap((g) => g.items.filter((i) => i.status === "open"));
var REF_VERBS = ["reply", "pick", "done", "dismiss", "issue", "open"];
var parseInboxArgs = (args) => {
  const text = args.trim();
  if (!text) return { verb: "pane", isAll: false };
  if (/^all$/i.test(text)) return { verb: "pane", isAll: true };
  const [, word = "", rest = ""] = text.match(/^(\S+)\s*([\s\S]*)$/) ?? [];
  const verb = word.toLowerCase();
  if (verb === "add") return rest.trim() ? { verb: "add", text: rest.trim() } : { verb: "help" };
  if (verb === "list" || verb === "ls") return { verb: "list" };
  const refVerb = REF_VERBS.find((v) => v === verb);
  if (refVerb) {
    const [, ref = "", more = ""] = rest.match(/^#?(\S+)\s*([\s\S]*)$/) ?? [];
    if (!ref) return { verb: "help" };
    return { verb: refVerb, ref, text: more.trim() };
  }
  return { verb: "help" };
};
var resolveRef = (ref, open) => /^\d+$/.test(ref) ? open[Number(ref) - 1] : open.find((i) => i.id === ref);
var resolveOption = (item, text) => {
  const options = item.options ?? [];
  if (/^\d+$/.test(text)) return options[Number(text) - 1];
  return options.find((o) => o.toLowerCase() === text.toLowerCase());
};
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
var phoneList = (project) => {
  const lines2 = [];
  let n = 0;
  for (const group of project?.groups ?? []) {
    const open = group.items.filter((i) => i.status === "open");
    if (open.length === 0) continue;
    lines2.push(`\u2014 ${group.branch ?? group.sessionId.slice(0, 8)}${group.isSelf ? " (this session)" : ""}`);
    for (const item of open) {
      n += 1;
      lines2.push(`#${n} ${item.blocking ? "[BLOCKING] " : ""}[${item.kind}] ${item.title}`);
      if (item.options?.length) lines2.push(`   options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join("  ")}`);
      if (item.issueUrl) lines2.push(`   issue: ${item.issueUrl}`);
    }
  }
  if (n === 0) return "Nothing waiting on you.";
  return [`${n} open`, ...lines2, "", "Reply: /inbox reply <n> <text> \xB7 pick: /inbox pick <n> <option> \xB7 done: /inbox done <n>"].join("\n");
};
var issueRepo = (item, projectName) => item.pr?.repo ?? (/^[\w.-]+\/[\w.-]+$/.test(projectName) ? projectName : void 0);
var issueBody = (item, sessionName2) => [
  item.detail ?? "",
  item.link ? `Link: ${item.link}` : "",
  item.options?.length ? `Options: ${item.options.join(" / ")}` : "",
  "---",
  `Promoted from the Action Inbox (item ${item.id}), raised in the Claude Code session "${sessionName2}".`
].filter(Boolean).join("\n\n");
var parseIssueUrl = (text) => {
  const [url, num] = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/) ?? [];
  return url && num ? { url, number: Number(num) } : void 0;
};

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
  "- When the user asks to see or open their inbox, call `inbox_view`: it shows a clickable, colour-coded view (or opens one in their browser where the chat cannot show it).",
  '- When the user writes `inbox \u2026` with a verb (list, reply, pick, done, dismiss, add, issue), pass their words after "inbox" to `inbox_command` unchanged.'
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
var snapshotOf = (project, viewer, showClosed = false) => buildSnapshot([project], { sessionId: viewer, projectKey: project.key }, Date.now(), showClosed);
var sessionName = (project, owner) => {
  const info = project.sessions.find((s) => s.sessionId === owner);
  return [info?.branch, info?.label].filter(Boolean).join(" \u2014 ") || owner.slice(0, 8);
};
var promote = (project, by, item) => {
  if (item.issueUrl) return `Already an issue: ${item.issueUrl}`;
  const repo = issueRepo(item, project.name);
  if (!repo) return "This project has no GitHub repository to file the issue in.";
  let stdout = "";
  try {
    stdout = execFileSync(
      "gh",
      ["issue", "create", "--repo", repo, "--title", item.title, "--body", issueBody(item, sessionName(project, item.owner))],
      { encoding: "utf8", timeout: 6e4, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    return `gh could not create the issue: ${clip(String(err.stderr ?? err), 160)}`;
  }
  const made = parseIssueUrl(stdout);
  if (!made) return "gh did not report the new issue.";
  addEvent(project, by, { type: "promoted", itemId: item.id, url: made.url });
  return `Created issue #${made.number} in ${repo}.`;
};
var listOf = (project) => phoneList(project).replace(/\/inbox /g, "inbox ");
var USAGE = [
  "inbox list            numbered list of open items",
  "inbox reply 3 text    reply to item #3; it goes to the session that raised it",
  "inbox pick 3 2        choose option 2 of decision #3",
  "inbox done 3 [note]   mark #3 done (dismiss works the same)",
  "inbox issue 3         create a GitHub issue from #3",
  "inbox add text        add your own item"
].join("\n");
var runCommand = (project, viewer, args) => {
  const cmd = parseInboxArgs(args);
  if (cmd.verb === "help") return USAGE;
  if (cmd.verb === "pane") return listOf(snapshotOf(project, viewer).projects[0]);
  if (cmd.verb === "add") {
    const item2 = addItem(project, viewer, { kind: "action", title: clip(cmd.text, 140), source: "user" });
    return `Added to the inbox: ${item2.title}`;
  }
  const self = snapshotOf(project, viewer).projects[0];
  if (cmd.verb === "list") return listOf(self);
  const item = resolveRef(cmd.ref, openInOrder(self));
  if (!item) return `There is no open item ${cmd.ref}. "inbox list" shows the numbers.`;
  const where = sessionName(project, item.owner);
  if (cmd.verb === "reply") {
    if (!cmd.text) return "Add your reply after the number: inbox reply 3 go ahead";
    addEvent(project, viewer, { type: "feedback", itemId: item.id, text: clip(cmd.text, 2e3) });
    return `Reply sent to "${where}".`;
  }
  if (cmd.verb === "pick") {
    const option = resolveOption(item, cmd.text);
    if (!option) {
      return item.options?.length ? `Options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join("  ")}` : "That item has no options; use inbox reply.";
    }
    addEvent(project, viewer, { type: "feedback", itemId: item.id, text: option, isChoice: true });
    return `Chose "${option}"; sent to "${where}".`;
  }
  if (cmd.verb === "done" || cmd.verb === "dismiss") {
    const status = cmd.verb === "done" ? "done" : "dismissed";
    setStatus(project, viewer, item.id, status, "user", cmd.text ? clip(cmd.text, 200) : void 0);
    return `Marked "${item.title}" ${status}.`;
  }
  if (cmd.verb === "issue") return promote(project, viewer, item);
  return "Opening sessions works only from the Claude Code pane.";
};
var listProjects = () => {
  let entries;
  try {
    entries = readdirSync(inboxHome());
  } catch {
    return [];
  }
  const out = [];
  for (const key of entries) {
    try {
      if (!statSync(join(inboxHome(), key)).isDirectory()) continue;
    } catch {
      continue;
    }
    let name = key;
    try {
      name = JSON.parse(readFileSync(join(inboxHome(), key, "project.json"), "utf8")).name ?? key;
    } catch {
    }
    out.push({ key, name });
  }
  return out;
};
var inboxView = (where, viewer, opts) => {
  const loaded = opts.scope === "all" ? listProjects().map(loadProject) : [loadProject(where)];
  if (!loaded.some((p) => p.key === where.key)) loaded.push(loadProject(where));
  return buildSnapshot(loaded, { sessionId: viewer, projectKey: where.key }, Date.now(), opts.showClosed);
};
var applyAction = (viewer, act) => {
  const meta = listProjects().find((p) => p.key === act.projectKey);
  if (!meta) return "That project is not in the inbox.";
  const project = loadProject(meta);
  const item = viewOf(project, act.id);
  if (!item) return "That item is no longer in the inbox.";
  const text = typeof act.text === "string" ? act.text.trim() : "";
  switch (act.action) {
    case "pick": {
      const option = item.options?.find((o) => o === text);
      if (!option) return "That is not one of its options.";
      addEvent(project, viewer, { type: "feedback", itemId: item.id, text: option, isChoice: true });
      return `Chose "${option}".`;
    }
    case "reply":
      if (!text) return "Write a reply first.";
      addEvent(project, viewer, { type: "feedback", itemId: item.id, text: clip(text, 2e3) });
      return "Reply sent.";
    case "done":
    case "dismiss":
      setStatus(project, viewer, item.id, act.action === "done" ? "done" : "dismissed", "user", text ? clip(text, 200) : void 0);
      return `Marked ${act.action === "done" ? "done" : "dismissed"}.`;
    case "reopen":
      setStatus(project, viewer, item.id, "open", "user");
      return "Reopened.";
    case "issue":
      return promote(project, viewer, item);
    default:
      return "Unknown action.";
  }
};
var pollPrs = (project, by, isMine) => {
  for (const view of project.items.map((i) => foldItem(i, project.events))) {
    if (view.status !== "open" || !view.pr || !isMine(view.owner)) continue;
    let state = "";
    try {
      state = execFileSync("gh", ["pr", "view", String(view.pr.number), "--repo", view.pr.repo, "--json", "state", "--jq", ".state"], {
        encoding: "utf8",
        timeout: 2e4,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    } catch {
      continue;
    }
    if (state === "MERGED") setStatus(project, by, view.id, "done", "auto", "merged on GitHub");
    if (state === "CLOSED") setStatus(project, by, view.id, "dismissed", "auto", "closed on GitHub without merging");
  }
};
var KINDS = ["decision", "action", "signoff", "review", "merge"];
var itemFromInput = (input) => {
  const title = typeof input.title === "string" ? clip(input.title, 140) : "";
  if (!title) return "inbox_add needs a title.";
  const link = typeof input.link === "string" && /^https:\/\/\S+$/.test(input.link) ? input.link : void 0;
  const pr = link ? parsePrUrl(link) : void 0;
  const options = Array.isArray(input.options) ? input.options.filter((o) => typeof o === "string").map((o) => clip(o, 60)).slice(0, 6) : [];
  return {
    kind: KINDS.includes(input.kind) ? input.kind : "action",
    title,
    detail: typeof input.detail === "string" ? clip(input.detail, 600) : void 0,
    options: options.length ? options : void 0,
    blocking: input.blocking === true || void 0,
    link,
    pr: pr ? { repo: pr.repo, number: pr.number } : void 0
  };
};

// copilot/src/ui/inbox.html
var inbox_default = "<!doctype html>\r\n<html lang=\"en\">\r\n<head>\r\n<meta charset=\"utf-8\">\r\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\r\n<title>Action Inbox</title>\r\n<style>\r\n  /* Signal colours are fixed and always carry white text at 4.5:1 or better,\r\n     so they read the same in light and dark themes, as in the Claude Code pane. */\r\n  :root {\r\n    color-scheme: light dark;\r\n    --orange: #C4510F;\r\n    --red: #C62828;\r\n    --amber: #B45309;\r\n    --rust: #7A2E0E;\r\n    --peach: #FCE3D3;\r\n    --live: #4ADE80;\r\n    --bg: var(--color-background-primary, light-dark(#ffffff, #1e1e1e));\r\n    --bg-2: var(--color-background-secondary, light-dark(#f6f6f6, #252526));\r\n    --fg: var(--color-text-primary, light-dark(#1f1f1f, #e8e8e8));\r\n    --fg-2: var(--color-text-secondary, light-dark(#5c5c5c, #a8a8a8));\r\n    --line: var(--color-border-secondary, light-dark(#d9d9d9, #3c3c3c));\r\n    --radius: var(--border-radius-md, 8px);\r\n    --font: var(--font-sans, system-ui, -apple-system, \"Segoe UI\", sans-serif);\r\n  }\r\n  * { box-sizing: border-box; }\r\n  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--font); }\r\n  body.app { background: transparent; }\r\n  main { max-width: 760px; margin: 0 auto; padding: 12px 16px 16px; }\r\n  body.app main { padding: 4px 2px 8px; }\r\n  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius); background: var(--orange); color: #fff; font-weight: 600; }\r\n  .bar.blocking { background: var(--red); }\r\n  .bar .count { flex: 1; min-width: 140px; }\r\n  .tools { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }\r\n  button { font: inherit; font-size: 13px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); color: var(--fg); cursor: pointer; min-height: 30px; }\r\n  button:hover { border-color: var(--fg-2); }\r\n  button:focus-visible, textarea:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }\r\n  button.primary { background: var(--orange); border-color: var(--orange); color: #fff; font-weight: 600; }\r\n  button.primary:hover { background: #A9450C; }\r\n  button.quiet { color: var(--fg-2); }\r\n  button.on-bar { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.45); color: #fff; }\r\n  button:disabled { opacity: .55; cursor: default; }\r\n  h2 { font-size: 15px; margin: 18px 0 8px; }\r\n  .group { margin-bottom: 14px; }\r\n  .ghead { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; padding: 5px 10px; border-radius: 6px; background: var(--rust); color: #fff; margin-bottom: 8px; }\r\n  .ghead .who { font-weight: 700; }\r\n  .ghead .meta { color: var(--peach); }\r\n  .dot { color: var(--peach); }\r\n  .dot.live { color: var(--live); }\r\n  .tag { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.2); color: #fff; }\r\n  .item { border: 1px solid var(--line); border-left: 5px solid var(--orange); border-radius: var(--radius); padding: 9px 11px; margin: 0 0 8px; background: var(--bg); }\r\n  .item.blocking { border-left-color: var(--red); }\r\n  .item.waiting { border-left-color: var(--amber); }\r\n  .item.closed { border-left-color: var(--line); opacity: .7; }\r\n  .title { font-weight: 600; overflow-wrap: anywhere; }\r\n  .item.closed .title { text-decoration: line-through; font-weight: 400; }\r\n  .chip { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .02em; padding: 1px 6px; border-radius: 4px; color: #fff; background: var(--orange); margin-right: 6px; vertical-align: 1px; }\r\n  .chip.blocking { background: var(--red); }\r\n  .chip.waiting { background: var(--amber); }\r\n  .chip.closed { background: #6b6b6b; }\r\n  .flag { color: var(--red); font-weight: 700; margin-right: 4px; }\r\n  .num, .age, .detail, .fb, .status, .hint { color: var(--fg-2); }\r\n  .detail { margin-top: 3px; white-space: pre-wrap; overflow-wrap: anywhere; }\r\n  .link { display: inline-block; margin-top: 3px; color: var(--orange); overflow-wrap: anywhere; cursor: pointer; text-decoration: underline; background: none; border: 0; padding: 0; min-height: 0; font-size: 13px; }\r\n  .fb { margin-top: 3px; font-size: 13px; }\r\n  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }\r\n  .reply { margin-top: 8px; display: flex; gap: 6px; align-items: flex-end; }\r\n  textarea { flex: 1; min-height: 56px; resize: vertical; font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }\r\n  .confirm { margin-top: 8px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }\r\n  .toast { position: sticky; bottom: 8px; margin-top: 10px; padding: 7px 11px; border-radius: 6px; background: var(--fg); color: var(--bg); font-size: 13px; }\r\n  .empty { color: var(--fg-2); padding: 14px 2px; }\r\n  .err { color: var(--red); }\r\n  @media (max-width: 480px) { main { padding: 8px 12px; } .reply { flex-direction: column; align-items: stretch; } }\r\n</style>\r\n</head>\r\n<body>\r\n<main id=\"root\"><p class=\"empty\">Loading the inbox\u2026</p></main>\r\n<script>\r\n(() => {\r\n  'use strict'\r\n  // Runs two ways: as an MCP App inside the chat (talking to the host over\r\n  // postMessage), or as a page in the browser (talking to the local inbox server).\r\n  const isApp = window.parent !== window\r\n  const api = window.__INBOX_API__\r\n  const root = document.getElementById('root')\r\n  if (isApp) document.body.classList.add('app')\r\n\r\n  const KIND = { decision: 'DECIDE', action: 'DO', signoff: 'SIGN OFF', review: 'REVIEW', merge: 'MERGE', waiting: 'WAITING' }\r\n  let payload = null\r\n  let session = undefined\r\n  let replyTo = null\r\n  let confirmIssue = null\r\n  let busy = false\r\n  let note = ''\r\n  let canOpenLinks = false\r\n  let noteTimer = 0\r\n  const say = text => {\r\n    note = text\r\n    clearTimeout(noteTimer)\r\n    noteTimer = setTimeout(() => { note = ''; render() }, 4000)\r\n  }\r\n\r\n  // ---------- talking to the host (MCP App) ----------\r\n  let nextId = 1\r\n  const pending = new Map()\r\n  const rpc = (method, params) => new Promise((resolve, reject) => {\r\n    const id = nextId++\r\n    pending.set(id, { resolve, reject })\r\n    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')\r\n  })\r\n  const notify = (method, params) => window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*')\r\n\r\n  const applyHost = ctx => {\r\n    if (!ctx) return\r\n    if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme\r\n    const vars = ctx.styles && ctx.styles.variables\r\n    if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v)\r\n  }\r\n\r\n  if (isApp) {\r\n    window.addEventListener('message', e => {\r\n      if (e.source !== window.parent) return\r\n      const m = e.data\r\n      if (!m || m.jsonrpc !== '2.0') return\r\n      if (m.method === undefined && pending.has(m.id)) {\r\n        const p = pending.get(m.id)\r\n        pending.delete(m.id)\r\n        m.error ? p.reject(new Error(m.error.message || 'Host error')) : p.resolve(m.result)\r\n        return\r\n      }\r\n      if (m.method === 'ui/notifications/tool-input') session = (m.params && m.params.arguments && m.params.arguments.session) || session\r\n      if (m.method === 'ui/notifications/tool-result') take(m.params && m.params.structuredContent)\r\n      if (m.method === 'ui/notifications/host-context-changed') applyHost(m.params)\r\n      if (m.method === 'ui/resource-teardown' && m.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*')\r\n    })\r\n  }\r\n\r\n  // ---------- one way to ask the server, in either mode ----------\r\n  const call = async (args) => {\r\n    const view = payload ? payload.view : { scope: 'project', showClosed: false }\r\n    const body = { scope: view.scope, showClosed: view.showClosed, ...args, session }\r\n    if (isApp) {\r\n      const result = await rpc('tools/call', { name: 'inbox_app_action', arguments: body })\r\n      if (result && result.isError) throw new Error(textOf(result) || 'The inbox could not do that.')\r\n      return result && result.structuredContent\r\n    }\r\n    const res = await fetch(`${api}/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })\r\n    if (!res.ok) throw new Error(await res.text())\r\n    return res.json()\r\n  }\r\n  const textOf = r => ((r && r.content) || []).map(c => c.text || '').join(' ')\r\n\r\n  const act = async (args) => {\r\n    if (busy) return\r\n    busy = true\r\n    render()\r\n    try {\r\n      take(await call(args))\r\n    } catch (err) {\r\n      say(String(err.message || err))\r\n    } finally {\r\n      busy = false\r\n      render()\r\n    }\r\n  }\r\n\r\n  const take = next => {\r\n    if (!next || !next.snapshot) return\r\n    payload = next\r\n    if (next.message) say(next.message)\r\n    render()\r\n  }\r\n\r\n  // the host sizes the frame to fit; report after every draw, not only on resize,\r\n  // because a hidden or off-screen frame gets no resize callbacks\r\n  let lastSize = ''\r\n  const reportSize = () => {\r\n    if (!isApp) return\r\n    const size = { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }\r\n    const key = `${size.width}x${size.height}`\r\n    if (key === lastSize) return\r\n    lastSize = key\r\n    notify('ui/notifications/size-changed', size)\r\n  }\r\n\r\n  // ---------- drawing ----------\r\n  const h = (tag, attrs, ...kids) => {\r\n    const el = document.createElement(tag)\r\n    for (const [k, v] of Object.entries(attrs || {})) {\r\n      if (v === undefined || v === null || v === false) continue\r\n      if (k.startsWith('on')) el.addEventListener(k.slice(2), v)\r\n      else if (k === 'class') el.className = v\r\n      else el.setAttribute(k, v === true ? '' : v)\r\n    }\r\n    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid))\r\n    return el\r\n  }\r\n  const btn = (label, onclick, cls) => h('button', { type: 'button', class: cls, onclick, disabled: busy || undefined }, label)\r\n\r\n  const age = (now, at) => {\r\n    const s = Math.max(0, Math.round((now - at) / 1000))\r\n    if (s < 60) return 'now'\r\n    if (s < 3600) return `${Math.floor(s / 60)}m`\r\n    if (s < 86400) return `${Math.floor(s / 3600)}h`\r\n    return `${Math.floor(s / 86400)}d`\r\n  }\r\n\r\n  const openLink = url => {\r\n    if (!/^https:\\/\\//.test(url)) return\r\n    if (isApp) rpc('ui/open-link', { url }).catch(() => { say('The host would not open that link.'); render() })\r\n    else window.open(url, '_blank', 'noopener')\r\n  }\r\n\r\n  const renderItem = (item, project, presence, num) => {\r\n    const isOpen = item.status === 'open'\r\n    const kindCls = !isOpen ? 'closed' : item.blocking ? 'blocking' : item.kind === 'waiting' ? 'waiting' : ''\r\n    const canReply = isOpen && item.kind !== 'waiting'\r\n    const repo = item.pr ? item.pr.repo : /^[\\w.-]+\\/[\\w.-]+$/.test(project.name) ? project.name : null\r\n    const canIssue = isOpen && item.kind !== 'waiting' && !item.issueUrl && repo\r\n    const base = { id: item.id, projectKey: project.key }\r\n    const delivered = fb => fb.isDelivered ? 'delivered' : presence === 'live' ? 'delivered at its next step' : 'delivered when that session resumes'\r\n\r\n    return h('article', { class: `item ${kindCls}` },\r\n      h('div', { class: 'title' },\r\n        h('span', { class: `chip ${kindCls}` }, KIND[item.kind] || item.kind.toUpperCase()),\r\n        item.blocking && isOpen ? h('span', { class: 'flag' }, 'BLOCKING') : null,\r\n        num ? h('span', { class: 'num' }, `#${num} `) : null,\r\n        item.title,\r\n        h('span', { class: 'age' }, ` \xB7 ${age(payload.snapshot.updatedAt, item.createdAt)}`)),\r\n      item.detail ? h('div', { class: 'detail' }, item.detail) : null,\r\n      item.link ? h('button', { type: 'button', class: 'link', onclick: () => openLink(item.link) }, item.link) : null,\r\n      item.issueUrl ? h('button', { type: 'button', class: 'link', onclick: () => openLink(item.issueUrl) }, `Issue: ${item.issueUrl}`) : null,\r\n      item.feedback.map(fb => h('div', { class: 'fb' }, `\u21B3 you ${fb.isChoice ? 'chose' : 'replied'}: ${fb.text} (${delivered(fb)})`)),\r\n      !isOpen ? h('div', { class: 'status' }, `${item.status} by ${item.closedBy || 'someone'}${item.note ? `: ${item.note}` : ''}`) : null,\r\n      item.kind === 'waiting' && isOpen ? h('div', { class: 'hint' }, 'Answer it in that session.') : null,\r\n      h('div', { class: 'actions' },\r\n        isOpen && item.kind === 'decision' ? (item.options || []).map(o => btn(o, () => act({ ...base, action: 'pick', text: o }), 'primary')) : null,\r\n        canReply ? btn(replyTo === item.id ? 'Cancel reply' : 'Reply', () => { replyTo = replyTo === item.id ? null : item.id; render() }) : null,\r\n        isOpen ? btn('Done', () => act({ ...base, action: 'done' })) : null,\r\n        isOpen ? btn('Dismiss', () => act({ ...base, action: 'dismiss' }), 'quiet') : null,\r\n        !isOpen ? btn('Reopen', () => act({ ...base, action: 'reopen' }), 'quiet') : null,\r\n        canIssue && confirmIssue !== item.id ? btn('Promote to issue', () => { confirmIssue = item.id; render() }, 'quiet') : null),\r\n      canIssue && confirmIssue === item.id ? h('div', { class: 'confirm' },\r\n        h('span', {}, `Create a GitHub issue in ${repo}?`),\r\n        btn('Create issue', () => { confirmIssue = null; act({ ...base, action: 'issue' }) }, 'primary'),\r\n        btn('Cancel', () => { confirmIssue = null; render() }, 'quiet')) : null,\r\n      replyTo === item.id ? replyBox(base) : null)\r\n  }\r\n\r\n  const replyBox = base => {\r\n    const area = h('textarea', { placeholder: 'Your reply goes to the session that raised this', 'aria-label': 'Reply' })\r\n    const send = () => {\r\n      const text = area.value.trim()\r\n      if (!text) return\r\n      replyTo = null\r\n      act({ ...base, action: 'reply', text })\r\n    }\r\n    area.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() })\r\n    setTimeout(() => area.focus(), 0)\r\n    return h('div', { class: 'reply' }, area, btn('Send', send, 'primary'))\r\n  }\r\n\r\n  const render = () => {\r\n    if (!payload) return\r\n    const { snapshot, view, webUrl } = payload\r\n    const self = snapshot.projects.find(p => p.isSelf)\r\n    const numbers = new Map()\r\n    let n = 0\r\n    for (const g of (self && self.groups) || []) for (const i of g.items) if (i.status === 'open') numbers.set(i.id, ++n)\r\n    const projects = snapshot.projects.filter(p => view.scope === 'all' || p.isSelf)\r\n    const isEmpty = projects.every(p => p.groups.length === 0)\r\n    const blocking = snapshot.blockingCount > 0\r\n\r\n    root.replaceChildren(...[\r\n      h('div', { class: `bar${blocking ? ' blocking' : ''}`, role: 'status' },\r\n        h('span', { class: 'count' }, `Action Inbox \xB7 ${snapshot.openCount} open${blocking ? ` \xB7 ${snapshot.blockingCount} blocking` : ''}${view.scope === 'all' ? ' \xB7 all projects' : ` \xB7 ${view.projectName}`}`),\r\n        isApp && webUrl && canOpenLinks ? btn('Open in browser', () => rpc('ui/open-link', { url: webUrl }).catch(() => {}), 'on-bar') : null),\r\n      h('div', { class: 'tools' },\r\n        btn(view.scope === 'all' ? 'This project' : 'All projects', () => act({ action: 'refresh', scope: view.scope === 'all' ? 'project' : 'all' })),\r\n        btn(view.showClosed ? 'Hide closed' : 'Show closed', () => act({ action: 'refresh', showClosed: !view.showClosed })),\r\n        btn('Refresh', () => act({ action: 'refresh' }), 'quiet')),\r\n      isEmpty ? h('p', { class: 'empty' }, 'Nothing waiting on you. Items appear here when a session needs a decision, a manual step or a merge.') : null,\r\n      projects.map(project => h('section', {},\r\n        view.scope === 'all' ? h('h2', {}, project.name) : null,\r\n        project.groups.map(g => h('div', { class: 'group' },\r\n          h('div', { class: 'ghead' },\r\n            h('span', { class: `dot${g.presence === 'live' ? ' live' : ''}`, 'aria-hidden': 'true' }, g.presence === 'live' ? '\u25CF' : '\u25CB'),\r\n            h('span', { class: 'who' }, g.branch || g.sessionId.slice(0, 8)),\r\n            g.client === 'copilot' ? h('span', { class: 'tag' }, 'Copilot') : g.client === 'claude' ? h('span', { class: 'tag' }, 'Claude') : null,\r\n            g.isSelf ? h('span', { class: 'tag' }, 'this session') : null,\r\n            h('span', { class: 'meta' }, `\xB7 ${g.presence} \xB7 ${g.items.filter(i => i.status === 'open').length} open${g.label ? ` \xB7 \u201C${g.label}\u201D` : ''}`)),\r\n          g.items.map(i => renderItem(i, project, g.presence, project.isSelf ? numbers.get(i.id) : undefined)))))),\r\n      note ? h('div', { class: 'toast', role: 'status' }, note) : null,\r\n    ].flat(Infinity).filter(Boolean))\r\n    reportSize()\r\n  }\r\n\r\n  // ---------- start ----------\r\n  const load = () => call({ action: 'refresh' }).then(take).catch(err => { if (!payload) root.replaceChildren(h('p', { class: 'err' }, `Could not load the inbox: ${err.message || err}`)) })\r\n  // background tabs skip the polling, never the first load\r\n  // and never while the user is typing a reply or confirming, which a redraw would wipe\r\n  const refresh = () => {\r\n    if (busy || replyTo !== null || confirmIssue !== null) return\r\n    if (document.visibilityState === 'visible' || !payload) load()\r\n  }\r\n\r\n  if (isApp) {\r\n    rpc('ui/initialize', { protocolVersion: '2026-01-26', appCapabilities: { availableDisplayModes: ['inline'] }, clientInfo: { name: 'action-inbox', version: '0.4.0' } })\r\n      .then(result => {\r\n        applyHost(result && result.hostContext)\r\n        canOpenLinks = Boolean(result && result.hostCapabilities && result.hostCapabilities.openLinks)\r\n        notify('ui/notifications/initialized', {})\r\n        new ResizeObserver(reportSize).observe(document.body)\r\n        reportSize()\r\n      })\r\n      .catch(() => { root.replaceChildren(h('p', { class: 'err' }, 'This host could not start the inbox view.')) })\r\n  } else {\r\n    refresh()\r\n  }\r\n  // other sessions add and answer items all the time\r\n  setInterval(refresh, isApp ? 10000 : 4000)\r\n})()\r\n</script>\r\n</body>\r\n</html>\r\n";

// copilot/src/web.ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
var started;
var readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 64 * 1024) {
      reject(new Error("too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var startWeb = (html, act) => {
  if (started) return started;
  started = new Promise((resolve, reject) => {
    const token = randomBytes(18).toString("base64url");
    let origin = "";
    const page = html.replace("<script>", `<script>window.__INBOX_API__ = ${JSON.stringify(`/${token}/api`)}</script>
<script>`);
    const server = createServer((req, res) => {
      const deny = (code, text) => {
        res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(text);
      };
      if (`http://${req.headers.host ?? ""}` !== origin) return deny(403, "Forbidden");
      const url = req.url ?? "/";
      if (req.method === "GET" && url === `/${token}/`) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        res.end(page);
        return;
      }
      if (req.method === "POST" && url === `/${token}/api/act`) {
        const from = req.headers.origin;
        if (from !== void 0 && from !== origin) return deny(403, "Forbidden");
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return deny(415, "Expected JSON");
        readBody(req).then(async (text) => {
          const out = await act(JSON.parse(text));
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(out));
        }).catch((err) => deny(400, String(err.message ?? err)));
        return;
      }
      deny(404, "Not found");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}`;
      server.unref();
      resolve(`${origin}/${token}/`);
    });
  });
  return started;
};
var openBrowser = (url) => {
  if (process.env.ACTION_INBOX_NO_BROWSER) return;
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => void 0).unref();
  } catch {
  }
};

// copilot/src/server.ts
var VERSION = "0.4.1";
var UI_URI = "ui://action-inbox/inbox.html";
var UI_MIME = "text/html;profile=mcp-app";
var PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var PR_POLL_MS = 5 * 60 * 1e3;
var UNKNOWN_SESSION = `copilot-${process.pid.toString(36)}`;
var send = (msg) => process.stdout.write(`${JSON.stringify(msg)}
`);
var rootCwd;
var canListRoots = false;
var canShowApps = false;
var lastSession = {};
var hasOpenedBrowser = false;
var located = /* @__PURE__ */ new Map();
var whereOf = (cwd) => {
  const dir = cwd ?? rootCwd ?? process.cwd();
  let where = located.get(dir);
  if (!where) {
    where = locate(dir);
    located.set(dir, where);
    saveProjectMeta(where);
  }
  return where;
};
var nextRequest = 1;
var waiting = /* @__PURE__ */ new Map();
var ask = (method, params) => new Promise((resolve) => {
  const id = `srv-${nextRequest++}`;
  waiting.set(id, resolve);
  send({ jsonrpc: "2.0", id, method, params });
  setTimeout(() => waiting.delete(id) && resolve(void 0), 5e3).unref();
});
var refreshRoots = async () => {
  if (!canListRoots) return;
  const result = await ask("roots/list");
  const uri = result?.roots?.find((r) => r.uri.startsWith("file:"))?.uri;
  if (uri) rootCwd = fileURLToPath(uri);
};
var SESSION_PROP = {
  type: "object",
  description: "Filled in automatically by the Action Inbox hooks; leave it out.",
  properties: { id: { type: "string" }, cwd: { type: "string" } }
};
var TOOLS = [
  {
    name: "inbox_add",
    description: "Log a decision or manual action the USER owes to their cross-session Action Inbox so it is not lost in the scroll. Use it alongside asking in chat, once per distinct item. Returns the item id; the user's reply arrives later as context starting with [Action Inbox].",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["decision", "action", "signoff", "review", "merge"],
          description: "decision = choose between options; action = a manual step; signoff = an approval only they can give; review/merge = look at or merge work"
        },
        title: { type: "string", description: 'Short imperative line, e.g. "Approve the ADR 0010 refresh window"' },
        detail: { type: "string", description: "One or two sentences of context: why it matters and what happens next" },
        options: { type: "array", items: { type: "string" }, description: "For a decision: 2-4 short option labels" },
        blocking: { type: "boolean", description: "True when this session cannot continue its current work without it" },
        link: { type: "string", description: "An https URL (PR, issue, doc) the user needs" },
        session: SESSION_PROP
      },
      required: ["kind", "title"]
    }
  },
  {
    name: "inbox_resolve",
    description: "Mark an Action Inbox item settled: done when the decision or action happened, dismissed when it no longer applies.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The item id (ib_...)" },
        status: { type: "string", enum: ["done", "dismissed"] },
        note: { type: "string", description: "What was decided or done, in a few words" },
        session: SESSION_PROP
      },
      required: ["id", "status"]
    }
  },
  {
    name: "inbox_list",
    description: "List the open Action Inbox items for this project, with the user's replies.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["session", "project"], description: "This session only (default) or the whole project" },
        session: SESSION_PROP
      }
    }
  },
  {
    name: "inbox_command",
    description: `Run the USER's own Action Inbox command, e.g. "list", "reply 3 go ahead", "pick 3 2", "done 3", "dismiss 3", "issue 3", "add Call the accountant". Call it ONLY when the user explicitly asks to act on their inbox, passing their words after "inbox" unchanged; never use it to answer items yourself. Show the user the result.`,
    inputSchema: {
      type: "object",
      properties: {
        args: { type: "string", description: `The user's words after "inbox", unchanged` },
        session: SESSION_PROP
      },
      required: ["args"]
    }
  },
  {
    name: "inbox_view",
    description: "Show the user's Action Inbox as an interactive view: colour-coded items with buttons to choose a decision's option, reply, mark done, dismiss, reopen or promote to a GitHub issue. Call it whenever the user asks to see, open or work through their inbox.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["project", "all"], description: "This project (default) or every project" },
        open_in_browser: { type: "boolean", description: "Also open the view in the browser; use it when the user asks or cannot see the view in the chat" },
        session: SESSION_PROP
      }
    },
    _meta: { ui: { resourceUri: UI_URI } }
  }
];
var APP_TOOL = {
  name: "inbox_app_action",
  description: "Used by the Action Inbox view's buttons on the user's behalf. Never call it yourself.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["refresh", "pick", "reply", "done", "dismiss", "reopen", "issue"] },
      id: { type: "string" },
      text: { type: "string" },
      projectKey: { type: "string" },
      scope: { type: "string", enum: ["project", "all"] },
      showClosed: { type: "boolean" },
      session: SESSION_PROP
    },
    required: ["action"]
  },
  _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] } }
};
var viewPayload = async (where, viewer, opts, message) => {
  const snapshot = inboxView(where, viewer, opts);
  const webUrl = await startWeb(inbox_default, webAct).catch(() => void 0);
  const self = snapshot.projects.find((p) => p.isSelf);
  const lines2 = [phoneList(self).replace(/\/inbox /g, "inbox ")];
  if (webUrl) lines2.push("", `Clickable inbox in your browser (works while this session runs): ${webUrl}`);
  return {
    text: lines2.join("\n"),
    structured: { snapshot, view: { ...opts, projectKey: where.key, projectName: where.name }, webUrl, message }
  };
};
var optsOf = (input) => ({ scope: input.scope === "all" ? "all" : "project", showClosed: input.showClosed === true });
var uiAct = async (input, viewer, where) => {
  const action = String(input.action ?? "refresh");
  let message;
  if (action !== "refresh") {
    message = applyAction(viewer, {
      action,
      id: String(input.id ?? ""),
      text: typeof input.text === "string" ? input.text : void 0,
      projectKey: String(input.projectKey ?? where.key)
    });
  }
  return viewPayload(where, viewer, optsOf(input), message);
};
var webAct = async (body) => {
  const where = whereOf(lastSession.cwd);
  return (await uiAct(body, lastSession.id ?? UNKNOWN_SESSION, where)).structured;
};
var callTool = async (name, input) => {
  const session = input.session ?? {};
  const sessionId = typeof session.id === "string" && session.id ? session.id : UNKNOWN_SESSION;
  if (sessionId !== UNKNOWN_SESSION) lastSession = { id: sessionId, cwd: typeof session.cwd === "string" ? session.cwd : void 0 };
  const where = whereOf(typeof session.cwd === "string" && session.cwd ? session.cwd : void 0);
  const project = loadProject(where);
  if (name === "inbox_view") {
    const out = await viewPayload(where, sessionId, optsOf(input));
    const webUrl = out.structured?.webUrl;
    const shouldOpen = input.open_in_browser === true || !canShowApps && !hasOpenedBrowser;
    if (shouldOpen && typeof webUrl === "string") {
      hasOpenedBrowser = true;
      openBrowser(webUrl);
      out.text += "\nOpened it in the browser.";
    }
    return out;
  }
  if (name === "inbox_app_action") return uiAct(input, sessionId, where);
  if (name === "inbox_add") {
    const fields = itemFromInput(input);
    if (typeof fields === "string") return { text: fields, isError: true };
    if (sessionId === UNKNOWN_SESSION) {
      heartbeat(project, { sessionId, branch: where.branch, cwd: where.root, client: "copilot", label: "Copilot session" });
    }
    const item = addItem(project, sessionId, { ...fields, source: "model" });
    return { text: `Logged inbox item ${item.id}. The user's reply, if any, will arrive as context starting with [Action Inbox].` };
  }
  if (name === "inbox_resolve") {
    const view = typeof input.id === "string" ? viewOf(project, input.id) : void 0;
    if (!view) return { text: `No inbox item ${String(input.id)} in this project.`, isError: true };
    const status = input.status === "dismissed" ? "dismissed" : "done";
    setStatus(project, sessionId, view.id, status, "model", typeof input.note === "string" ? clip(input.note, 200) : void 0);
    return { text: `Inbox item ${view.id} marked ${status}.` };
  }
  if (name === "inbox_list") {
    const isProject = input.scope === "project" || sessionId === UNKNOWN_SESSION;
    const lines2 = [];
    for (const group of snapshotOf(project, sessionId).projects[0]?.groups ?? []) {
      if (!isProject && !group.isSelf) continue;
      for (const item of group.items.filter((i) => i.status === "open")) {
        const who = group.isSelf ? "this session" : group.branch ?? group.label ?? group.sessionId.slice(0, 8);
        lines2.push(`- ${item.id} [${item.kind}${item.blocking ? ", blocking" : ""}] ${item.title} (${who})`);
        for (const fb of item.feedback) lines2.push(`  user ${fb.isChoice ? "chose" : "replied"}: ${fb.text}`);
      }
    }
    return { text: lines2.length ? lines2.join("\n") : "No open inbox items." };
  }
  if (name === "inbox_command") {
    return { text: runCommand(project, sessionId, typeof input.args === "string" ? input.args : "") };
  }
  return { text: `Unknown tool ${name}.`, isError: true };
};
var PROMPTS = [
  {
    name: "inbox",
    description: "Action Inbox: show it, or list, reply, pick, done, dismiss, issue or add",
    arguments: [{ name: "command", description: 'e.g. "reply 3 go ahead" (empty shows the inbox)', required: false }]
  }
];
var handle = async (msg) => {
  const method = typeof msg.method === "string" ? msg.method : void 0;
  if (!method) {
    const resolve = waiting.get(String(msg.id));
    if (resolve) {
      waiting.delete(String(msg.id));
      resolve(msg.result);
    }
    return void 0;
  }
  const params = msg.params ?? {};
  switch (method) {
    case "initialize": {
      const caps = params.capabilities ?? {};
      canListRoots = Boolean(caps.roots);
      const ui = (caps.extensions ?? {})["io.modelcontextprotocol/ui"];
      canShowApps = Boolean(ui?.mimeTypes?.includes(UI_MIME));
      if (process.env.ACTION_INBOX_DEBUG) {
        appendFileSync(process.env.ACTION_INBOX_DEBUG, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event: "mcp.initialize", clientInfo: params.clientInfo, capabilities: caps })}
`);
      }
      const asked = String(params.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: {}, prompts: {}, resources: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
        serverInfo: { name: "action-inbox", version: VERSION },
        instructions: GUIDE
      };
    }
    case "notifications/initialized":
    case "notifications/roots/list_changed":
      void refreshRoots();
      return void 0;
    case "ping":
      return {};
    case "tools/list":
      return { tools: canShowApps ? [...TOOLS, APP_TOOL] : TOOLS };
    case "tools/call": {
      try {
        const { text, isError, structured } = await callTool(String(params.name), params.arguments ?? {});
        return { content: [{ type: "text", text }], ...structured ? { structuredContent: structured } : {}, isError: Boolean(isError) };
      } catch (err) {
        return { content: [{ type: "text", text: `Action Inbox failed: ${clip(String(err), 300)}` }], isError: true };
      }
    }
    case "resources/list":
      return { resources: [{ uri: UI_URI, name: "Action Inbox", description: "The interactive inbox view", mimeType: UI_MIME }] };
    case "resources/read": {
      if (params.uri !== UI_URI) throw Object.assign(new Error(`Unknown resource ${String(params.uri)}`), { code: -32002 });
      return { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: inbox_default, _meta: { ui: { prefersBorder: false } } }] };
    }
    case "prompts/list":
      return { prompts: PROMPTS };
    case "prompts/get": {
      const command = String(params.arguments?.command ?? "").trim();
      const text = command ? `Run my Action Inbox command with inbox_command, args "${command}", and show me the result.` : "Show my Action Inbox with inbox_view.";
      return { description: "Action Inbox", messages: [{ role: "user", content: { type: "text", text } }] };
    }
    default:
      if (method.startsWith("notifications/")) return void 0;
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
};
var lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const hasId = msg.id !== void 0 && msg.id !== null;
  handle(msg).then(
    (result) => {
      if (hasId && msg.method) send({ jsonrpc: "2.0", id: msg.id, result: result ?? {} });
    },
    (err) => {
      if (hasId) send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  );
});
lines.on("close", () => process.exit(0));
setInterval(() => {
  try {
    const project = loadProject(whereOf(void 0));
    const groups = snapshotOf(project, UNKNOWN_SESSION).projects[0]?.groups ?? [];
    const mine = new Set(groups.filter((g) => g.client === "copilot" || g.presence !== "live").map((g) => g.sessionId));
    pollPrs(project, UNKNOWN_SESSION, (owner) => mine.has(owner));
  } catch {
  }
}, PR_POLL_MS).unref();
