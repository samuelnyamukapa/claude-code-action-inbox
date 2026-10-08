// copilot/src/server.ts
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

// copilot/src/server.ts
var VERSION = "0.3.0";
var PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var PR_POLL_MS = 5 * 60 * 1e3;
var UNKNOWN_SESSION = `copilot-${process.pid.toString(36)}`;
var send = (msg) => process.stdout.write(`${JSON.stringify(msg)}
`);
var rootCwd;
var canListRoots = false;
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
  }
];
var callTool = (name, input) => {
  const session = input.session ?? {};
  const sessionId = typeof session.id === "string" && session.id ? session.id : UNKNOWN_SESSION;
  const where = whereOf(typeof session.cwd === "string" && session.cwd ? session.cwd : void 0);
  const project = loadProject(where);
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
    description: "Action Inbox: list, reply, pick, done, dismiss, issue or add",
    arguments: [{ name: "command", description: 'e.g. "list" or "reply 3 go ahead" (empty lists)', required: false }]
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
      canListRoots = Boolean(params.capabilities?.roots);
      const asked = String(params.protocolVersion ?? "");
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: {}, prompts: {} },
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
      return { tools: TOOLS };
    case "tools/call": {
      try {
        const { text, isError } = callTool(String(params.name), params.arguments ?? {});
        return { content: [{ type: "text", text }], isError: Boolean(isError) };
      } catch (err) {
        return { content: [{ type: "text", text: `Action Inbox failed: ${clip(String(err), 300)}` }], isError: true };
      }
    }
    case "prompts/list":
      return { prompts: PROMPTS };
    case "prompts/get": {
      const command = String(params.arguments?.command ?? "").trim() || "list";
      return {
        description: "Action Inbox command",
        messages: [
          { role: "user", content: { type: "text", text: `Run my Action Inbox command with inbox_command, args "${command}", and show me the result.` } }
        ]
      };
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
