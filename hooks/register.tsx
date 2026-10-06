import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Actor, InboxEvent, Item, ItemKind, ItemStatus, ItemView, SessionInfo, Snapshot } from '../types'
import {
  age,
  buildSnapshot,
  clip,
  foldItem,
  HELP,
  issueBody,
  issueRepo,
  openInOrder,
  parseInboxArgs,
  parseIssueUrl,
  phoneList,
  resolveOption,
  resolveRef,
  isPrCreate,
  newId,
  parseMergeTarget,
  parsePrUrl,
  pendingFor,
  projectKey,
  replyPrompt,
  statusNote,
} from './model'

const PANE = 'action-inbox'
const TOOL_ADD = 'mcp__action-inbox__inbox_add'
const TOOL_RESOLVE = 'mcp__action-inbox__inbox_resolve'
const TOOL_LIST = 'mcp__action-inbox__inbox_list'
const SCAN_MS = 4000
const HEARTBEAT_MS = 60 * 1000
const PR_POLL_MS = 5 * 60 * 1000

const snapshot = atom({ plugin: 'action-inbox', key: 'snapshot' } as const, null)
const view = atom({ plugin: 'action-inbox', key: 'view' } as const, 'project')
const showClosed = atom({ plugin: 'action-inbox', key: 'showClosed' } as const, false)
const replyTo = atom({ plugin: 'action-inbox', key: 'replyTo' } as const, null)
const confirmPromote = atom({ plugin: 'action-inbox', key: 'confirmPromote' } as const, null)

const GUIDE = [
  '# Action Inbox',
  'The user runs several sessions at once and loses track of what they owe each one. This session has an Action Inbox, a list shared across all their sessions.',
  '- When you need the user to make a decision or do something by hand (a sign-off, a manual portal or secret setup, a device test, a review, a merge), call `inbox_add` once for that item, as well as saying it in chat. Give it a short imperative title and, for a decision, the options.',
  '- Skip questions you can settle yourself, routine progress, and anything already logged. PRs opened with `gh pr create` and pending AskUserQuestion/plan approvals are logged automatically.',
  "- A prompt that starts with `[Action Inbox]` is the user's own reply from the inbox pane: treat it as their instruction. When an item is settled, call `inbox_resolve`. `inbox_list` shows what is open.",
].join('\n')

type Ctx = {
  home: string
  sessionId: string
  key: string
  name: string
  dir: string
  info: SessionInfo
}

type Project = { key: string; name: string; items: Item[]; events: InboxEvent[]; sessions: SessionInfo[] }

let ctx: Ctx | undefined
let isScanning = false
let seen: Set<string> | undefined
const fileCache = new Map<string, { mtimeMs: number; value: unknown }>()
const prCheckedAt = new Map<string, number>()
const loaded = new Map<string, Project>()

// ---------- storage: one immutable file per item and per event ----------

const readJsonDir = async <T,>($: EngineInterface, dir: string, isImmutable: boolean): Promise<T[]> => {
  const entries = await $.fs.list(dir).catch(() => [])
  const out: T[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const path = `${dir}/${entry.name}`
    const hit = fileCache.get(path)
    if (hit && (isImmutable || hit.mtimeMs === entry.mtimeMs)) {
      out.push(hit.value as T)
      continue
    }
    try {
      const value = JSON.parse(await $.fs.read(path)) as T
      fileCache.set(path, { mtimeMs: entry.mtimeMs, value })
      out.push(value)
    } catch {
      // half-written or unreadable: picked up on the next scan
    }
  }
  return out
}

const loadProject = async ($: EngineInterface, home: string, key: string): Promise<Project> => {
  const dir = `${home}/${key}`
  const meta = (await readJsonDir<{ key: string; name: string }>($, dir, false)).find(m => m.key === key)
  const project: Project = {
    key,
    name: meta?.name ?? key,
    items: await readJsonDir<Item>($, `${dir}/items`, true),
    events: await readJsonDir<InboxEvent>($, `${dir}/events`, true),
    sessions: await readJsonDir<SessionInfo>($, `${dir}/sessions`, false),
  }
  loaded.set(key, project)
  return project
}

const writeItem = async ($: EngineInterface, c: Ctx, item: Item) => {
  await $.fs.write(`${c.dir}/items/${item.id}.json`, JSON.stringify(item, null, 1))
  loaded.get(c.key)?.items.push(item)
}

const writeEvent = async ($: EngineInterface, dir: string, ev: InboxEvent) => {
  await $.fs.write(`${dir}/events/${ev.id}.json`, JSON.stringify(ev))
}

