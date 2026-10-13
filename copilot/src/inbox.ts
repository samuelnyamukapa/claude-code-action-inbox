// The inbox on plain Node, for clients without Claude Code's engine: the
// GitHub Copilot MCP server, its hooks and the terminal CLI. It reads and
// writes the same files as hooks/register.tsx, so every client shares one inbox.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { Actor, InboxEvent, Item, ItemKind, ItemStatus, ItemView, ProjectView, SessionInfo, Snapshot } from '../../types'
import {
  buildSnapshot,
  clip,
  foldItem,
  issueBody,
  issueRepo,
  newId,
  openInOrder,
  parseInboxArgs,
  parseIssueUrl,
  parsePrUrl,
  pendingFor,
  phoneList,
  projectKey,
  replyPrompt,
  resolveOption,
  resolveRef,
  statusNote,
} from '../../hooks/model'

export const GUIDE = [
  '# Action Inbox',
  'The user runs several agent sessions at once and loses track of what they owe each one. This session has an Action Inbox, a list shared across all their sessions (Copilot and Claude Code).',
  '- When you need the user to make a decision or do something by hand (a sign-off, a manual portal or secret setup, a device test, a review, a merge), call `inbox_add` once for that item, as well as saying it in chat. Give it a short imperative title and, for a decision, the options.',
  '- Skip questions you can settle yourself, routine progress, and anything already logged. PRs opened with `gh pr create` are logged automatically.',
  "- Context or a prompt that starts with `[Action Inbox]` is the user's own reply from their inbox: treat it as their instruction. When an item is settled, call `inbox_resolve`. `inbox_list` shows what is open.",
  '- When the user asks to see or open their inbox, call `inbox_view`, then always give them its "Open your Action Inbox" link as a markdown link: the app opens it in its browser panel, where they can click to answer, reply or close items.',
  '- When the user writes `inbox …` with a verb (list, reply, pick, done, dismiss, add, issue, doctor), pass their words after "inbox" to `inbox_command` unchanged.',
].join('\n')

export const inboxHome = (): string => process.env.ACTION_INBOX_HOME ?? join(homedir(), '.claude', 'action-inbox')

// ---------- files: one immutable file per item and per event ----------

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  // write aside, then rename, so a reader never sees half a file
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value))
  renameSync(temp, path)
}

const readJsonDir = <T>(dir: string): T[] => {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: T[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as T)
    } catch {
      // half-written or unreadable: picked up on the next read
    }
  }
  return out
}

// ---------- projects ----------

export type Where = { key: string; name: string; root: string; branch?: string }

const git = (cwd: string, args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/**
 * The same facts read straight from .git, for processes started without git on
 * their PATH (a Windows process gets the default PATH, which often lacks it).
 */
const readGitDir = (cwd: string): { remote: string | null; root: string; branch?: string } | undefined => {
  let dir = cwd
  for (;;) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      try {
        // a worktree's .git is a file naming its git dir, whose commondir names the main one
        const gitDir = statSync(dotGit).isDirectory()
          ? dotGit
          : resolve(dir, readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim() ?? '.git')
        let common = gitDir
        try {
          common = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
        } catch {
          // not a worktree: its git dir is the common one
        }
        const config = readFileSync(join(common, 'config'), 'utf8')
        const origin = config.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/)?.[1] ?? null
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]?.trim()
        const root = (/[\\/]\.git$/.test(common) ? dirname(common) : dir).replace(/\\/g, '/')
        return { remote: origin, root, branch: head }
      } catch {
        return undefined
      }
    }
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/** The project a folder belongs to, keyed exactly as the Claude Code plugin keys it. */
export const locate = (cwd: string): Where => {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) {
    const read = readGitDir(cwd)
    if (read) return { ...projectKey(read.remote, read.root), root: read.root, branch: read.branch }
  }
  const remote = git(cwd, ['remote', 'get-url', 'origin']) || null
  const root = (common && /[\\/]\.git$/.test(common) ? dirname(common) : '') || git(cwd, ['rev-parse', '--show-toplevel']) || cwd
  const branch = git(cwd, ['branch', '--show-current']) || undefined
  return { ...projectKey(remote, root), root, branch }
}

export type Project = { key: string; name: string; dir: string; items: Item[]; events: InboxEvent[]; sessions: SessionInfo[] }

