var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// hooks/model.ts
var model_exports = {};
__export(model_exports, {
  HELP: () => HELP,
  LIVE_MS: () => LIVE_MS,
  RECENT_CLOSED_MS: () => RECENT_CLOSED_MS,
  age: () => age,
  buildSnapshot: () => buildSnapshot,
  clip: () => clip,
  deliveredRefs: () => deliveredRefs,
  foldItem: () => foldItem,
  isPrCreate: () => isPrCreate,
  issueBody: () => issueBody,
  issueRepo: () => issueRepo,
  newId: () => newId,
  openInOrder: () => openInOrder,
  parseInboxArgs: () => parseInboxArgs,
  parseIssueUrl: () => parseIssueUrl,
  parseMergeTarget: () => parseMergeTarget,
  parsePrUrl: () => parsePrUrl,
  pendingFor: () => pendingFor,
  phoneList: () => phoneList,
  projectKey: () => projectKey,
  replyPrompt: () => replyPrompt,
  resolveOption: () => resolveOption,
  resolveRef: () => resolveRef,
  statusNote: () => statusNote
});
var LIVE_MS, RECENT_CLOSED_MS, newId, projectKey, parsePrUrl, parseMergeTarget, isPrCreate, clip, age, deliveredRefs, foldItem, pendingFor, replyPrompt, statusNote, buildSnapshot, openInOrder, REF_VERBS, parseInboxArgs, resolveRef, resolveOption, HELP, phoneList, issueRepo, issueBody, parseIssueUrl;
var init_model = __esm({
  "hooks/model.ts"() {
    LIVE_MS = 3 * 60 * 1e3;
    RECENT_CLOSED_MS = 24 * 60 * 60 * 1e3;
    newId = (prefix, now) => {
      const rand = Math.random().toString(36).slice(2, 8);
      return `${prefix}_${now.toString(36)}${rand}`;
    };
    projectKey = (remote, root) => {
      const fromRemote = remote?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
      const name = fromRemote ?? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;
      const basis = fromRemote ?? root;
      const key = basis.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
      return { key: key || "unknown", name };
    };
    parsePrUrl = (text) => {
      const found = text.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
      const [url, repo, num] = found ?? [];
      if (!url || !repo || !num) return void 0;
      return { repo, number: Number(num), url };
    };
    parseMergeTarget = (command) => {
      if (!/\bgh\s+pr\s+merge\b/.test(command)) return void 0;
      const url = parsePrUrl(command);
      if (url) return { repo: url.repo, number: url.number };
      const num = command.match(/\bgh\s+pr\s+merge\s+(?:[^\n]*?\s)?#?(\d+)\b/);
      return num ? { number: Number(num[1]) } : void 0;
    };
    isPrCreate = (command) => /\bgh\s+pr\s+create\b/.test(command);
    clip = (text, max) => {
      const flat = text.replace(/\s+/g, " ").trim();
      return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
    };
    age = (now, at) => {
      const s = Math.max(0, Math.round((now - at) / 1e3));
      if (s < 60) return "now";
      if (s < 3600) return `${Math.floor(s / 60)}m`;
      if (s < 86400) return `${Math.floor(s / 3600)}h`;
      return `${Math.floor(s / 86400)}d`;
    };
    deliveredRefs = (events) => {
      const lastDelivered = /* @__PURE__ */ new Map();
      const lastFailed = /* @__PURE__ */ new Map();
      for (const ev of events) {
        if (ev.type === "delivered") lastDelivered.set(ev.ref, Math.max(lastDelivered.get(ev.ref) ?? 0, ev.at));
        if (ev.type === "wake" && !ev.ok) lastFailed.set(ev.ref, Math.max(lastFailed.get(ev.ref) ?? 0, ev.at));
      }
      const out = /* @__PURE__ */ new Set();
      for (const [ref, at] of lastDelivered) if (at > (lastFailed.get(ref) ?? 0)) out.add(ref);
      return out;
    };
    foldItem = (item, events) => {
      const mine = events.filter((ev) => ev.itemId === item.id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      const delivered = deliveredRefs(mine);
      const wakes = new Map(mine.flatMap((ev) => ev.type === "wake" ? [[ev.ref, { ok: ev.ok, detail: ev.detail }]] : []));
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
          const fb = { id: ev.id, text: ev.text, at: ev.at, isChoice: ev.isChoice, isDelivered: delivered.has(ev.id), wake: wakes.get(ev.id) };
          view.feedback.push(fb);
        }
      }
      return view;
    };
    pendingFor = (owner, items, events) => {
      const delivered = deliveredRefs(events);
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
    replyPrompt = (item, text, isChoice) => [
      `[Action Inbox] The user answered inbox item ${item.id} ("${item.title}") from the inbox pane.`,
      isChoice ? `They chose: ${text}` : `Their reply: ${text}`,
      `Act on it as their instruction. When the item is settled, call inbox_resolve with id ${item.id}; if it raises something new they must do or decide, call inbox_add.`
    ].join("\n");
    statusNote = (item, status, note) => `[Action Inbox] The user marked inbox item ${item.id} ("${item.title}") as ${status}${note ? `: ${note}` : ""}.`;
    buildSnapshot = (loaded, self, now, showClosed) => {
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
    openInOrder = (project) => (project?.groups ?? []).flatMap((g) => g.items.filter((i) => i.status === "open"));
    REF_VERBS = ["reply", "pick", "done", "dismiss", "issue", "open"];
    parseInboxArgs = (args) => {
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
    resolveRef = (ref, open) => /^\d+$/.test(ref) ? open[Number(ref) - 1] : open.find((i) => i.id === ref);
    resolveOption = (item, text) => {
      const options = item.options ?? [];
      if (/^\d+$/.test(text)) return options[Number(text) - 1];
      return options.find((o) => o.toLowerCase() === text.toLowerCase());
    };
    HELP = [
      "/inbox                open the pane (/inbox all: every project)",
      "/inbox list           numbered list of open items, for the phone",
      "/inbox reply 3 text   reply to item #3; it goes to the session that raised it",
      "/inbox pick 3 2       choose option 2 of decision #3",
      "/inbox done 3 [note]  mark #3 done (dismiss works the same)",
      "/inbox issue 3        create a GitHub issue from #3",
      "/inbox open 3         open the session that raised #3 (desktop)",
      "/inbox add text       add your own item"
    ].join("\n");
    phoneList = (project) => {
      const lines = [];
      let n = 0;
      for (const group of project?.groups ?? []) {
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
    issueRepo = (item, projectName) => item.pr?.repo ?? (/^[\w.-]+\/[\w.-]+$/.test(projectName) ? projectName : void 0);
    issueBody = (item, sessionName2) => [
      item.detail ?? "",
      item.link ? `Link: ${item.link}` : "",
      item.options?.length ? `Options: ${item.options.join(" / ")}` : "",
      "---",
      `Promoted from the Action Inbox (item ${item.id}), raised in the Claude Code session "${sessionName2}".`
    ].filter(Boolean).join("\n\n");
    parseIssueUrl = (text) => {
      const [url, num] = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/) ?? [];
      return url && num ? { url, number: Number(num) } : void 0;
    };
  }
});

// copilot/src/inbox.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
var GUIDE, inboxHome, writeJson, readJsonDir, loadProject, heartbeat, addEvent, setStatus, viewOf, sessionName, promote, USAGE, listProjects, inboxView, applyAction;
var init_inbox = __esm({
  "copilot/src/inbox.ts"() {
    "use strict";
    init_model();
    GUIDE = [
      "# Action Inbox",
      "The user runs several agent sessions at once and loses track of what they owe each one. This session has an Action Inbox, a list shared across all their sessions (Copilot and Claude Code).",
      "- When you need the user to make a decision or do something by hand (a sign-off, a manual portal or secret setup, a device test, a review, a merge), call `inbox_add` once for that item, as well as saying it in chat. Give it a short imperative title and, for a decision, the options.",
      "- Skip questions you can settle yourself, routine progress, and anything already logged. PRs opened with `gh pr create` are logged automatically.",
      "- Context or a prompt that starts with `[Action Inbox]` is the user's own reply from their inbox: treat it as their instruction. When an item is settled, call `inbox_resolve`. `inbox_list` shows what is open.",
      '- When the user asks to see or open their inbox, call `inbox_view`, then always give them its "Open your Action Inbox" link as a markdown link: the app opens it in its browser panel, where they can click to answer, reply or close items.',
      '- When the user writes `inbox \u2026` with a verb (list, reply, pick, done, dismiss, add, issue, doctor), pass their words after "inbox" to `inbox_command` unchanged.'
    ].join("\n");
    inboxHome = () => process.env.ACTION_INBOX_HOME ?? join(homedir(), ".claude", "action-inbox");
    writeJson = (path, value) => {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(value));
      renameSync(temp, path);
    };
    readJsonDir = (dir) => {
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
    loadProject = (where) => {
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
    heartbeat = (project, info) => {
      const prior = project.sessions.find((s) => s.sessionId === info.sessionId);
      const next = { ...prior, ...info, label: prior?.label ?? info.label, lastSeen: Date.now() };
      if (!next.isEnded) delete next.isEnded;
      writeJson(join(project.dir, "sessions", `${info.sessionId}.json`), next);
    };
    addEvent = (project, by, body) => {
      const at = Date.now();
      const ev = { ...body, id: newId("ev", at), at, by };
      writeJson(join(project.dir, "events", `${ev.id}.json`), ev);
      project.events.push(ev);
      return ev;
    };
    setStatus = (project, by, itemId, status, actor, note) => addEvent(project, by, { type: "status", itemId, status, actor, note });
    viewOf = (project, itemId) => {
      const item = project.items.find((i) => i.id === itemId);
      return item && foldItem(item, project.events);
    };
    sessionName = (project, owner) => {
      const info = project.sessions.find((s) => s.sessionId === owner);
      return [info?.branch, info?.label].filter(Boolean).join(" \u2014 ") || owner.slice(0, 8);
    };
    promote = (project, by, item) => {
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
    USAGE = [
      "inbox list            numbered list of open items",
      "inbox reply 3 text    reply to item #3; it goes to the session that raised it",
      "inbox pick 3 2        choose option 2 of decision #3",
      "inbox done 3 [note]   mark #3 done (dismiss works the same)",
      "inbox issue 3         create a GitHub issue from #3",
      "inbox add text        add your own item"
    ].join("\n");
    listProjects = () => {
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
    inboxView = (where, viewer, opts) => {
      const loaded = opts.scope === "all" ? listProjects().map(loadProject) : [loadProject(where)];
      if (!loaded.some((p) => p.key === where.key)) loaded.push(loadProject(where));
      return buildSnapshot(loaded, { sessionId: viewer, projectKey: where.key }, Date.now(), opts.showClosed);
    };
    applyAction = (viewer, act2) => {
      const meta = listProjects().find((p) => p.key === act2.projectKey);
      if (!meta) return "That project is not in the inbox.";
      const project = loadProject(meta);
      const item = viewOf(project, act2.id);
      if (!item) return "That item is no longer in the inbox.";
      const text = typeof act2.text === "string" ? act2.text.trim() : "";
      switch (act2.action) {
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
          setStatus(project, viewer, item.id, act2.action === "done" ? "done" : "dismissed", "user", text ? clip(text, 200) : void 0);
          return `Marked ${act2.action === "done" ? "done" : "dismissed"}.`;
        case "reopen":
          setStatus(project, viewer, item.id, "open", "user");
          return "Reopened.";
        case "issue":
          return promote(project, viewer, item);
        default:
          return "Unknown action.";
      }
    };
  }
});

// copilot/src/wake.ts
var wake_exports = {};
__export(wake_exports, {
  canWake: () => canWake,
  configPath: () => configPath,
  copilotHome: () => copilotHome,
  holdsOf: () => holdsOf,
  isHeld: () => isHeld,
  readConfig: () => readConfig,
  wakeBlock: () => wakeBlock,
  wakePass: () => wakePass,
  wakeStatusOf: () => wakeStatusOf
});
import { spawn } from "node:child_process";
import { closeSync, existsSync as existsSync2, mkdirSync as mkdirSync2, openSync, readdirSync as readdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var DEFAULTS, RUNNING_STALE_MS, configPath, readConfig, copilotHome, isAlive, holdsOf, isHeld, wakeBlock, canWake, wakeStatusOf, claim, copilotCommand, wakeOne, wakePass;
var init_wake = __esm({
  "copilot/src/wake.ts"() {
    "use strict";
    init_model();
    init_inbox();
    DEFAULTS = { wake: "on", wakeArgs: [] };
    RUNNING_STALE_MS = 15 * 60 * 1e3;
    configPath = () => join2(inboxHome(), "config.json");
    readConfig = () => {
      try {
        const raw = JSON.parse(readFileSync2(configPath(), "utf8"));
        return {
          wake: raw.wake === "off" || raw.wake === "always" ? raw.wake : "on",
          // these reach a shell on Windows, so only plain flags and values pass
          wakeArgs: Array.isArray(raw.wakeArgs) ? raw.wakeArgs.filter((a) => typeof a === "string" && /^[\w=.:,@/+-]+$/.test(a)) : []
        };
      } catch {
        return DEFAULTS;
      }
    };
    copilotHome = () => process.env.COPILOT_HOME ?? join2(homedir2(), ".copilot");
    isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return err.code === "EPERM";
      }
    };
    holdsOf = (sessionId) => {
      const dir = join2(copilotHome(), "session-state", sessionId);
      let names;
      try {
        names = readdirSync2(dir);
      } catch {
        return void 0;
      }
      const holds = [];
      for (const name of names) {
        const pid = Number(name.match(/^inuse\.(\d+)\.hold$/)?.[1]);
        if (!(pid > 0)) continue;
        const file = join2(dir, name);
        let isLive = false;
        if (pid !== process.pid) {
          if (process.platform === "win32") {
            try {
              readFileSync2(file);
            } catch (err) {
              isLive = err.code === "EBUSY";
            }
          } else {
            isLive = isAlive(pid);
          }
        }
        holds.push({ file, pid, isLive });
      }
      return holds;
    };
    isHeld = (sessionId) => holdsOf(sessionId)?.some((h) => h.isLive);
    wakeBlock = (session, cfg, now) => {
      if (!session || session.client !== "copilot" || !/^[\w-]+$/.test(session.sessionId)) return "not-copilot";
      if (cfg.wake === "off") return "off";
      if (session.turn === "running" && now - session.lastSeen < RUNNING_STALE_MS) return "mid-turn";
      const held = isHeld(session.sessionId);
      if (held === true && cfg.wake !== "always") return "open";
      if (held === void 0 && !session.isEnded && cfg.wake !== "always") return "unknown-open";
      return void 0;
    };
    canWake = (session, cfg, now) => wakeBlock(session, cfg, now) === void 0;
    wakeStatusOf = (sessions, cfg = readConfig()) => {
      const now = Date.now();
      const out = {};
      for (const session of sessions) {
        if (session.client !== "copilot") continue;
        out[session.sessionId] = wakeBlock(session, cfg, now) ?? "ready";
      }
      return out;
    };
    claim = (dir, ref) => {
      mkdirSync2(dir, { recursive: true });
      try {
        closeSync(openSync(join2(dir, `${ref}.lock`), "wx"));
        return true;
      } catch {
        return false;
      }
    };
    copilotCommand = (args) => {
      const custom = process.env.ACTION_INBOX_COPILOT_CMD;
      if (custom) {
        const [cmd = "copilot", ...pre] = JSON.parse(custom);
        return { cmd, args: [...pre, ...args], shell: false };
      }
      return { cmd: "copilot", args, shell: process.platform === "win32" };
    };
    wakeOne = (project, session, cfg) => {
      const { replies, notes } = pendingFor(session.sessionId, project.items, project.events);
      const fresh = replies.filter((r) => claim(join2(project.dir, "wake"), r.event.id));
      if (fresh.length === 0) return void 0;
      const by = `waker:${process.pid}`;
      for (const { item, event } of [...fresh, ...notes]) addEvent(project, by, { type: "delivered", itemId: item.id, ref: event.id });
      heartbeat(project, { sessionId: session.sessionId, client: "copilot", turn: "running" });
      const prompt = [
        ...notes.map(({ item, event }) => statusNote(item, event.status, event.note)),
        ...fresh.map(({ item, event }) => replyPrompt(item, event.text, event.isChoice))
      ].join("\n\n");
      const logDir = join2(inboxHome(), ".wake-logs");
      mkdirSync2(logDir, { recursive: true });
      const logPath = join2(logDir, `${session.sessionId}.log`);
      writeFileSync2(logPath, `${(/* @__PURE__ */ new Date()).toISOString()} resuming with:
${prompt}
---
`, { flag: "a" });
      const out = openSync(logPath, "a");
      const record = (ok, detail) => {
        for (const { item, event } of fresh) addEvent(project, by, { type: "wake", itemId: item.id, ref: event.id, ok, detail });
        if (!ok) heartbeat(project, { sessionId: session.sessionId, client: "copilot", turn: "idle" });
        return { sessionId: session.sessionId, refs: fresh.map((f) => f.event.id), ok, detail };
      };
      return new Promise((resolve2) => {
        const { cmd, args, shell } = copilotCommand(["--resume", session.sessionId, "--allow-tool=action-inbox", ...cfg.wakeArgs]);
        const cwd = session.cwd && existsSync2(session.cwd) ? session.cwd : homedir2();
        let isDone = false;
        const finish = (ok, detail) => {
          if (isDone) return;
          isDone = true;
          closeSync(out);
          resolve2(record(ok, detail));
        };
        try {
          const child = spawn(cmd, args, { cwd, shell, stdio: ["pipe", out, out], windowsHide: true, env: process.env });
          child.on("error", (err) => finish(false, err.code === "ENOENT" ? "Copilot CLI (copilot) is not on PATH" : String(err)));
          child.on("exit", (code) => finish(code === 0, code === 0 ? void 0 : `copilot exited with code ${code}; see ${logPath}`));
          child.stdin?.on("error", () => void 0);
          child.stdin?.end(prompt);
        } catch (err) {
          finish(false, String(err));
        }
      });
    };
    wakePass = (cfg = readConfig()) => {
      if (cfg.wake === "off") return [];
      const now = Date.now();
      const started = [];
      for (const meta of listProjects()) {
        const project = loadProject(meta);
        for (const session of project.sessions) {
          if (!canWake(session, cfg, now)) continue;
          const run = wakeOne(project, session, cfg);
          if (run) started.push(run);
        }
      }
      return started;
    };
  }
});

// copilot/src/daemon.ts
init_inbox();
import { spawn as spawn2 } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { createServer } from "node:http";
import { join as join3 } from "node:path";

// copilot/src/ui/inbox.html
var inbox_default = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Action Inbox</title>\n<style>\n  /* Signal colours are fixed and always carry white text at 4.5:1 or better,\n     so they read the same in light and dark themes, as in the Claude Code pane. */\n  :root {\n    color-scheme: light dark;\n    --orange: #C4510F;\n    --red: #C62828;\n    --amber: #B45309;\n    --rust: #7A2E0E;\n    --peach: #FCE3D3;\n    --live: #4ADE80;\n    --bg: var(--color-background-primary, light-dark(#ffffff, #1e1e1e));\n    --bg-2: var(--color-background-secondary, light-dark(#f6f6f6, #252526));\n    --fg: var(--color-text-primary, light-dark(#1f1f1f, #e8e8e8));\n    --fg-2: var(--color-text-secondary, light-dark(#5c5c5c, #a8a8a8));\n    --line: var(--color-border-secondary, light-dark(#d9d9d9, #3c3c3c));\n    --radius: var(--border-radius-md, 8px);\n    --font: var(--font-sans, system-ui, -apple-system, \"Segoe UI\", sans-serif);\n  }\n  * { box-sizing: border-box; }\n  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 var(--font); }\n  body.app { background: transparent; }\n  main { max-width: 760px; margin: 0 auto; padding: 12px 16px 16px; }\n  body.app main { padding: 4px 2px 8px; }\n  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius); background: var(--orange); color: #fff; font-weight: 600; }\n  .bar.blocking { background: var(--red); }\n  .bar .count { flex: 1; min-width: 140px; }\n  .tools { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0; }\n  button { font: inherit; font-size: 13px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg-2); color: var(--fg); cursor: pointer; min-height: 30px; }\n  button:hover { border-color: var(--fg-2); }\n  button:focus-visible, textarea:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }\n  button.primary { background: var(--orange); border-color: var(--orange); color: #fff; font-weight: 600; }\n  button.primary:hover { background: #A9450C; }\n  button.quiet { color: var(--fg-2); }\n  button.on-bar { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.45); color: #fff; }\n  button:disabled { opacity: .55; cursor: default; }\n  h2 { font-size: 15px; margin: 18px 0 8px; }\n  .group { margin-bottom: 14px; }\n  .ghead { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; padding: 5px 10px; border-radius: 6px; background: var(--rust); color: #fff; margin-bottom: 8px; }\n  .ghead .who { font-weight: 700; }\n  .ghead .meta { color: var(--peach); }\n  .dot { color: var(--peach); }\n  .dot.live { color: var(--live); }\n  .tag { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.2); color: #fff; }\n  .item { border: 1px solid var(--line); border-left: 5px solid var(--orange); border-radius: var(--radius); padding: 9px 11px; margin: 0 0 8px; background: var(--bg); }\n  .item.blocking { border-left-color: var(--red); }\n  .item.waiting { border-left-color: var(--amber); }\n  .item.closed { border-left-color: var(--line); opacity: .7; }\n  .title { font-weight: 600; overflow-wrap: anywhere; }\n  .item.closed .title { text-decoration: line-through; font-weight: 400; }\n  .chip { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .02em; padding: 1px 6px; border-radius: 4px; color: #fff; background: var(--orange); margin-right: 6px; vertical-align: 1px; }\n  .chip.blocking { background: var(--red); }\n  .chip.waiting { background: var(--amber); }\n  .chip.closed { background: #6b6b6b; }\n  .flag { color: var(--red); font-weight: 700; margin-right: 4px; }\n  .num, .age, .detail, .fb, .status, .hint { color: var(--fg-2); }\n  .detail { margin-top: 3px; white-space: pre-wrap; overflow-wrap: anywhere; }\n  .link { display: inline-block; margin-top: 3px; color: var(--orange); overflow-wrap: anywhere; cursor: pointer; text-decoration: underline; background: none; border: 0; padding: 0; min-height: 0; font-size: 13px; }\n  .fb { margin-top: 3px; font-size: 13px; }\n  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }\n  .reply { margin-top: 8px; display: flex; gap: 6px; align-items: flex-end; }\n  textarea { flex: 1; min-height: 56px; resize: vertical; font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }\n  .confirm { margin-top: 8px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }\n  .toast { position: sticky; bottom: 8px; margin-top: 10px; padding: 7px 11px; border-radius: 6px; background: var(--fg); color: var(--bg); font-size: 13px; }\n  .empty { color: var(--fg-2); padding: 14px 2px; }\n  .err { color: var(--red); }\n  @media (max-width: 480px) { main { padding: 8px 12px; } .reply { flex-direction: column; align-items: stretch; } }\n</style>\n</head>\n<body>\n<main id=\"root\"><p class=\"empty\">Loading the inbox\u2026</p></main>\n<script>\n(() => {\n  'use strict'\n  // Runs two ways: as an MCP App inside the chat (talking to the host over\n  // postMessage), or as a page in the browser (talking to the local inbox server).\n  const isApp = window.parent !== window\n  const api = window.__INBOX_API__\n  // the link names the project to show; the page keeps it as you click around\n  const linkedProject = new URLSearchParams(location.search).get('project') || undefined\n  const root = document.getElementById('root')\n  if (isApp) document.body.classList.add('app')\n\n  const KIND = { decision: 'DECIDE', action: 'DO', signoff: 'SIGN OFF', review: 'REVIEW', merge: 'MERGE', waiting: 'WAITING' }\n  let payload = null\n  let session = undefined\n  let replyTo = null\n  let confirmIssue = null\n  let busy = false\n  let note = ''\n  let canOpenLinks = false\n  let noteTimer = 0\n  const say = text => {\n    note = text\n    clearTimeout(noteTimer)\n    noteTimer = setTimeout(() => { note = ''; render() }, 4000)\n  }\n\n  // ---------- talking to the host (MCP App) ----------\n  let nextId = 1\n  const pending = new Map()\n  const rpc = (method, params) => new Promise((resolve, reject) => {\n    const id = nextId++\n    pending.set(id, { resolve, reject })\n    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')\n  })\n  const notify = (method, params) => window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*')\n\n  const applyHost = ctx => {\n    if (!ctx) return\n    if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme\n    const vars = ctx.styles && ctx.styles.variables\n    if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v)\n  }\n\n  if (isApp) {\n    window.addEventListener('message', e => {\n      if (e.source !== window.parent) return\n      const m = e.data\n      if (!m || m.jsonrpc !== '2.0') return\n      if (m.method === undefined && pending.has(m.id)) {\n        const p = pending.get(m.id)\n        pending.delete(m.id)\n        m.error ? p.reject(new Error(m.error.message || 'Host error')) : p.resolve(m.result)\n        return\n      }\n      if (m.method === 'ui/notifications/tool-input') session = (m.params && m.params.arguments && m.params.arguments.session) || session\n      if (m.method === 'ui/notifications/tool-result') take(m.params && m.params.structuredContent)\n      if (m.method === 'ui/notifications/host-context-changed') applyHost(m.params)\n      if (m.method === 'ui/resource-teardown' && m.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*')\n    })\n  }\n\n  // ---------- one way to ask the server, in either mode ----------\n  const call = async (args) => {\n    const view = payload ? payload.view : { scope: 'project', showClosed: false, projectKey: linkedProject }\n    const body = { scope: view.scope, showClosed: view.showClosed, projectKey: view.projectKey, ...args, session }\n    if (isApp) {\n      const result = await rpc('tools/call', { name: 'inbox_app_action', arguments: body })\n      if (result && result.isError) throw new Error(textOf(result) || 'The inbox could not do that.')\n      return result && result.structuredContent\n    }\n    const res = await fetch(`${api}/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })\n    if (!res.ok) throw new Error(await res.text())\n    return res.json()\n  }\n  const textOf = r => ((r && r.content) || []).map(c => c.text || '').join(' ')\n\n  const act = async (args) => {\n    if (busy) return\n    busy = true\n    render()\n    try {\n      take(await call(args))\n    } catch (err) {\n      say(String(err.message || err))\n    } finally {\n      busy = false\n      render()\n    }\n  }\n\n  const take = next => {\n    if (!next || !next.snapshot) return\n    payload = next\n    if (next.message) say(next.message)\n    render()\n  }\n\n  // the host sizes the frame to fit; report after every draw, not only on resize,\n  // because a hidden or off-screen frame gets no resize callbacks\n  let lastSize = ''\n  const reportSize = () => {\n    if (!isApp) return\n    const size = { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }\n    const key = `${size.width}x${size.height}`\n    if (key === lastSize) return\n    lastSize = key\n    notify('ui/notifications/size-changed', size)\n  }\n\n  // ---------- drawing ----------\n  const h = (tag, attrs, ...kids) => {\n    const el = document.createElement(tag)\n    for (const [k, v] of Object.entries(attrs || {})) {\n      if (v === undefined || v === null || v === false) continue\n      if (k.startsWith('on')) el.addEventListener(k.slice(2), v)\n      else if (k === 'class') el.className = v\n      else el.setAttribute(k, v === true ? '' : v)\n    }\n    for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : String(kid))\n    return el\n  }\n  const btn = (label, onclick, cls) => h('button', { type: 'button', class: cls, onclick, disabled: busy || undefined }, label)\n\n  const age = (now, at) => {\n    const s = Math.max(0, Math.round((now - at) / 1000))\n    if (s < 60) return 'now'\n    if (s < 3600) return `${Math.floor(s / 60)}m`\n    if (s < 86400) return `${Math.floor(s / 3600)}h`\n    return `${Math.floor(s / 86400)}d`\n  }\n\n  const openLink = url => {\n    if (!/^https:\\/\\//.test(url)) return\n    if (isApp) rpc('ui/open-link', { url }).catch(() => { say('The host would not open that link.'); render() })\n    else window.open(url, '_blank', 'noopener')\n  }\n\n  const renderItem = (item, project, group, num) => {\n    const presence = group.presence\n    const client = group.client\n    const isOpen = item.status === 'open'\n    const kindCls = !isOpen ? 'closed' : item.blocking ? 'blocking' : item.kind === 'waiting' ? 'waiting' : ''\n    const canReply = isOpen && item.kind !== 'waiting'\n    const repo = item.pr ? item.pr.repo : /^[\\w.-]+\\/[\\w.-]+$/.test(project.name) ? project.name : null\n    const canIssue = isOpen && item.kind !== 'waiting' && !item.issueUrl && repo\n    const base = { id: item.id, itemProjectKey: project.key }\n    const delivered = fb => {\n      if (fb.wake && fb.wake.ok) return 'woke that session with it'\n      if (fb.isDelivered) return 'delivered'\n      if (fb.wake && !fb.wake.ok) return `couldn't wake that session (${fb.wake.detail || 'error'}); it gets this with its next message`\n      if (client === 'copilot') {\n        // say why it has not gone yet, so a label never sits on \"waking\" for nothing\n        if (payload.daemon === false) return \"the inbox's background process isn't running, so it can't wake that session; it gets this at its next step or message\"\n        const status = (payload.wakeStatus || {})[group.sessionId]\n        if (status === 'ready') return 'waking that session\u2026'\n        if (status === 'open') return 'that session is open in Copilot, so it gets this at its next step or message (\"wake\": \"always\" in config.json wakes it anyway)'\n        if (status === 'mid-turn') return 'that session is mid-turn; it gets this at its next step'\n        if (status === 'off') return 'waking is off; it gets this at its next step or message'\n        return 'it gets this at its next step or message'\n      }\n      return presence === 'live' ? 'delivered at its next step' : 'delivered when that session resumes'\n    }\n\n    return h('article', { class: `item ${kindCls}` },\n      h('div', { class: 'title' },\n        h('span', { class: `chip ${kindCls}` }, KIND[item.kind] || item.kind.toUpperCase()),\n        item.blocking && isOpen ? h('span', { class: 'flag' }, 'BLOCKING') : null,\n        num ? h('span', { class: 'num' }, `#${num} `) : null,\n        item.title,\n        h('span', { class: 'age' }, ` \xB7 ${age(payload.snapshot.updatedAt, item.createdAt)}`)),\n      item.detail ? h('div', { class: 'detail' }, item.detail) : null,\n      item.link ? h('button', { type: 'button', class: 'link', onclick: () => openLink(item.link) }, item.link) : null,\n      item.issueUrl ? h('button', { type: 'button', class: 'link', onclick: () => openLink(item.issueUrl) }, `Issue: ${item.issueUrl}`) : null,\n      item.feedback.map(fb => h('div', { class: 'fb' }, `\u21B3 you ${fb.isChoice ? 'chose' : 'replied'}: ${fb.text} (${delivered(fb)})`)),\n      !isOpen ? h('div', { class: 'status' }, `${item.status} by ${item.closedBy || 'someone'}${item.note ? `: ${item.note}` : ''}`) : null,\n      item.kind === 'waiting' && isOpen ? h('div', { class: 'hint' }, 'Answer it in that session.') : null,\n      h('div', { class: 'actions' },\n        isOpen && item.kind === 'decision' ? (item.options || []).map(o => btn(o, () => act({ ...base, action: 'pick', text: o }), 'primary')) : null,\n        canReply ? btn(replyTo === item.id ? 'Cancel reply' : 'Reply', () => { replyTo = replyTo === item.id ? null : item.id; render() }) : null,\n        isOpen ? btn('Done', () => act({ ...base, action: 'done' })) : null,\n        isOpen ? btn('Dismiss', () => act({ ...base, action: 'dismiss' }), 'quiet') : null,\n        !isOpen ? btn('Reopen', () => act({ ...base, action: 'reopen' }), 'quiet') : null,\n        canIssue && confirmIssue !== item.id ? btn('Promote to issue', () => { confirmIssue = item.id; render() }, 'quiet') : null),\n      canIssue && confirmIssue === item.id ? h('div', { class: 'confirm' },\n        h('span', {}, `Create a GitHub issue in ${repo}?`),\n        btn('Create issue', () => { confirmIssue = null; act({ ...base, action: 'issue' }) }, 'primary'),\n        btn('Cancel', () => { confirmIssue = null; render() }, 'quiet')) : null,\n      replyTo === item.id ? replyBox(base) : null)\n  }\n\n  const replyBox = base => {\n    const area = h('textarea', { placeholder: 'Your reply goes to the session that raised this', 'aria-label': 'Reply' })\n    const send = () => {\n      const text = area.value.trim()\n      if (!text) return\n      replyTo = null\n      act({ ...base, action: 'reply', text })\n    }\n    area.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() })\n    setTimeout(() => area.focus(), 0)\n    return h('div', { class: 'reply' }, area, btn('Send', send, 'primary'))\n  }\n\n  const render = () => {\n    if (!payload) return\n    const { snapshot, view, webUrl } = payload\n    const self = snapshot.projects.find(p => p.isSelf)\n    const numbers = new Map()\n    let n = 0\n    for (const g of (self && self.groups) || []) for (const i of g.items) if (i.status === 'open') numbers.set(i.id, ++n)\n    const projects = snapshot.projects.filter(p => view.scope === 'all' || p.isSelf)\n    const isEmpty = projects.every(p => p.groups.length === 0)\n    const blocking = snapshot.blockingCount > 0\n\n    root.replaceChildren(...[\n      h('div', { class: `bar${blocking ? ' blocking' : ''}`, role: 'status' },\n        h('span', { class: 'count' }, `Action Inbox \xB7 ${snapshot.openCount} open${blocking ? ` \xB7 ${snapshot.blockingCount} blocking` : ''}${view.scope === 'all' ? ' \xB7 all projects' : ` \xB7 ${view.projectName}`}`),\n        isApp && webUrl && canOpenLinks ? btn('Open in browser', () => rpc('ui/open-link', { url: webUrl }).catch(() => {}), 'on-bar') : null),\n      h('div', { class: 'tools' },\n        btn(view.scope === 'all' ? 'This project' : 'All projects', () => act({ action: 'refresh', scope: view.scope === 'all' ? 'project' : 'all' })),\n        btn(view.showClosed ? 'Hide closed' : 'Show closed', () => act({ action: 'refresh', showClosed: !view.showClosed })),\n        btn('Refresh', () => act({ action: 'refresh' }), 'quiet')),\n      isEmpty ? h('p', { class: 'empty' }, 'Nothing waiting on you. Items appear here when a session needs a decision, a manual step or a merge.') : null,\n      projects.map(project => h('section', {},\n        view.scope === 'all' ? h('h2', {}, project.name) : null,\n        project.groups.map(g => h('div', { class: 'group' },\n          h('div', { class: 'ghead' },\n            h('span', { class: `dot${g.presence === 'live' ? ' live' : ''}`, 'aria-hidden': 'true' }, g.presence === 'live' ? '\u25CF' : '\u25CB'),\n            h('span', { class: 'who' }, g.branch || g.sessionId.slice(0, 8)),\n            g.client ? h('span', { class: 'tag' }, { copilot: 'Copilot', claude: 'Claude', codex: 'Codex' }[g.client] || g.client) : null,\n            g.isSelf ? h('span', { class: 'tag' }, 'this session') : null,\n            h('span', { class: 'meta' }, `\xB7 ${g.presence} \xB7 ${g.items.filter(i => i.status === 'open').length} open${g.label ? ` \xB7 \u201C${g.label}\u201D` : ''}`)),\n          g.items.map(i => renderItem(i, project, g, project.isSelf ? numbers.get(i.id) : undefined)))))),\n      note ? h('div', { class: 'toast', role: 'status' }, note) : null,\n    ].flat(Infinity).filter(Boolean))\n    reportSize()\n  }\n\n  // ---------- start ----------\n  const load = () => call({ action: 'refresh' }).then(take).catch(err => { if (!payload) root.replaceChildren(h('p', { class: 'err' }, `Could not load the inbox: ${err.message || err}`)) })\n  // background tabs skip the polling, never the first load\n  // and never while the user is typing a reply or confirming, which a redraw would wipe\n  const refresh = () => {\n    if (busy || replyTo !== null || confirmIssue !== null) return\n    if (document.visibilityState === 'visible' || !payload) load()\n  }\n\n  if (isApp) {\n    rpc('ui/initialize', { protocolVersion: '2026-01-26', appCapabilities: { availableDisplayModes: ['inline'] }, clientInfo: { name: 'action-inbox', version: '0.5.1' } })\n      .then(result => {\n        applyHost(result && result.hostContext)\n        canOpenLinks = Boolean(result && result.hostCapabilities && result.hostCapabilities.openLinks)\n        notify('ui/notifications/initialized', {})\n        new ResizeObserver(reportSize).observe(document.body)\n        reportSize()\n      })\n      .catch(() => { root.replaceChildren(h('p', { class: 'err' }, 'This host could not start the inbox view.')) })\n  } else {\n    refresh()\n  }\n  // other sessions add and answer items all the time\n  setInterval(refresh, isApp ? 10000 : 4000)\n})()\n</script>\n</body>\n</html>\n";

// copilot/src/daemon.ts
init_wake();
var DAEMON_VERSION = "0.5.1";
var VIEWER = "browser";
var IDLE_EXIT_MS = 6 * 60 * 60 * 1e3;
var trace = (event, extra = {}) => {
  const file = process.env.ACTION_INBOX_DEBUG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), event, pid: process.pid, ...extra })}
`);
  } catch {
  }
};
var statePath = () => join3(inboxHome(), ".daemon.json");
var readState = () => {
  try {
    return JSON.parse(readFileSync3(statePath(), "utf8"));
  } catch {
    return void 0;
  }
};
var request = (state, path, method = "GET") => fetch(`http://127.0.0.1:${state.port}/${state.token}/${path}`, {
  method,
  headers: method === "POST" ? { "Content-Type": "application/json" } : void 0,
  body: method === "POST" ? "{}" : void 0,
  signal: AbortSignal.timeout(1500)
}).then(async (res) => ({ status: res.status, body: await res.text() })).catch(() => ({ status: 0, body: "" }));
var isHealthy = async (state) => {
  if (!state) return false;
  const res = await request(state, "health");
  return res.status === 200 && res.body === DAEMON_VERSION;
};
var PASSED_ENV = /^(ACTION_INBOX_|COPILOT_HOME$|FAKE_COPILOT_LOG$|PATH$)/i;
var envPath = () => join3(inboxHome(), ".daemon-env.json");
var launch = (script) => {
  mkdirSync3(inboxHome(), { recursive: true });
  writeFileSync3(envPath(), JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => PASSED_ENV.test(k)))));
  const quote = (s) => `"${s.replace(/"/g, "")}"`;
  if (process.platform === "win32" && !process.env.ACTION_INBOX_PLAIN_SPAWN) {
    const ps = spawn2(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:AI_DAEMON_CMD; CurrentDirectory = $env:AI_DAEMON_CWD }; exit $r.ReturnValue"
      ],
      {
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, AI_DAEMON_CMD: `${quote(process.execPath)} ${quote(script)} --home ${quote(inboxHome())}`, AI_DAEMON_CWD: inboxHome() }
      }
    );
    ps.on("error", (err) => trace("daemon.launch-error", { error: String(err) }));
    ps.on("exit", (code) => trace("daemon.launched", { via: "wmi", code }));
    return;
  }
  const child = spawn2(process.execPath, [script, "--home", inboxHome()], { detached: true, stdio: "ignore", windowsHide: true, env: process.env });
  child.on("error", (err) => trace("daemon.launch-error", { error: String(err) }));
  child.unref();
  trace("daemon.launched", { via: "spawn", child: child.pid });
};
var ensureDaemon = async (script) => {
  let state = readState();
  if (await isHealthy(state)) return `http://127.0.0.1:${state.port}/${state.token}/`;
  if (state) await request(state, "shutdown", "POST");
  launch(script);
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    state = readState();
    if (await isHealthy(state)) return `http://127.0.0.1:${state.port}/${state.token}/`;
  }
  trace("daemon.not-ready", { state });
  return void 0;
};
var projectFor = (key) => {
  const all = listProjects();
  const named = all.find((p) => p.key === key);
  if (named) return named;
  let best = all[0];
  let bestSeen = -1;
  for (const meta of all) {
    const seen = Math.max(0, ...loadProject(meta).sessions.map((s) => s.lastSeen));
    if (seen > bestSeen) {
      best = meta;
      bestSeen = seen;
    }
  }
  return best;
};
var act = (body) => {
  const meta = projectFor(body.projectKey);
  if (!meta) return { error: "The inbox is empty: no session has used it yet." };
  const opts = { scope: body.scope === "all" ? "all" : "project", showClosed: body.showClosed === true };
  const action = String(body.action ?? "refresh");
  let message;
  if (action !== "refresh") {
    message = applyAction(VIEWER, {
      action,
      id: String(body.id ?? ""),
      text: typeof body.text === "string" ? body.text : void 0,
      projectKey: String(body.itemProjectKey ?? body.projectKey ?? meta.key)
    });
    setTimeout(tick, 50);
  }
  return {
    snapshot: inboxView(meta, VIEWER, opts),
    view: { ...opts, projectKey: meta.key, projectName: meta.name },
    message,
    wake: readConfig().wake,
    // why each Copilot session can or cannot be woken, for the reply labels
    wakeStatus: wakeStatusOf((opts.scope === "all" ? listProjects() : [meta]).flatMap((m) => loadProject(m).sessions)),
    daemon: true
  };
};
var readBody = (req) => new Promise((resolve2, reject) => {
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
  req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
  req.on("error", reject);
});
var lastUsed = Date.now();
var isWaking = false;
function tick() {
  if (isWaking) return;
  isWaking = true;
  try {
    const runs = wakePass();
    if (runs.length) lastUsed = Date.now();
    void Promise.allSettled(runs);
  } catch {
  } finally {
    isWaking = false;
  }
}
var main = () => {
  const at = process.argv.indexOf("--home");
  if (at > 0 && process.argv[at + 1]) process.env.ACTION_INBOX_HOME = process.argv[at + 1];
  try {
    const passed = JSON.parse(readFileSync3(envPath(), "utf8"));
    for (const [k, v] of Object.entries(passed)) {
      if (!PASSED_ENV.test(k)) continue;
      if (/^path$/i.test(k)) process.env.PATH = v;
      else if (process.env[k] === void 0) process.env[k] = v;
    }
  } catch {
  }
  trace("daemon.start", { ppid: process.ppid });
  process.on("exit", (code) => trace("daemon.exit", { code }));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(signal, () => {
      trace("daemon.signal", { signal });
      process.exit(0);
    });
  }
  const prior = readState();
  const token = prior?.token ?? randomBytes(18).toString("base64url");
  let origin = "";
  const page = inbox_default.replace("<script>", `<script>window.__INBOX_API__ = ${JSON.stringify(`/${token}/api`)}</script>
<script>`);
  const server = createServer((req, res) => {
    const send = (code, type, body, extra = {}) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
      res.end(body);
    };
    if (`http://${req.headers.host ?? ""}` !== origin) return send(403, "text/plain", "Forbidden");
    const path = (req.url ?? "/").split("?")[0];
    lastUsed = Date.now();
    if (req.method === "GET" && path === `/${token}/`) {
      return send(200, "text/html; charset=utf-8", page, {
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      });
    }
    if (req.method === "GET" && path === `/${token}/health`) return send(200, "text/plain", DAEMON_VERSION);
    if (req.method === "POST" && (path === `/${token}/api/act` || path === `/${token}/shutdown`)) {
      const from = req.headers.origin;
      if (from !== void 0 && from !== origin) return send(403, "text/plain", "Forbidden");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, "text/plain", "Expected JSON");
      if (path.endsWith("/shutdown")) {
        send(200, "text/plain", "bye");
        server.close();
        setTimeout(() => process.exit(0), 50);
        return;
      }
      readBody(req).then((text) => send(200, "application/json; charset=utf-8", JSON.stringify(act(JSON.parse(text))))).catch((err) => send(400, "text/plain", String(err.message ?? err)));
      return;
    }
    send(404, "text/plain", "Not found");
  });
  const listen = (port) => server.listen(port, "127.0.0.1");
  server.on("error", (err) => {
    if (err.code !== "EADDRINUSE" || server.listening || !prior?.port) process.exit(1);
    void isHealthy(readState()).then((isRunning) => {
      if (isRunning) process.exit(0);
      listen(0);
    });
  });
  const onListening = async () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    origin = `http://127.0.0.1:${port}`;
    const current = readState();
    if (current && current.pid !== process.pid && current.port !== port && await isHealthy(current)) process.exit(0);
    writeFileSync3(statePath(), JSON.stringify({ port, token, pid: process.pid, version: DAEMON_VERSION }));
    trace("daemon.listening", { port });
  };
  server.on("listening", () => void onListening());
  listen(prior?.port ?? 0);
  setInterval(tick, Number(process.env.ACTION_INBOX_WAKE_MS ?? 4e3));
  setInterval(() => {
    const recent = listProjects().some((meta) => loadProject(meta).sessions.some((s) => Date.now() - s.lastSeen < IDLE_EXIT_MS));
    if (!recent && Date.now() - lastUsed > IDLE_EXIT_MS) process.exit(0);
  }, 60 * 1e3);
};
if (process.argv[1] && /daemon\.m?[jt]s$/.test(process.argv[1])) main();
var ago = (at) => {
  const s = Math.round((Date.now() - at) / 1e3);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};
