import type { FeedbackView, InboxEvent, Item, ItemView, ProjectView, SessionGroup, SessionInfo, Snapshot } from '../types'

/** A session not heard from in this long is drawn idle rather than live. */
export const LIVE_MS = 3 * 60 * 1000
/** Closed items stay listed this long; older ones only with "Show closed". */
export const RECENT_CLOSED_MS = 24 * 60 * 60 * 1000

export const newId = (prefix: string, now: number): string => {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${now.toString(36)}${rand}`
}

/** A folder name for a project: the origin remote's path, else the main worktree's root. */
export const projectKey = (remote: string | null, root: string): { key: string; name: string } => {
  const fromRemote = remote?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]
  const name =
    fromRemote ??
    root
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ??
    root
  const basis = fromRemote ?? root
  const key = basis
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return { key: key || 'unknown', name }
}

/** The first GitHub pull request URL in a command's output. */
export const parsePrUrl = (text: string): { repo: string; number: number; url: string } | undefined => {
  const found = text.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  const [url, repo, num] = found ?? []
  if (!url || !repo || !num) return undefined
  return { repo, number: Number(num), url }
}

/** The PR a `gh pr merge` command names, when it names one by number or URL. */
export const parseMergeTarget = (command: string): { repo?: string; number: number } | undefined => {
  if (!/\bgh\s+pr\s+merge\b/.test(command)) return undefined
  const url = parsePrUrl(command)
  if (url) return { repo: url.repo, number: url.number }
  const num = command.match(/\bgh\s+pr\s+merge\s+(?:[^\n]*?\s)?#?(\d+)\b/)
  return num ? { number: Number(num[1]) } : undefined
}

export const isPrCreate = (command: string): boolean => /\bgh\s+pr\s+create\b/.test(command)

export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export const age = (now: number, at: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** Folds an item and its events, in time order, into what the pane shows. */
export const foldItem = (item: Item, events: readonly InboxEvent[]): ItemView => {
  const mine = events.filter(ev => ev.itemId === item.id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  const delivered = new Set(mine.flatMap(ev => (ev.type === 'delivered' ? [ev.ref] : [])))
  const view: ItemView = { ...item, owner: item.sessionId, status: 'open', updatedAt: item.createdAt, feedback: [] }
  for (const ev of mine) {
    view.updatedAt = Math.max(view.updatedAt, ev.at)
    if (ev.type === 'claim') view.owner = ev.by
    if (ev.type === 'promoted') view.issueUrl = ev.url
    if (ev.type === 'status') {
      view.status = ev.status
      view.closedBy = ev.status === 'open' ? undefined : ev.actor
      view.note = ev.note
    }
    if (ev.type === 'feedback') {
      const fb: FeedbackView = { id: ev.id, text: ev.text, at: ev.at, isChoice: ev.isChoice, isDelivered: delivered.has(ev.id) }
      view.feedback.push(fb)
    }
  }
  return view
}

/**
 * What the owning session still has to hear: the user's replies not yet
 * delivered (each starts a turn), and the user's own status changes (passed
 * along quietly with the next prompt).
 */
export const pendingFor = (
  owner: string,
  items: readonly Item[],
  events: readonly InboxEvent[],
): {
  replies: { item: ItemView; event: InboxEvent & { type: 'feedback' } }[]
  notes: { item: ItemView; event: InboxEvent & { type: 'status' } }[]
} => {
  const delivered = new Set(events.flatMap(ev => (ev.type === 'delivered' ? [ev.ref] : [])))
  const replies: { item: ItemView; event: InboxEvent & { type: 'feedback' } }[] = []
  const notes: { item: ItemView; event: InboxEvent & { type: 'status' } }[] = []
  for (const item of items) {
    const view = foldItem(item, events)
    if (view.owner !== owner) continue
    for (const ev of events) {
      if (ev.itemId !== item.id || delivered.has(ev.id)) continue
      if (ev.type === 'feedback') replies.push({ item: view, event: ev })
      if (ev.type === 'status' && ev.actor === 'user') notes.push({ item: view, event: ev })
    }
  }
  const byTime = (a: { event: InboxEvent }, b: { event: InboxEvent }) => a.event.at - b.event.at
  return { replies: replies.sort(byTime), notes: notes.sort(byTime) }
}

export const replyPrompt = (item: ItemView, text: string, isChoice?: boolean): string =>
  [
    `[Action Inbox] The user answered inbox item ${item.id} ("${item.title}") from the inbox pane.`,
    isChoice ? `They chose: ${text}` : `Their reply: ${text}`,
    `Act on it as their instruction. When the item is settled, call inbox_resolve with id ${item.id}; if it raises something new they must do or decide, call inbox_add.`,
  ].join('\n')

export const statusNote = (item: ItemView, status: string, note?: string): string =>
  `[Action Inbox] The user marked inbox item ${item.id} ("${item.title}") as ${status}${note ? `: ${note}` : ''}.`

type Loaded = {
  key: string
  name: string
  items: readonly Item[]
  events: readonly InboxEvent[]
  sessions: readonly SessionInfo[]
}

/** Builds the pane's snapshot from what was read off disk. */
export const buildSnapshot = (
  loaded: readonly Loaded[],
  self: { sessionId: string; projectKey: string },
  now: number,
  showClosed: boolean,
): Snapshot => {
  let openCount = 0
  let blockingCount = 0
  let selfOpenCount = 0
  const projects: ProjectView[] = []
  for (const project of loaded) {
    const sessions = new Map(project.sessions.map(s => [s.sessionId, s]))
    const groups = new Map<string, SessionGroup>()
    for (const item of project.items) {
      const view = foldItem(item, project.events)
      const isOpen = view.status === 'open'
      if (isOpen) {
        openCount += 1
        if (view.blocking) blockingCount += 1
        if (view.owner === self.sessionId) selfOpenCount += 1
      }
      const isRecent = now - view.updatedAt < RECENT_CLOSED_MS
      if (!isOpen && !showClosed && !isRecent) continue
      let group = groups.get(view.owner)
      if (!group) {
        const info = sessions.get(view.owner)
        const presence = info?.isEnded ? 'ended' : info && now - info.lastSeen < LIVE_MS ? 'live' : 'idle'
        group = {
          sessionId: view.owner,
          branch: info?.branch,
          label: info?.label,
          client: info?.client,
          presence,
          isSelf: view.owner === self.sessionId,
          items: [],
        }
        groups.set(view.owner, group)
      }
      group.items.push(view)
    }
    const rank = (v: ItemView) => (v.status === 'open' ? (v.blocking ? 0 : 1) : 2)
    const list = [...groups.values()]
    for (const group of list) group.items.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    const openIn = (g: SessionGroup) => g.items.filter(i => i.status === 'open').length
    list.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || openIn(b) - openIn(a))
    if (list.length > 0 || project.key === self.projectKey) {
      projects.push({ key: project.key, name: project.name, isSelf: project.key === self.projectKey, groups: list })
    }
  }
  projects.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.name.localeCompare(b.name))
  return { projects, openCount, blockingCount, selfOpenCount, updatedAt: now }
}

// ---------- numbering, commands and issue text (phone check-in, promote) ----------

/** The open items of a project in the order the pane lists them; #1 is the first. */
export const openInOrder = (project: ProjectView | undefined): ItemView[] =>
  (project?.groups ?? []).flatMap(g => g.items.filter(i => i.status === 'open'))

export type InboxCommand =
  | { verb: 'pane'; isAll: boolean }
  | { verb: 'add'; text: string }
  | { verb: 'list' }
  | { verb: 'reply' | 'pick' | 'done' | 'dismiss' | 'issue' | 'open'; ref: string; text: string }
  | { verb: 'help' }

const REF_VERBS = ['reply', 'pick', 'done', 'dismiss', 'issue', 'open'] as const

/** Reads what follows /inbox. */
export const parseInboxArgs = (args: string): InboxCommand => {
  const text = args.trim()
  if (!text) return { verb: 'pane', isAll: false }
  if (/^all$/i.test(text)) return { verb: 'pane', isAll: true }
  const [, word = '', rest = ''] = text.match(/^(\S+)\s*([\s\S]*)$/) ?? []
  const verb = word.toLowerCase()
  if (verb === 'add') return rest.trim() ? { verb: 'add', text: rest.trim() } : { verb: 'help' }
  if (verb === 'list' || verb === 'ls') return { verb: 'list' }
  const refVerb = REF_VERBS.find(v => v === verb)
  if (refVerb) {
    const [, ref = '', more = ''] = rest.match(/^#?(\S+)\s*([\s\S]*)$/) ?? []
    if (!ref) return { verb: 'help' }
    return { verb: refVerb, ref, text: more.trim() }
  }
  return { verb: 'help' }
}

/** An item by its number in the list (1-based) or by its id. */
export const resolveRef = (ref: string, open: readonly ItemView[]): ItemView | undefined =>
  /^\d+$/.test(ref) ? open[Number(ref) - 1] : open.find(i => i.id === ref)

/** A decision's option by its number or its label (case-insensitive). */
export const resolveOption = (item: ItemView, text: string): string | undefined => {
  const options = item.options ?? []
  if (/^\d+$/.test(text)) return options[Number(text) - 1]
  return options.find(o => o.toLowerCase() === text.toLowerCase())
}

export const HELP = [
  '/inbox                open the pane (/inbox all: every project)',
  '/inbox list           numbered list of open items, for the phone',
  '/inbox reply 3 text   reply to item #3; it goes to the session that raised it',
  '/inbox pick 3 2       choose option 2 of decision #3',
  '/inbox done 3 [note]  mark #3 done (dismiss works the same)',
  '/inbox issue 3        create a GitHub issue from #3',
  '/inbox open 3         open the session that raised #3 (desktop)',
  '/inbox add text       add your own item',
].join('\n')

/** The open items as plain text, numbered as the pane numbers them. */
export const phoneList = (project: ProjectView | undefined): string => {
  const lines: string[] = []
  let n = 0
  for (const group of project?.groups ?? []) {
    const open = group.items.filter(i => i.status === 'open')
    if (open.length === 0) continue
    lines.push(`— ${group.branch ?? group.sessionId.slice(0, 8)}${group.isSelf ? ' (this session)' : ''}`)
    for (const item of open) {
      n += 1
      lines.push(`#${n} ${item.blocking ? '[BLOCKING] ' : ''}[${item.kind}] ${item.title}`)
      if (item.options?.length) lines.push(`   options: ${item.options.map((o, k) => `${k + 1}) ${o}`).join('  ')}`)
      if (item.issueUrl) lines.push(`   issue: ${item.issueUrl}`)
    }
  }
  if (n === 0) return 'Nothing waiting on you.'
  return [`${n} open`, ...lines, '', 'Reply: /inbox reply <n> <text> · pick: /inbox pick <n> <option> · done: /inbox done <n>'].join('\n')
}

/** The repository an item's issue goes to: its PR's, else the project's owner/name. */
export const issueRepo = (item: ItemView, projectName: string): string | undefined =>
  item.pr?.repo ?? (/^[\w.-]+\/[\w.-]+$/.test(projectName) ? projectName : undefined)

export const issueBody = (item: ItemView, sessionName: string): string =>
  [
    item.detail ?? '',
    item.link ? `Link: ${item.link}` : '',
    item.options?.length ? `Options: ${item.options.join(' / ')}` : '',
    '---',
    `Promoted from the Action Inbox (item ${item.id}), raised in the Claude Code session "${sessionName}".`,
  ]
    .filter(Boolean)
    .join('\n\n')

export const parseIssueUrl = (text: string): { url: string; number: number } | undefined => {
  const [url, num] = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/) ?? []
  return url && num ? { url, number: Number(num) } : undefined
}