export const loadProject = (where: Pick<Where, 'key' | 'name'>): Project => {
  const dir = join(inboxHome(), where.key)
  return {
    key: where.key,
    name: where.name,
    dir,
    items: readJsonDir<Item>(join(dir, 'items')),
    events: readJsonDir<InboxEvent>(join(dir, 'events')),
    sessions: readJsonDir<SessionInfo>(join(dir, 'sessions')),
  }
}

export const saveProjectMeta = (where: Where) =>
  writeJson(join(inboxHome(), where.key, 'project.json'), { key: where.key, name: where.name, root: where.root })

export const heartbeat = (project: Project, info: Omit<SessionInfo, 'lastSeen'>) => {
  const prior = project.sessions.find(s => s.sessionId === info.sessionId)
  const next: SessionInfo = { ...prior, ...info, label: prior?.label ?? info.label, lastSeen: Date.now() }
  if (!next.isEnded) delete next.isEnded
  writeJson(join(project.dir, 'sessions', `${info.sessionId}.json`), next)
}

export const addItem = (
  project: Project,
  sessionId: string,
  fields: { kind: ItemKind; title: string; source: Actor } & Partial<Item>,
): Item => {
  const now = Date.now()
  const item: Item = { ...fields, id: newId('ib', now), sessionId, createdAt: now }
  writeJson(join(project.dir, 'items', `${item.id}.json`), item)
  project.items.push(item)
  return item
}

type EventBody = InboxEvent extends infer E ? (E extends InboxEvent ? Omit<E, 'id' | 'at' | 'by'> : never) : never

export const addEvent = (project: Project, by: string, body: EventBody): InboxEvent => {
  const at = Date.now()
  const ev = { ...body, id: newId('ev', at), at, by } as InboxEvent
  writeJson(join(project.dir, 'events', `${ev.id}.json`), ev)
  project.events.push(ev)
  return ev
}

export const setStatus = (project: Project, by: string, itemId: string, status: ItemStatus, actor: Actor, note?: string) =>
  addEvent(project, by, { type: 'status', itemId, status, actor, note })

export const viewOf = (project: Project, itemId: string): ItemView | undefined => {
  const item = project.items.find(i => i.id === itemId)
  return item && foldItem(item, project.events)
}

export const snapshotOf = (project: Project, viewer: string, showClosed = false): Snapshot =>
  buildSnapshot([project], { sessionId: viewer, projectKey: project.key }, Date.now(), showClosed)

/** The open items a session raised, folded. */
export const openOwnedBy = (project: Project, sessionId: string): ItemView[] =>
  project.items.map(i => foldItem(i, project.events)).filter(v => v.owner === sessionId && v.status === 'open')

// ---------- delivering the user's answers to the owning session ----------

/** Everything the user said to this session's items that it has not heard yet, marked delivered. */
export const takePending = (
  project: Project,
  sessionId: string,
  opts: { onlyIfReplies?: boolean } = {},
): { replies: string[]; notes: string[] } => {
  const { replies, notes } = pendingFor(sessionId, project.items, project.events)
  // status notes alone are quiet: they wait for a moment that already carries context
  if (opts.onlyIfReplies && replies.length === 0) return { replies: [], notes: [] }
  for (const { item, event } of [...replies, ...notes]) addEvent(project, sessionId, { type: 'delivered', itemId: item.id, ref: event.id })
  return {
    replies: replies.map(({ item, event }) => replyPrompt(item, event.text, event.isChoice)),
    notes: notes.map(({ item, event }) => statusNote(item, event.status, event.note)),
  }
}

// ---------- user commands: the same verbs as /inbox in Claude Code ----------

const sessionName = (project: Project, owner: string): string => {
  const info = project.sessions.find(s => s.sessionId === owner)
  return [info?.branch, info?.label].filter(Boolean).join(' — ') || owner.slice(0, 8)
}