const event = async <T extends InboxEvent['type']>(
  $: EngineInterface,
  c: Ctx,
  projectKeyOf: string,
  body: Omit<Extract<InboxEvent, { type: T }>, 'id' | 'at' | 'by'> & { type: T },
) => {
  const at = await $.clock.now()
  const ev = { ...body, id: newId('ev', at), at, by: c.sessionId } as InboxEvent
  await writeEvent($, `${c.home}/${projectKeyOf}`, ev)
  loaded.get(projectKeyOf)?.events.push(ev)
  return ev
}

const heartbeat = async ($: EngineInterface, c: Ctx, isEnded = false) => {
  c.info = { ...c.info, lastSeen: await $.clock.now(), isEnded: isEnded || undefined }
  await $.fs.write(`${c.dir}/sessions/${c.sessionId}.json`, JSON.stringify(c.info))
}

const addItem = async (
  $: EngineInterface,
  c: Ctx,
  fields: { kind: ItemKind; title: string; source: Actor } & Partial<Item>,
): Promise<Item> => {
  const now = await $.clock.now()
  const item: Item = { ...fields, id: newId('ib', now), sessionId: c.sessionId, createdAt: now }
  await writeItem($, c, item)
  void scan($)
  const isUrgent = item.blocking || item.kind === 'decision' || item.kind === 'signoff'
  if (item.source !== 'user' && item.kind !== 'waiting' && isUrgent) void pushNote($, item)
  return item
}

const setStatus = async (
  $: EngineInterface,
  c: Ctx,
  item: ItemView,
  projectKeyOf: string,
  status: ItemStatus,
  actor: Actor,
  note?: string,
) => {
  await event($, c, projectKeyOf, { type: 'status', itemId: item.id, status, actor, note })
  void scan($)
}

const findItem = (id: string): { item: ItemView; projectKey: string } | undefined => {
  for (const project of loaded.values()) {
    const item = project.items.find(i => i.id === id)
    if (item) return { item: foldItem(item, project.events), projectKey: project.key }
  }
  return undefined
}

// ---------- the scan: read, deliver replies, refresh the pane ----------

const scan = async ($: EngineInterface) => {
  const c = ctx
  if (!c || isScanning) return
  isScanning = true
  try {
    const now = await $.clock.now()
    const keys = new Set([c.key])
    if ((await read($, view)) === 'all') {
      for (const entry of await $.fs.list(c.home).catch(() => [])) {
        if (entry.kind === 'dir') keys.add(entry.name)
      }
    }
    const projects: Project[] = []
    for (const key of keys) projects.push(await loadProject($, c.home, key))
    const self = projects.find(p => p.key === c.key)!
    self.name = c.name

    // replies the user typed for this session's items: one turn each, once idle
    const { replies } = pendingFor(c.sessionId, self.items, self.events)
    for (const { item, event: ev } of replies) {
      await event($, c, c.key, { type: 'delivered', itemId: item.id, ref: ev.id })
      void $.prompt.submit({ text: replyPrompt(item, ev.text, ev.isChoice) })
    }

    const snap = buildSnapshot(projects, { sessionId: c.sessionId, projectKey: c.key }, now, await read($, showClosed))

    // a toast for items other sessions raise while this one runs
    const openOthers = snap.projects.flatMap(p =>
      p.groups.filter(g => !g.isSelf).flatMap(g => g.items.filter(i => i.status === 'open').map(i => ({ i, g }))),
    )
    if (seen) {
      for (const { i, g } of openOthers) {
        if (!seen.has(i.id)) $.ui.toast(`Inbox · ${g.branch ?? 'another session'}: ${clip(i.title, 70)}`, { timeoutMs: 8000 })
      }
    }
    seen = new Set(openOthers.map(o => o.i.id))

    const before = await read($, snapshot)
    if (!before || JSON.stringify({ ...before, updatedAt: 0 }) !== JSON.stringify({ ...snap, updatedAt: 0 })) {
      await update($, snapshot, () => snap)
    }
  } finally {
    isScanning = false
  }
}

// merge items close themselves once GitHub says the PR merged or closed
const pollPrs = async ($: EngineInterface) => {
  const c = ctx
  const project = c && loaded.get(c.key)
  if (!c || !project) return
  const now = await $.clock.now()
  const snap = buildSnapshot([project], { sessionId: c.sessionId, projectKey: c.key }, now, false)
  for (const group of snap.projects[0]?.groups ?? []) {
    const isMine = group.isSelf || group.presence !== 'live'
    for (const item of group.items) {
      if (!isMine || item.status !== 'open' || !item.pr) continue
      if (now - (prCheckedAt.get(item.id) ?? 0) < PR_POLL_MS) continue
      prCheckedAt.set(item.id, now)
      const ran = await $.process
        .run(['gh', 'pr', 'view', String(item.pr.number), '--repo', item.pr.repo, '--json', 'state', '--jq', '.state'], {
          timeoutMs: 20000,
        })
        .catch(() => undefined)
      const state = ran?.exitCode === 0 ? ran.stdout.trim() : ''
      if (state === 'MERGED') await setStatus($, c, item, c.key, 'done', 'auto', 'merged on GitHub')
      if (state === 'CLOSED') await setStatus($, c, item, c.key, 'dismissed', 'auto', 'closed on GitHub without merging')
    }
  }
}

