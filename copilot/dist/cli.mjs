// copilot/src/inbox.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  for (const project2 of loaded) {
    const sessions = new Map(project2.sessions.map((s) => [s.sessionId, s]));
    const groups = /* @__PURE__ */ new Map();
    for (const item of project2.items) {
      const view = foldItem(item, project2.events);
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
    if (list.length > 0 || project2.key === self.projectKey) {
      projects.push({ key: project2.key, name: project2.name, isSelf: project2.key === self.projectKey, groups: list });
    }
  }
  projects.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name));
  return { projects, openCount, blockingCount, selfOpenCount, updatedAt: now };
};
var openInOrder = (project2) => (project2?.groups ?? []).flatMap((g) => g.items.filter((i) => i.status === "open"));
var REF_VERBS = ["reply", "pick", "done", "dismiss", "issue", "open"];
var parseInboxArgs = (args2) => {
  const text = args2.trim();
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
var phoneList = (project2) => {
  const lines = [];
  let n = 0;
  for (const group of project2?.groups ?? []) {
    const open = group.items.filter((i) => i.status === "open");
    if (open.length === 0) continue;
    lines.push(`\u2014 ${group.branch ?? group.sessionId.slice(0, 8)}${group.isSelf ? " (this session)" : ""}`);
    for (const item of open) {
      n += 1;
      lines.push(`#${n} ${item.blocking ? "[BLOCKING] " : ""}[${item.kind}] ${item.title}`);
      if (item.options?.length) lines.push(`   options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join("  ")}`);
      if (item.issueUrl) lines.push(`   issue: ${item.issueUrl}`);
    }
  }
  if (n === 0) return "Nothing waiting on you.";
  return [`${n} open`, ...lines, "", "Reply: /inbox reply <n> <text> \xB7 pick: /inbox pick <n> <option> \xB7 done: /inbox done <n>"].join("\n");
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
var git = (cwd2, args2) => {
  try {
    return execFileSync("git", args2, { cwd: cwd2, encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
var locate = (cwd2) => {
  const remote = git(cwd2, ["remote", "get-url", "origin"]) || null;
  const common = git(cwd2, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const root = (common && /[\\/]\.git$/.test(common) ? dirname(common) : "") || git(cwd2, ["rev-parse", "--show-toplevel"]) || cwd2;
  const branch = git(cwd2, ["branch", "--show-current"]) || void 0;
  return { ...projectKey(remote, root), root, branch };
};
var loadProject = (where2) => {
  const dir = join(inboxHome(), where2.key);
  return {
    key: where2.key,
    name: where2.name,
    dir,
    items: readJsonDir(join(dir, "items")),
    events: readJsonDir(join(dir, "events")),
    sessions: readJsonDir(join(dir, "sessions"))
  };
};
var saveProjectMeta = (where2) => writeJson(join(inboxHome(), where2.key, "project.json"), { key: where2.key, name: where2.name, root: where2.root });
var heartbeat = (project2, info) => {
  const prior = project2.sessions.find((s) => s.sessionId === info.sessionId);
  const next = { ...prior, ...info, label: prior?.label ?? info.label, lastSeen: Date.now() };
  if (!next.isEnded) delete next.isEnded;
  writeJson(join(project2.dir, "sessions", `${info.sessionId}.json`), next);
};
var addItem = (project2, sessionId, fields) => {
  const now = Date.now();
  const item = { ...fields, id: newId("ib", now), sessionId, createdAt: now };
  writeJson(join(project2.dir, "items", `${item.id}.json`), item);
  project2.items.push(item);
  return item;
};
var addEvent = (project2, by, body) => {
  const at2 = Date.now();
  const ev = { ...body, id: newId("ev", at2), at: at2, by };
  writeJson(join(project2.dir, "events", `${ev.id}.json`), ev);
  project2.events.push(ev);
  return ev;
};
var setStatus = (project2, by, itemId, status, actor, note) => addEvent(project2, by, { type: "status", itemId, status, actor, note });
var snapshotOf = (project2, viewer, showClosed = false) => buildSnapshot([project2], { sessionId: viewer, projectKey: project2.key }, Date.now(), showClosed);
var sessionName = (project2, owner) => {
  const info = project2.sessions.find((s) => s.sessionId === owner);
  return [info?.branch, info?.label].filter(Boolean).join(" \u2014 ") || owner.slice(0, 8);
};
var promote = (project2, by, item) => {
  if (item.issueUrl) return `Already an issue: ${item.issueUrl}`;
  const repo = issueRepo(item, project2.name);
  if (!repo) return "This project has no GitHub repository to file the issue in.";
  let stdout = "";
  try {
    stdout = execFileSync(
      "gh",
      ["issue", "create", "--repo", repo, "--title", item.title, "--body", issueBody(item, sessionName(project2, item.owner))],
      { encoding: "utf8", timeout: 6e4, stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (err) {
    return `gh could not create the issue: ${clip(String(err.stderr ?? err), 160)}`;
  }
  const made = parseIssueUrl(stdout);
  if (!made) return "gh did not report the new issue.";
  addEvent(project2, by, { type: "promoted", itemId: item.id, url: made.url });
  return `Created issue #${made.number} in ${repo}.`;
};
var listOf = (project2) => phoneList(project2).replace(/\/inbox /g, "inbox ");
var USAGE = [
  "inbox list            numbered list of open items",
  "inbox reply 3 text    reply to item #3; it goes to the session that raised it",
  "inbox pick 3 2        choose option 2 of decision #3",
  "inbox done 3 [note]   mark #3 done (dismiss works the same)",
  "inbox issue 3         create a GitHub issue from #3",
  "inbox add text        add your own item"
].join("\n");
var runCommand = (project2, viewer, args2) => {
  const cmd = parseInboxArgs(args2);
  if (cmd.verb === "help") return USAGE;
  if (cmd.verb === "pane") return listOf(snapshotOf(project2, viewer).projects[0]);
  if (cmd.verb === "add") {
    const item2 = addItem(project2, viewer, { kind: "action", title: clip(cmd.text, 140), source: "user" });
    return `Added to the inbox: ${item2.title}`;
  }
  const self = snapshotOf(project2, viewer).projects[0];
  if (cmd.verb === "list") return listOf(self);
  const item = resolveRef(cmd.ref, openInOrder(self));
  if (!item) return `There is no open item ${cmd.ref}. "inbox list" shows the numbers.`;
  const where2 = sessionName(project2, item.owner);
  if (cmd.verb === "reply") {
    if (!cmd.text) return "Add your reply after the number: inbox reply 3 go ahead";
    addEvent(project2, viewer, { type: "feedback", itemId: item.id, text: clip(cmd.text, 2e3) });
    return `Reply sent to "${where2}".`;
  }
  if (cmd.verb === "pick") {
    const option = resolveOption(item, cmd.text);
    if (!option) {
      return item.options?.length ? `Options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join("  ")}` : "That item has no options; use inbox reply.";
    }
    addEvent(project2, viewer, { type: "feedback", itemId: item.id, text: option, isChoice: true });
    return `Chose "${option}"; sent to "${where2}".`;
  }
  if (cmd.verb === "done" || cmd.verb === "dismiss") {
    const status = cmd.verb === "done" ? "done" : "dismissed";
    setStatus(project2, viewer, item.id, status, "user", cmd.text ? clip(cmd.text, 200) : void 0);
    return `Marked "${item.title}" ${status}.`;
  }
  if (cmd.verb === "issue") return promote(project2, viewer, item);
  return "Opening sessions works only from the Claude Code pane.";
};

// copilot/src/cli.ts
var VIEWER = "terminal";
var argv = process.argv.slice(2);
var cwd = process.cwd();
var at = argv.indexOf("--cwd");
if (at >= 0) {
  cwd = argv[at + 1] ?? cwd;
  argv.splice(at, 2);
}
var where = locate(cwd);
saveProjectMeta(where);
var project = loadProject(where);
var args = argv.join(" ");
if (/^add\b/i.test(args.trim())) heartbeat(project, { sessionId: VIEWER, label: "added from the terminal" });
process.stdout.write(`Action Inbox \xB7 ${where.name}
${runCommand(project, VIEWER, args)}
`);