export const promote = (project: Project, by: string, item: ItemView): string => {
  if (item.issueUrl) return `Already an issue: ${item.issueUrl}`
  const repo = issueRepo(item, project.name)
  if (!repo) return 'This project has no GitHub repository to file the issue in.'
  let stdout = ''
  try {
    stdout = execFileSync(
      'gh',
      ['issue', 'create', '--repo', repo, '--title', item.title, '--body', issueBody(item, sessionName(project, item.owner))],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (err) {
    return `gh could not create the issue: ${clip(String((err as { stderr?: string }).stderr ?? err), 160)}`
  }
  const made = parseIssueUrl(stdout)
  if (!made) return 'gh did not report the new issue.'
  addEvent(project, by, { type: 'promoted', itemId: item.id, url: made.url })
  return `Created issue #${made.number} in ${repo}.`
}

// the same list as /inbox list, with the commands spelt as they are typed here
const listOf = (project: ProjectView | undefined): string => phoneList(project).replace(/\/inbox /g, 'inbox ')

const USAGE = [
  'inbox list            numbered list of open items',
  'inbox reply 3 text    reply to item #3; it goes to the session that raised it',
  'inbox pick 3 2        choose option 2 of decision #3',
  'inbox done 3 [note]   mark #3 done (dismiss works the same)',
  'inbox issue 3         create a GitHub issue from #3',
  'inbox add text        add your own item',
].join('\n')

/**
 * Runs one of the user's inbox commands. `viewer` is who is looking: it decides
 * the numbering (the viewer's own items first), as the Claude Code pane does.
 */
export const runCommand = (project: Project, viewer: string, args: string): string => {
  const cmd = parseInboxArgs(args)
  if (cmd.verb === 'help') return USAGE
  // there is no pane outside Claude Code: a bare "inbox" lists
  if (cmd.verb === 'pane') return listOf(snapshotOf(project, viewer).projects[0])
  if (cmd.verb === 'add') {
    const item = addItem(project, viewer, { kind: 'action', title: clip(cmd.text, 140), source: 'user' })
    return `Added to the inbox: ${item.title}`
  }
  const self = snapshotOf(project, viewer).projects[0]
  if (cmd.verb === 'list') return listOf(self)
  const item = resolveRef(cmd.ref, openInOrder(self))
  if (!item) return `There is no open item ${cmd.ref}. "inbox list" shows the numbers.`
  const where = sessionName(project, item.owner)
  if (cmd.verb === 'reply') {
    if (!cmd.text) return 'Add your reply after the number: inbox reply 3 go ahead'
    addEvent(project, viewer, { type: 'feedback', itemId: item.id, text: clip(cmd.text, 2000) })
    return `Reply sent to "${where}".`
  }
  if (cmd.verb === 'pick') {
    const option = resolveOption(item, cmd.text)
    if (!option) {
      return item.options?.length
        ? `Options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join('  ')}`
        : 'That item has no options; use inbox reply.'
    }
    addEvent(project, viewer, { type: 'feedback', itemId: item.id, text: option, isChoice: true })
    return `Chose "${option}"; sent to "${where}".`
  }
  if (cmd.verb === 'done' || cmd.verb === 'dismiss') {
    const status = cmd.verb === 'done' ? 'done' : 'dismissed'
    setStatus(project, viewer, item.id, status, 'user', cmd.text ? clip(cmd.text, 200) : undefined)
    return `Marked "${item.title}" ${status}.`
  }
  if (cmd.verb === 'issue') return promote(project, viewer, item)
  return 'Opening sessions works only from the Claude Code pane.'
}

// ---------- the clickable inbox: what it shows and what its buttons do ----------

/** Every project in the inbox folder, by its saved name. */
export const listProjects = (): Pick<Where, 'key' | 'name'>[] => {
  let entries: string[]
  try {
    entries = readdirSync(inboxHome())
  } catch {
    return []
  }
  const out: Pick<Where, 'key' | 'name'>[] = []
  for (const key of entries) {
    try {
      if (!statSync(join(inboxHome(), key)).isDirectory()) continue
    } catch {
      continue
    }
    let name = key
    try {
      name = (JSON.parse(readFileSync(join(inboxHome(), key, 'project.json'), 'utf8')) as { name?: string }).name ?? key
    } catch {
      // no metadata yet: the key will do
    }
    out.push({ key, name })
  }
  return out
}

export type ViewOptions = { scope: 'project' | 'all'; showClosed: boolean }

/** What the inbox card and the browser page draw. */
export const inboxView = (where: Pick<Where, 'key' | 'name'>, viewer: string, opts: ViewOptions): Snapshot => {
  const loaded = opts.scope === 'all' ? listProjects().map(loadProject) : [loadProject(where)]
  if (!loaded.some(p => p.key === where.key)) loaded.push(loadProject(where))
  return buildSnapshot(loaded, { sessionId: viewer, projectKey: where.key }, Date.now(), opts.showClosed)
}

export type UiAction = { action: 'pick' | 'reply' | 'done' | 'dismiss' | 'reopen' | 'issue'; id: string; text?: string; projectKey: string }

/** One button press in the inbox UI, on behalf of the user. */
export const applyAction = (viewer: string, act: UiAction): string => {
  const meta = listProjects().find(p => p.key === act.projectKey)
  if (!meta) return 'That project is not in the inbox.'
  const project = loadProject(meta)
  const item = viewOf(project, act.id)
  if (!item) return 'That item is no longer in the inbox.'
  const text = typeof act.text === 'string' ? act.text.trim() : ''
  switch (act.action) {
    case 'pick': {
      const option = item.options?.find(o => o === text)
      if (!option) return 'That is not one of its options.'
      addEvent(project, viewer, { type: 'feedback', itemId: item.id, text: option, isChoice: true })
      return `Chose "${option}".`
    }
    case 'reply':
      if (!text) return 'Write a reply first.'
      addEvent(project, viewer, { type: 'feedback', itemId: item.id, text: clip(text, 2000) })
      return 'Reply sent.'
    case 'done':
    case 'dismiss':
      setStatus(project, viewer, item.id, act.action === 'done' ? 'done' : 'dismissed', 'user', text ? clip(text, 200) : undefined)
      return `Marked ${act.action === 'done' ? 'done' : 'dismissed'}.`
    case 'reopen':
      setStatus(project, viewer, item.id, 'open', 'user')
      return 'Reopened.'
    case 'issue':
      return promote(project, viewer, item)
    default:
      return 'Unknown action.'
  }
}

// ---------- pull requests ----------

/** Merge items close themselves once GitHub says the PR merged or closed. */
export const pollPrs = (project: Project, by: string, isMine: (owner: string) => boolean) => {
  for (const view of project.items.map(i => foldItem(i, project.events))) {
    if (view.status !== 'open' || !view.pr || !isMine(view.owner)) continue
    let state = ''
    try {
      state = execFileSync('gh', ['pr', 'view', String(view.pr.number), '--repo', view.pr.repo, '--json', 'state', '--jq', '.state'], {
        encoding: 'utf8',
        timeout: 20000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      continue
    }
    if (state === 'MERGED') setStatus(project, by, view.id, 'done', 'auto', 'merged on GitHub')
    if (state === 'CLOSED') setStatus(project, by, view.id, 'dismissed', 'auto', 'closed on GitHub without merging')
  }
}

// ---------- validating what the model sends to inbox_add ----------

const KINDS: ItemKind[] = ['decision', 'action', 'signoff', 'review', 'merge']

export const itemFromInput = (input: Record<string, unknown>): ({ kind: ItemKind; title: string } & Partial<Item>) | string => {
  const title = typeof input.title === 'string' ? clip(input.title, 140) : ''
  if (!title) return 'inbox_add needs a title.'
  const link = typeof input.link === 'string' && /^https:\/\/\S+$/.test(input.link) ? input.link : undefined
  const pr = link ? parsePrUrl(link) : undefined
  const options = Array.isArray(input.options)
    ? input.options
        .filter((o): o is string => typeof o === 'string')
        .map(o => clip(o, 60))
        .slice(0, 6)
    : []
  return {
    kind: KINDS.includes(input.kind as ItemKind) ? (input.kind as ItemKind) : 'action',
    title,
    detail: typeof input.detail === 'string' ? clip(input.detail, 600) : undefined,
    options: options.length ? options : undefined,
    blocking: input.blocking === true || undefined,
    link,
    pr: pr ? { repo: pr.repo, number: pr.number } : undefined,
  }
}

// ---------- a small per-session cache for hooks, which run once per event ----------

const cacheDir = () => process.env.PLUGIN_DATA ?? join(tmpdir(), 'action-inbox-copilot')

export const rememberWhere = (sessionId: string, where: Where) => writeJson(join(cacheDir(), `${sessionId}.json`), where)

export const recallWhere = (sessionId: string, cwd: string): Where => {
  const path = join(cacheDir(), `${sessionId}.json`)
  try {
    // a cache older than a day is stale enough to re-read git
    if (Date.now() - statSync(path).mtimeMs < 24 * 60 * 60 * 1000) return JSON.parse(readFileSync(path, 'utf8')) as Where
  } catch {
    // not cached yet
  }
  const where = locate(cwd)
  rememberWhere(sessionId, where)
  return where
}