// while a session holds a question or a plan for the user, other sessions see it
const waitWhile = async <R,>($: EngineInterface, title: string, run: () => Promise<R>): Promise<R> => {
  const c = ctx
  if (!c) return run()
  const item = await addItem($, c, { kind: 'waiting', title, source: 'auto', blocking: true })
  try {
    return await run()
  } finally {
    const project = loaded.get(c.key)
    await setStatus($, c, foldItem(item, project?.events ?? []), c.key, 'done', 'auto', 'answered in the session')
  }
}

// ---------- open a session, promote an item, reach the phone ----------

// the desktop app keeps one record per session that pairs its own id with the
// engine's; the app's claude:// link takes its own id
const ccdByCli = new Map<string, string>()

async function findCcdId($: EngineInterface, cli: string): Promise<string | undefined> {
  if (ccdByCli.has(cli)) return ccdByCli.get(cli)
  const appData = await $.env.get('APPDATA')
  const home = await $.env.get('HOME')
  const roots = [
    appData && `${appData}/Claude/claude-code-sessions`,
    home && `${home}/Library/Application Support/Claude/claude-code-sessions`,
  ]
  for (const root of roots) {
    if (!root) continue
    for (const a of await $.fs.list(root).catch(() => [])) {
      if (a.kind !== 'dir') continue
      for (const b of await $.fs.list(`${root}/${a.name}`).catch(() => [])) {
        if (b.kind !== 'dir') continue
        const dir = `${root}/${a.name}/${b.name}`
        for (const f of await $.fs.list(dir).catch(() => [])) {
          if (f.kind !== 'file' || !/^local_.*\.json$/.test(f.name)) continue
          if ([...ccdByCli.values()].includes(f.name.slice(0, -5))) continue
          try {
            const record = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as { sessionId?: string; cliSessionId?: string }
            if (record.sessionId && record.cliSessionId) ccdByCli.set(record.cliSessionId, record.sessionId)
          } catch {
            // a record mid-write: read again on the next press
          }
        }
      }
    }
  }
  return ccdByCli.get(cli)
}

async function openSession($: EngineInterface, cli: string): Promise<string> {
  const ccd = await findCcdId($, cli)
  if (!ccd) return 'That session is not in the desktop app on this machine.'
  const url = `claude://claude.ai/epitaxy/${ccd}`
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const ran = await $.process.run(isWindows ? ['explorer.exe', url] : ['open', url], { timeoutMs: 15000 }).catch(() => undefined)
  return ran ? 'Opening that session in the desktop app.' : 'Could not open the session.'
}

const sessionName = (projectKeyOf: string, owner: string): string => {
  const info = loaded.get(projectKeyOf)?.sessions.find(s => s.sessionId === owner)
  return [info?.branch, info?.label].filter(Boolean).join(' — ') || owner.slice(0, 8)
}

const projectNameOf = (projectKeyOf: string): string =>
  ctx && projectKeyOf === ctx.key ? ctx.name : (loaded.get(projectKeyOf)?.name ?? '')

async function promote($: EngineInterface, c: Ctx, item: ItemView, projectKeyOf: string): Promise<string> {
  if (item.issueUrl) return `Already an issue: ${item.issueUrl}`
  const repo = issueRepo(item, projectNameOf(projectKeyOf))
  if (!repo) return 'This project has no GitHub repository to file the issue in.'
  const body = issueBody(item, sessionName(projectKeyOf, item.owner))
  const ran = await $.process
    .run(['gh', 'issue', 'create', '--repo', repo, '--title', item.title, '--body', body], { timeoutMs: 60000 })
    .catch(() => undefined)
  const made = ran?.exitCode === 0 ? parseIssueUrl(ran.stdout) : undefined
  if (!made) return `gh could not create the issue${ran?.stderr ? `: ${clip(ran.stderr, 160)}` : ''}.`
  await event($, c, projectKeyOf, { type: 'promoted', itemId: item.id, url: made.url })
  void scan($)
  return `Created issue #${made.number} in ${repo}.`
}

// at most one push every two minutes, and only where the session already may push
let lastPushAt = 0

async function pushNote($: EngineInterface, item: Item) {
  const now = await $.clock.now()
  if (now - lastPushAt < 2 * 60 * 1000) return
  const message = clip(`Action Inbox${item.blocking ? ' · BLOCKING' : ''}: ${item.title}`, 180)
  const check = await $.tool.check({ tool: 'PushNotification', input: { message, status: 'proactive' } }).catch(() => undefined)
  if (check?.decision !== 'allow') return
  lastPushAt = now
  await $.tool.call({ tool: 'PushNotification', message, status: 'proactive' }).catch(() => undefined)
}