var WHY = {
  ready: "can be woken now",
  open: 'open in another process (the Copilot app or a terminal): not woken unless "wake" is "always"',
  "mid-turn": "mid-turn: it gets the reply at its next step",
  "unknown-open": "no Copilot session folder found and it has not ended: not woken",
  off: "waking is off in config.json",
  "not-copilot": "not a Copilot session"
};
var doctorReport = async () => {
  const { spawnSync } = await import("node:child_process");
  const { existsSync: existsSync3 } = await import("node:fs");
  const { copilotHome: copilotHome2, holdsOf: holdsOf2, readConfig: config, wakeBlock: wakeBlock2 } = await Promise.resolve().then(() => (init_wake(), wake_exports));
  const { pendingFor: pendingFor2 } = await Promise.resolve().then(() => (init_model(), model_exports));
  const lines = ["Action Inbox doctor", `Inbox folder: ${inboxHome()}`];
  const state = readState();
  if (!state) lines.push("Background process: not started yet (it starts with the first Copilot session that loads the plugin)");
  else if (await isHealthy(state)) lines.push(`Background process: running (pid ${state.pid}, version ${state.version}, page on port ${state.port})`);
  else lines.push(`Background process: NOT running (last seen as pid ${state.pid}, version ${state.version}); start a new Copilot session to restart it`);
  const custom = process.env.ACTION_INBOX_COPILOT_CMD;
  if (custom) lines.push(`Copilot command: ${custom} (test override)`);
  else {
    const isWin = process.platform === "win32";
    const found = spawnSync(isWin ? "where" : "which", ["copilot"], { encoding: "utf8", timeout: 1e4 });
    const path = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : "";
    const version = path ? spawnSync("copilot", ["--version"], { encoding: "utf8", timeout: 2e4, shell: isWin }).stdout.trim().split(/\r?\n/)[0] : "";
    lines.push(path ? `Copilot command: ${path} (${version || "version unknown"})` : "Copilot command: NOT on PATH, so no session can be woken (install Copilot CLI: npm install -g @github/copilot)");
  }
  const cfg = config();
  lines.push(`Wake setting: ${cfg.wake}${cfg.wakeArgs.length ? `, extra flags ${cfg.wakeArgs.join(" ")}` : ""} (${join3(inboxHome(), "config.json")})`);
  const sessionsDir = join3(copilotHome2(), "session-state");
  lines.push(`Copilot sessions folder: ${sessionsDir}${existsSync3(sessionsDir) ? "" : " (NOT found)"}`);
  const now = Date.now();
  const waiting = [];
  const wakes = [];
  for (const meta of listProjects()) {
    const project = loadProject(meta);
    for (const session of project.sessions) {
      if (session.client !== "copilot") continue;
      const { replies } = pendingFor2(session.sessionId, project.items, project.events);
      if (replies.length === 0) continue;
      const why = wakeBlock2(session, cfg, now) ?? "ready";
      const holds = holdsOf2(session.sessionId);
      const holdText = holds === void 0 ? "no session folder" : holds.length === 0 ? "no locks" : holds.map((h) => `pid ${h.pid} ${h.isLive ? "holding it" : "stale lock"}`).join(", ");
      waiting.push(`  ${session.sessionId} "${session.label ?? ""}" in ${meta.name}: ${replies.length} repl${replies.length === 1 ? "y" : "ies"}; ${WHY[why] ?? why} [${holdText}; ended: ${session.isEnded ? "yes" : "no"}; turn: ${session.turn ?? "unknown"}; seen ${ago(session.lastSeen)}]`);
    }
    for (const ev of project.events) {
      if (ev.type === "wake") wakes.push({ at: ev.at, text: `  ${ago(ev.at)}: ${ev.ok ? "woke" : "FAILED to wake"} a session in ${meta.name}${ev.detail ? ` (${ev.detail})` : ""}` });
    }
  }
  lines.push(waiting.length ? "Replies waiting for a Copilot session:" : "Replies waiting for a Copilot session: none", ...waiting);
  wakes.sort((a, b) => b.at - a.at);
  lines.push(wakes.length ? "Recent wakes:" : "Recent wakes: none", ...wakes.slice(0, 5).map((w) => w.text));
  return lines.join("\n");
};
export {
  DAEMON_VERSION,
  doctorReport,
  ensureDaemon,
  isHealthy,
  readState
};
