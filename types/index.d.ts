export type ItemKind = 'decision' | 'action' | 'signoff' | 'review' | 'merge' | 'waiting'
export type ItemStatus = 'open' | 'done' | 'dismissed'
export type Actor = 'user' | 'model' | 'auto'

/** One item file, written once by the session that raised it. */
export type Item = {
  id: string
  sessionId: string
  kind: ItemKind
  title: string
  detail?: string
  options?: string[]
  blocking?: boolean
  link?: string
  pr?: { repo: string; number: number }
  source: Actor
  createdAt: number
}

/** One event file, written once by whoever acted on an item. */
export type InboxEvent =
  | { id: string; itemId: string; at: number; type: 'status'; status: ItemStatus; actor: Actor; note?: string; by: string }
  | { id: string; itemId: string; at: number; type: 'feedback'; text: string; isChoice?: boolean; by: string }
  | { id: string; itemId: string; at: number; type: 'delivered'; ref: string; by: string }
  | { id: string; itemId: string; at: number; type: 'claim'; by: string }
  | { id: string; itemId: string; at: number; type: 'promoted'; url: string; by: string }

/** A session's heartbeat file, rewritten by that session alone. */
export type SessionInfo = {
  sessionId: string
  branch?: string
  label?: string
  cwd?: string
  lastSeen: number
  isEnded?: boolean
  /** Which agent runs the session; absent means Claude Code. */
  client?: 'claude' | 'copilot'
}

export type FeedbackView = { id: string; text: string; at: number; isChoice?: boolean; isDelivered: boolean }

export type ItemView = Item & {
  owner: string
  status: ItemStatus
  closedBy?: Actor
  note?: string
  updatedAt: number
  feedback: FeedbackView[]
  issueUrl?: string
}

export type SessionGroup = {
  sessionId: string
  branch?: string
  label?: string
  client?: 'claude' | 'copilot'
  presence: 'live' | 'idle' | 'ended'
  isSelf: boolean
  items: ItemView[]
}

export type ProjectView = { key: string; name: string; isSelf: boolean; groups: SessionGroup[] }

export type Snapshot = {
  projects: ProjectView[]
  openCount: number
  blockingCount: number
  selfOpenCount: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'action-inbox': {
      snapshot: Snapshot | null
      view: 'project' | 'all'
      showClosed: boolean
      replyTo: string | null
      confirmPromote: string | null
    }
  }
}