export const register: Register = on => {
  // ---------- session lifecycle ----------

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    const sessionId = await $.session.id()
    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.root())
    const { key, name } = projectKey(repo?.remote ?? null, root)
    const base = `${home.replace(/\\/g, '/')}/.claude/action-inbox`
    const branch = await $.process
      .run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() || undefined : undefined))
      .catch(() => undefined)
    const prior = ctx?.sessionId === sessionId ? ctx.info : undefined
    ctx = {
      home: base,
      sessionId,
      key,
      name,
      dir: `${base}/${key}`,
      info: { sessionId, branch, cwd: e.cwd, label: prior?.label, lastSeen: 0 },
    }
    const c = ctx
    await $.fs.write(`${c.dir}/project.json`, JSON.stringify({ key, name, root }))
    const self = await loadProject($, base, key)
    const known = self.sessions.find(s => s.sessionId === sessionId)
    if (known?.label) c.info.label = known.label
    await heartbeat($, c)

    // a resumed session may run under a new id: reclaim the items it raised
    const messages = await $.session.messages().catch(() => [])
    const raised = new Set<string>()
    for (const message of Array.isArray(messages) ? messages : []) {
      for (const use of message.toolUses ?? []) {
        if (use.tool !== TOOL_ADD) continue
        const id = (use as { text?: string }).text?.match(/\bib_[a-z0-9]+\b/)?.[0]
        if (id) raised.add(id)
      }
    }
    const snap = buildSnapshot([self], { sessionId, projectKey: key }, await $.clock.now(), true)
    for (const item of snap.projects[0]?.groups.flatMap(g => g.items) ?? []) {
      if (raised.has(item.id) && item.owner !== sessionId) await event($, c, key, { type: 'claim', itemId: item.id })
      // a "waiting" item outlives the dialog only when the process died mid-question
      if (item.owner === sessionId && item.kind === 'waiting' && item.status === 'open') {
        await setStatus($, c, item, key, 'dismissed', 'auto', 'session restarted')
      }
    }

    await $.command.register({
      name: 'inbox',
      description: 'Action Inbox: decisions and manual actions you owe, across sessions',
      argumentHint: '[all | list | reply <n> <text> | pick <n> <option> | done <n> | issue <n> | open <n> | add <text>]',
      immediate: true,
    })
    await $.tool.register({
      name: 'inbox_add',
      description:
        "Log a decision or manual action the USER owes to their cross-session Action Inbox so it is not lost in the scroll. Use it alongside asking in chat, once per distinct item. Returns the item id; the user's reply arrives later as a prompt starting with [Action Inbox].",
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['decision', 'action', 'signoff', 'review', 'merge'],
            description:
              'decision = choose between options; action = a manual step; signoff = an approval only they can give; review/merge = look at or merge work',
          },
          title: { type: 'string', description: 'Short imperative line, e.g. "Approve the ADR 0010 refresh window"' },
          detail: { type: 'string', description: 'One or two sentences of context: why it matters and what happens next' },
          options: { type: 'array', items: { type: 'string' }, description: 'For a decision: 2-4 short option labels' },
          blocking: { type: 'boolean', description: 'True when this session cannot continue its current work without it' },
          link: { type: 'string', description: 'An https URL (PR, issue, doc) the user needs' },
        },
        required: ['kind', 'title'],
      },
    })
    await $.tool.register({
      name: 'inbox_resolve',
      description: 'Mark an Action Inbox item settled: done when the decision or action happened, dismissed when it no longer applies.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The item id (ib_...)' },
          status: { type: 'string', enum: ['done', 'dismissed'] },
          note: { type: 'string', description: 'What was decided or done, in a few words' },
        },
        required: ['id', 'status'],
      },
    })
    await $.tool.register({
      name: 'inbox_list',
      description: "List the open Action Inbox items for this project, with the user's replies.",
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['session', 'project'], description: 'This session only (default) or the whole project' },
        },
      },
    })

    await scan($)
    $.clock.every(SCAN_MS, () => void scan($))
    $.clock.every(HEARTBEAT_MS, () => {
      if (ctx) void heartbeat($, ctx)
      void pollPrs($)
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    const c = ctx
    if (c) {
      const project = loaded.get(c.key)
      if (project) {
        const snap = buildSnapshot([project], { sessionId: c.sessionId, projectKey: c.key }, await $.clock.now(), false)
        for (const item of snap.projects[0]?.groups.find(g => g.isSelf)?.items ?? []) {
          if (item.kind === 'waiting' && item.status === 'open')
            await event($, c, c.key, { type: 'status', itemId: item.id, status: 'dismissed', actor: 'auto', note: 'session ended' })
        }
      }
      await heartbeat($, c, true).catch(() => undefined)
    }
    return next(e)
  })

  // the user's own status changes reach the owning session with its next prompt
  on('prompt.submit', async ($, e, next) => {
    const c = ctx
    if (!c) return next(e)
    if (!c.info.label && e.origin.kind !== 'plugin' && !e.text.startsWith('[Action Inbox]')) {
      c.info.label = clip(e.text, 60)
      void heartbeat($, c)
    }
    const project = loaded.get(c.key)
    if (!project) return next(e)
    const { notes } = pendingFor(c.sessionId, project.items, project.events)
    if (notes.length === 0) return next(e)
    for (const { item, event: ev } of notes) await event($, c, c.key, { type: 'delivered', itemId: item.id, ref: ev.id })
    const context = notes.map(({ item, event: ev }) => statusNote(item, ev.status, ev.note))
    return next({ ...e, context: [...(e.context ?? []), context.join('\n')] })
  })

  on('turn.complete', async ($, e, next) => {
    if (ctx) void heartbeat($, ctx)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { ...composed, sections: [...composed.sections, { id: 'action-inbox:guide', text: GUIDE, scope: 'session' as const }] }
  })

  // ---------- tools the model calls ----------

  on('tool.call', { tool: TOOL_ADD }, async ($, e) => {
    const c = ctx
    if (!c) return { deny: 'Action Inbox is not ready yet; say it in chat instead.' }
    const input = e as unknown as Record<string, unknown>
    const kinds: ItemKind[] = ['decision', 'action', 'signoff', 'review', 'merge']
    const kind = kinds.includes(input.kind as ItemKind) ? (input.kind as ItemKind) : 'action'
    const title = typeof input.title === 'string' ? clip(input.title, 140) : ''
    if (!title) return { deny: 'inbox_add needs a title.' }
    const link = typeof input.link === 'string' && /^https:\/\/\S+$/.test(input.link) ? input.link : undefined
    const pr = link ? parsePrUrl(link) : undefined
    const options = Array.isArray(input.options)
      ? input.options
          .filter((o): o is string => typeof o === 'string')
          .map(o => clip(o, 60))
          .slice(0, 6)
      : undefined
    const item = await addItem($, c, {
      kind,
      title,
      detail: typeof input.detail === 'string' ? clip(input.detail, 600) : undefined,
      options: options?.length ? options : undefined,
      blocking: input.blocking === true || undefined,
      link,
      pr: pr ? { repo: pr.repo, number: pr.number } : undefined,
      source: 'model',
    })
    return { result: `Logged inbox item ${item.id}. The user's reply, if any, will arrive as a prompt starting with [Action Inbox].` }
  })

  on('tool.call', { tool: TOOL_RESOLVE }, async ($, e) => {
    const c = ctx
    if (!c) return { deny: 'Action Inbox is not ready yet.' }
    const input = e as unknown as Record<string, unknown>
    const found = typeof input.id === 'string' ? findItem(input.id) : undefined
    if (!found) return { deny: `No inbox item ${String(input.id)} in this project.` }
    const status: ItemStatus = input.status === 'dismissed' ? 'dismissed' : 'done'
    await setStatus($, c, found.item, found.projectKey, status, 'model', typeof input.note === 'string' ? clip(input.note, 200) : undefined)
    return { result: `Inbox item ${found.item.id} marked ${status}.` }
  })

  on('tool.call', { tool: TOOL_LIST }, async ($, e) => {
    const c = ctx
    const project = c && loaded.get(c.key)
    if (!c || !project) return { result: 'The inbox is empty.' }
    const isProject = (e as unknown as Record<string, unknown>).scope === 'project'
    const snap = buildSnapshot([project], { sessionId: c.sessionId, projectKey: c.key }, await $.clock.now(), false)
    const lines: string[] = []
    for (const group of snap.projects[0]?.groups ?? []) {
      if (!isProject && !group.isSelf) continue
      for (const item of group.items.filter(i => i.status === 'open')) {
        const who = group.isSelf ? 'this session' : (group.branch ?? group.sessionId.slice(0, 8))
        lines.push(`- ${item.id} [${item.kind}${item.blocking ? ', blocking' : ''}] ${item.title} (${who})`)
        for (const fb of item.feedback) lines.push(`  user ${fb.isChoice ? 'chose' : 'replied'}: ${fb.text}`)
      }
    }
    return { result: lines.length ? lines.join('\n') : 'No open inbox items.' }
  })

  // ---------- automatic capture ----------

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const c = ctx
    if (!c || ran.deny !== undefined || ran.isError) return ran
    if (isPrCreate(e.command)) {
      const pr = parsePrUrl(ran.text ?? '')
      const project = loaded.get(c.key)
      const isKnown = project?.items.some(i => i.pr?.number === pr?.number && i.pr?.repo === pr?.repo)
      if (pr && !isKnown) {
        await addItem($, c, {
          kind: 'merge',
          title: `Review & merge PR #${pr.number}`,
          link: pr.url,
          pr: { repo: pr.repo, number: pr.number },
          source: 'auto',
        })
      }
    }
    const merged = parseMergeTarget(e.command)
    if (merged && !/--auto\b/.test(e.command)) {
      const project = loaded.get(c.key)
      const snap = project && buildSnapshot([project], { sessionId: c.sessionId, projectKey: c.key }, await $.clock.now(), false)
      for (const item of snap?.projects[0]?.groups.flatMap(g => g.items) ?? []) {
        const isTarget = item.pr?.number === merged.number && (!merged.repo || item.pr.repo === merged.repo)
        if (isTarget && item.status === 'open') await setStatus($, c, item, c.key, 'done', 'auto', 'merged with gh pr merge')
      }
    }
    return ran
  })

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) =>
    waitWhile($, `Waiting on your answer: ${clip(e.questions?.[0]?.question ?? 'a question', 110)}`, () => next(e)),
  )
  on('tool.call', { tool: 'ExitPlanMode' }, ($, e, next) => waitWhile($, 'Waiting for you to approve a plan', () => next(e)))

  // ---------- the /inbox command ----------

  on('command.run', { command: 'inbox' }, async ($, e) => {
    const c = ctx
    if (!c) return { text: 'Action Inbox is still starting.' }
    const cmd = parseInboxArgs(e.args)
    if (cmd.verb === 'help') return { text: HELP }
    if (cmd.verb === 'add') {
      const item = await addItem($, c, { kind: 'action', title: clip(cmd.text, 140), source: 'user' })
      return { text: `Added to the inbox: ${item.title}` }
    }
    if (cmd.verb === 'pane') {
      await update($, view, () => (cmd.isAll ? 'all' : 'project'))
      void scan($)
      const opened = await $.ui.open({ id: PANE, title: `Action Inbox · ${c.name}` })
      return { text: opened.isPlaced ? 'Action Inbox opened.' : 'Action Inbox is open; widen the window to see it.' }
    }

    await scan($)
    const self = (await read($, snapshot))?.projects.find(p => p.isSelf)
    if (cmd.verb === 'list') return { text: phoneList(self) }
    const item = resolveRef(cmd.ref, openInOrder(self))
    if (!item) return { text: `There is no open item ${cmd.ref}. /inbox list shows the numbers.` }
    const where = sessionName(c.key, item.owner)

    if (cmd.verb === 'reply') {
      if (!cmd.text) return { text: 'Add your reply after the number: /inbox reply 3 go ahead' }
      await event($, c, c.key, { type: 'feedback', itemId: item.id, text: clip(cmd.text, 2000) })
      void scan($)
      return { text: `Reply sent to "${where}".` }
    }
    if (cmd.verb === 'pick') {
      const option = resolveOption(item, cmd.text)
      if (!option)
        return {
          text: item.options?.length
            ? `Options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join('  ')}`
            : 'That item has no options; use /inbox reply.',
        }
      await event($, c, c.key, { type: 'feedback', itemId: item.id, text: option, isChoice: true })
      void scan($)
      return { text: `Chose "${option}"; sent to "${where}".` }
    }
    if (cmd.verb === 'done' || cmd.verb === 'dismiss') {
      await setStatus($, c, item, c.key, cmd.verb === 'done' ? 'done' : 'dismissed', 'user', cmd.text ? clip(cmd.text, 200) : undefined)
      return { text: `Marked "${item.title}" ${cmd.verb === 'done' ? 'done' : 'dismissed'}.` }
    }
    if (cmd.verb === 'issue') return { text: await promote($, c, item, c.key) }
    return { text: await openSession($, item.owner) }
  })

  // ---------- drawing ----------

  // Orange is the inbox's signal colour. Every coloured area sets both its
  // background and white text, at 4.5:1 or better, so it reads the same in light
  // and dark themes.
  const ORANGE = '#C4510F' // white on it: 4.6:1
  const WHITE = '#FFFFFF'
  const RUST = '#7A2E0E' // session header bar; white on it: 9.4:1
  const PEACH = '#FCE3D3' // secondary text on the rust bar: 7.7:1
  const LIVE = '#4ADE80'
  const CHIP: Record<'normal' | 'blocking' | 'waiting', { bg: string; fg: string }> = {
    normal: { bg: ORANGE, fg: WHITE },
    blocking: { bg: '#C62828', fg: WHITE }, // 5.6:1
    waiting: { bg: '#B45309', fg: WHITE }, // 5.0:1
  }

  const KIND_LABEL: Record<ItemKind, string> = {
    decision: 'DECIDE',
    action: 'DO',
    signoff: 'SIGN OFF',
    review: 'REVIEW',
    merge: 'MERGE',
    waiting: 'WAITING',
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const snap = await read($, snapshot)
    const mode = await read($, view)
    const isClosedShown = await read($, showClosed)
    const replying = await read($, replyTo)
    const confirming = await read($, confirmPromote)
    const now = snap?.updatedAt ?? 0
    const c = ctx
    const isMobile = e.surface === 'mobile'
    const numbers = new Map(openInOrder(snap?.projects.find(p => p.isSelf)).map((item, n) => [item.id, n + 1]))

    const act = (fn: () => Promise<unknown>) => () => void fn().then(() => scan($))

    const renderItem = (item: ItemView, projectKeyOf: string, presence: string) => {
      const isOpen = item.status === 'open'
      const canReply = isOpen && item.kind !== 'waiting'
      const chip = CHIP[item.blocking ? 'blocking' : item.kind === 'waiting' ? 'waiting' : 'normal']
      const repo = issueRepo(item, projectNameOf(projectKeyOf))
      const canPromote = isOpen && item.kind !== 'waiting' && !item.issueUrl && repo !== undefined
      return (
        <Box
          key={`item:${item.id}`}
          flexDirection="column"
          marginBottom={1}
          marginLeft={1}
          paddingX={1}
          borderStyle="round"
          borderColor={isOpen ? chip.bg : '#9E9E9E'}
        >
          <Text bold={isOpen} dimColor={!isOpen} strikethrough={!isOpen} wrap="wrap">
            <Text bold backgroundColor={isOpen ? chip.bg : undefined} color={isOpen ? chip.fg : undefined}>
              {` ${KIND_LABEL[item.kind]} `}
            </Text>
            {item.blocking && isOpen ? ' BLOCKING · ' : ' '}
            {numbers.has(item.id) ? `#${numbers.get(item.id)} ` : ''}
            {item.title}
            <Text dimColor> · {age(now, item.createdAt)}</Text>
          </Text>
          {(item.detail ?? '')
            .split('\n')
            .filter(line => line.trim())
            .map((line, n) => (
              <Text key={`detail:${item.id}:${n}`} dimColor wrap="wrap">
                {line}
              </Text>
            ))}
          {item.link && <Link key={`link:${item.id}`} href={item.link} label={item.link} />}
          {item.issueUrl && <Link key={`issue:${item.id}`} href={item.issueUrl} label={`Issue: ${item.issueUrl}`} />}
          {item.feedback.map(fb => (
            <Text key={`fb:${fb.id}`} dimColor wrap="wrap">
              ↳ you {fb.isChoice ? 'chose' : 'replied'}: {fb.text} (
              {fb.isDelivered ? 'delivered' : presence === 'live' ? 'sending…' : 'delivered when that session resumes'})
            </Text>
          ))}
          {!isOpen && (
            <Text dimColor>
              {item.status} by {item.closedBy ?? 'someone'}
              {item.note ? `: ${item.note}` : ''}
            </Text>
          )}
          {item.kind === 'waiting' && isOpen && <Text dimColor>Answer it in that session.</Text>}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {isOpen &&
              item.kind === 'decision' &&
              (item.options ?? []).map((option, n) => (
                <Button
                  key={`opt:${item.id}:${n}`}
                  label={option}
                  variant="primary"
                  onPress={act(() => event($, c!, projectKeyOf, { type: 'feedback', itemId: item.id, text: option, isChoice: true }))}
                />
              ))}
            {canReply && Input && (
              <Button
                key={`reply:${item.id}`}
                label="Reply"
                onPress={() => void update($, replyTo, cur => (cur === item.id ? null : item.id))}
              />
            )}
            {isOpen && (
              <Button key={`done:${item.id}`} label="Done" onPress={act(() => setStatus($, c!, item, projectKeyOf, 'done', 'user'))} />
            )}
            {isOpen && (
              <Button
                key={`dismiss:${item.id}`}
                label="Dismiss"
                dimColor
                onPress={act(() => setStatus($, c!, item, projectKeyOf, 'dismissed', 'user'))}
              />
            )}
            {!isOpen && (
              <Button
                key={`reopen:${item.id}`}
                label="Reopen"
                dimColor
                onPress={act(() => setStatus($, c!, item, projectKeyOf, 'open', 'user'))}
              />
            )}
            {canPromote && confirming !== item.id && (
              <Button
                key={`promote:${item.id}`}
                label="Promote to issue"
                dimColor
                onPress={() => void update($, confirmPromote, () => item.id)}
              />
            )}
          </Box>
          {canPromote && confirming === item.id && (
            <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
              <Text>Create a GitHub issue in {repo}?</Text>
              <Button
                key={`promote-yes:${item.id}`}
                label="Create issue"
                variant="primary"
                onPress={act(async () => {
                  await update($, confirmPromote, () => null)
                  $.ui.toast(await promote($, c!, item, projectKeyOf))
                })}
              />
              <Button key={`promote-no:${item.id}`} label="Cancel" dimColor onPress={() => void update($, confirmPromote, () => null)} />
            </Box>
          )}
          {canReply && !Input && numbers.has(item.id) && (
            <Text dimColor wrap="wrap">
              Reply from here with /inbox reply {numbers.get(item.id)} your text
            </Text>
          )}
          {replying === item.id && Input && (
            <Input
              key={`input:${item.id}`}
              placeholder="Your reply goes to the session that raised this"
              submitLabel="send"
              autoFocus
              onSubmit={(text: string) => {
                const trimmed = text.trim()
                if (!trimmed) return
                void event($, c!, projectKeyOf, { type: 'feedback', itemId: item.id, text: clip(trimmed, 2000) })
                  .then(() => update($, replyTo, () => null))
                  .then(() => scan($))
              }}
            />
          )}
        </Box>
      )
    }

    const projects = (snap?.projects ?? []).filter(p => mode === 'all' || p.isSelf)
    const isEmpty = projects.every(p => p.groups.length === 0)

    return (
      <Box flexDirection="column">
        <Box width="100%" paddingX={1} backgroundColor={snap && snap.blockingCount > 0 ? CHIP.blocking.bg : ORANGE}>
          <Text bold color={WHITE}>
            {snap ? `${snap.openCount} open` : 'Loading…'}
            {snap && snap.blockingCount > 0 ? ` · ${snap.blockingCount} blocking` : ''}
            {mode === 'all' ? ' · all projects' : ''}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1} marginBottom={1} flexWrap="wrap">
          <Button
            key="view"
            label={mode === 'all' ? 'This project' : 'All projects'}
            onPress={act(() => update($, view, v => (v === 'all' ? 'project' : 'all')))}
          />
          <Button key="closed" label={isClosedShown ? 'Hide closed' : 'Show closed'} onPress={act(() => update($, showClosed, v => !v))} />
        </Box>
        {isEmpty && (
          <Text dimColor>Nothing waiting on you. Items appear here when a session needs a decision, a manual step or a merge.</Text>
        )}
        {projects.map(project => (
          <Box key={`project:${project.key}`} flexDirection="column">
            {mode === 'all' && (
              <Text bold underline>
                {project.name}
              </Text>
            )}
            {project.groups.map(group => (
              <Box key={`group:${project.key}:${group.sessionId}`} flexDirection="column" marginBottom={1}>
                <Box width="100%" backgroundColor={RUST} paddingX={1} marginBottom={1}>
                  <Text wrap="truncate-end" color={WHITE}>
                    <Text color={group.presence === 'live' ? LIVE : PEACH}>{group.presence === 'live' ? '●' : '○'} </Text>
                    <Text bold color={WHITE}>
                      {group.branch ?? group.sessionId.slice(0, 8)}
                    </Text>
                    {group.isSelf ? (
                      <Text bold color={PEACH}>
                        {' '}
                        (this session)
                      </Text>
                    ) : null}
                    <Text color={PEACH}>
                      {' '}
                      · {group.presence} · {group.items.filter(i => i.status === 'open').length} open
                      {group.label ? ` · "${group.label}"` : ''}
                    </Text>
                  </Text>
                </Box>
                {!group.isSelf && !isMobile && (
                  <Box marginLeft={1} marginBottom={1}>
                    <Button
                      key={`open:${group.sessionId}`}
                      label="Open session"
                      onPress={() => void openSession($, group.sessionId).then(message => $.ui.toast(message))}
                    />
                  </Box>
                )}
                {group.items.map(item => renderItem(item, project.key, group.presence))}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap: Snapshot | null = await read($, snapshot)
    const self = snap?.projects.find(p => p.isSelf)
    const open = self?.groups.flatMap(g => g.items.filter(i => i.status === 'open')) ?? []
    if (e.props.hasSurvey || open.length === 0) return next(e)
    const blocking = open.filter(i => i.blocking).length
    const mine = open.filter(i => i.owner === ctx?.sessionId).length
    const { Box, Text, Button } = $.ui.resolve(e)
    const bar = blocking ? CHIP.blocking : CHIP.normal
    return (
      <Box width="100%" flexDirection="row" alignItems="center" gap={1}>
        <Box flexGrow={1} paddingX={1} backgroundColor={bar.bg}>
          <Text color={bar.fg} wrap="truncate-end">
            <Text bold color={bar.fg}>
              Action Inbox
            </Text>
            {`  ·  ${open.length} open${blocking ? `  ·  ${blocking} blocking` : ''}${mine ? `  ·  ${mine} from this session` : ''}`}
          </Text>
        </Box>
        <Button
          key="open-inbox"
          label="Open inbox"
          variant="primary"
          onPress={() => void $.ui.open({ id: PANE, title: `Action Inbox · ${ctx?.name ?? ''}` })}
        />
      </Box>
    )
  })
}
