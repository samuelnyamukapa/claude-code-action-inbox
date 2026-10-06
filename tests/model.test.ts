import { describe, expect, test } from 'claude-code/testing'

import type { InboxEvent, Item, SessionInfo } from '../types'
import { buildSnapshot, foldItem, parseMergeTarget, parsePrUrl, pendingFor, projectKey } from '../hooks/model'

const T0 = 1_800_000_000_000
const A = 'session-a'
const B = 'session-b'

const item = (over: Partial<Item> = {}): Item => ({
  id: 'ib_1',
  sessionId: A,
  kind: 'decision',
  title: 'Pick a cache TTL',
  options: ['5 min', '1 hour'],
  source: 'model',
  createdAt: T0,
  ...over,
})

describe('project key', () => {
  test('worktrees of one repo share a key through the origin remote', async () => {
    const main = projectKey('https://github.com/acme/widgets.git', 'C:/code/widgets')
    const wt = projectKey('git@github.com:acme/widgets.git', 'C:/code/widgets')
    expect(main.key).toBe('acme-widgets')
    expect(wt.key).toBe(main.key)
    expect(main.name).toBe('acme/widgets')
  })

  test('falls back to the main worktree root without a remote', async () => {
    expect(projectKey(null, 'C:\\code\\widgets').name).toBe('widgets')
  })
})

describe('pull requests', () => {
  test('reads the PR gh pr create printed', async () => {
    const pr = parsePrUrl('Creating pull request\nhttps://github.com/acme/widgets/pull/471\n')
    expect(pr).toEqual({ repo: 'acme/widgets', number: 471, url: 'https://github.com/acme/widgets/pull/471' })
  })

  test('reads the PR a merge names', async () => {
    expect(parseMergeTarget('gh pr merge 471 --squash')).toEqual({ number: 471 })
    expect(parseMergeTarget('gh pr list')).toBe(undefined)
  })
})

describe('folding', () => {
  test('a reply from the pane is pending for the owner until delivered', async () => {
    const reply: InboxEvent = { id: 'ev_1', itemId: 'ib_1', at: T0 + 10, type: 'feedback', text: '1 hour', isChoice: true, by: B }
    expect(pendingFor(A, [item()], [reply]).replies.length).toBe(1)
    expect(pendingFor(B, [item()], [reply]).replies.length).toBe(0)

    const delivered: InboxEvent = { id: 'ev_2', itemId: 'ib_1', at: T0 + 20, type: 'delivered', ref: 'ev_1', by: A }
    expect(pendingFor(A, [item()], [reply, delivered]).replies.length).toBe(0)
    expect(foldItem(item(), [reply, delivered]).feedback[0]?.isDelivered).toBe(true)
  })

  test('a click in the owning session pane is still delivered to it', async () => {
    const click: InboxEvent = { id: 'ev_7', itemId: 'ib_1', at: T0 + 10, type: 'feedback', text: '5 min', isChoice: true, by: A }
    expect(pendingFor(A, [item()], [click]).replies.length).toBe(1)
  })

  test('a claim moves ownership to the resumed session', async () => {
    const claim: InboxEvent = { id: 'ev_3', itemId: 'ib_1', at: T0 + 5, type: 'claim', by: B }
    const reply: InboxEvent = { id: 'ev_4', itemId: 'ib_1', at: T0 + 10, type: 'feedback', text: 'go', by: 'pane-session' }
    expect(foldItem(item(), [claim]).owner).toBe(B)
    expect(pendingFor(B, [item()], [claim, reply]).replies.length).toBe(1)
  })

  test("the last status wins and the user's own change is a note for the owner", async () => {
    const done: InboxEvent = { id: 'ev_5', itemId: 'ib_1', at: T0 + 5, type: 'status', status: 'done', actor: 'user', by: B }
    const view = foldItem(item(), [done])
    expect(view.status).toBe('done')
    expect(view.closedBy).toBe('user')
    expect(pendingFor(A, [item()], [done]).notes.length).toBe(1)
  })
})

describe('snapshot', () => {
  test('groups by session, self first, blocking first, counts open items', async () => {
    const items = [
      item({ id: 'ib_1', sessionId: B }),
      item({ id: 'ib_2', sessionId: A, kind: 'action', title: 'Rotate the key', options: undefined }),
      item({ id: 'ib_3', sessionId: A, kind: 'merge', title: 'Merge PR #9', blocking: true, createdAt: T0 - 1 }),
    ]
    const sessions: SessionInfo[] = [
      { sessionId: A, branch: 'feat/a', lastSeen: T0 },
      { sessionId: B, branch: 'feat/b', lastSeen: T0 - 60 * 60 * 1000 },
    ]
    const snap = buildSnapshot([{ key: 'p', name: 'P', items, events: [], sessions }], { sessionId: A, projectKey: 'p' }, T0 + 1000, false)
    expect(snap.openCount).toBe(3)
    expect(snap.blockingCount).toBe(1)
    expect(snap.selfOpenCount).toBe(2)
    const groups = snap.projects[0]?.groups ?? []
    expect(groups.map(g => g.sessionId)).toEqual([A, B])
    expect(groups[0]?.presence).toBe('live')
    expect(groups[1]?.presence).toBe('idle')
    expect(groups[0]?.items[0]?.id).toBe('ib_3')
  })

  test('old closed items drop out unless asked for', async () => {
    const closed: InboxEvent = { id: 'ev_9', itemId: 'ib_1', at: T0, type: 'status', status: 'done', actor: 'user', by: A }
    const later = T0 + 2 * 24 * 60 * 60 * 1000
    const input = [{ key: 'p', name: 'P', items: [item()], events: [closed], sessions: [] }]
    expect(buildSnapshot(input, { sessionId: A, projectKey: 'p' }, later, false).projects[0]?.groups.length).toBe(0)
    expect(buildSnapshot(input, { sessionId: A, projectKey: 'p' }, later, true).projects[0]?.groups.length).toBe(1)
  })
})
