import { describe, expect, test } from 'claude-code/testing'

import type { InboxEvent, Item } from '../types'
import {
  buildSnapshot,
  foldItem,
  issueBody,
  issueRepo,
  openInOrder,
  parseInboxArgs,
  parseIssueUrl,
  phoneList,
  resolveOption,
  resolveRef,
} from '../hooks/model'

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

const snapshotOf = (items: Item[], events: InboxEvent[] = []) =>
  buildSnapshot(
    [{ key: 'p', name: 'acme/widgets', items, events, sessions: [{ sessionId: B, branch: 'Deploy fixes', lastSeen: T0 }] }],
    { sessionId: A, projectKey: 'p' },
    T0 + 1000,
    false,
  ).projects[0]

describe('/inbox arguments', () => {
  test('bare and all open the pane', async () => {
    expect(parseInboxArgs('')).toEqual({ verb: 'pane', isAll: false })
    expect(parseInboxArgs(' all ')).toEqual({ verb: 'pane', isAll: true })
  })

  test('phone verbs carry a reference and text', async () => {
    expect(parseInboxArgs('reply 3 go ahead with it')).toEqual({ verb: 'reply', ref: '3', text: 'go ahead with it' })
    expect(parseInboxArgs('pick #2 1')).toEqual({ verb: 'pick', ref: '2', text: '1' })
    expect(parseInboxArgs('done 4')).toEqual({ verb: 'done', ref: '4', text: '' })
    expect(parseInboxArgs('issue 1')).toEqual({ verb: 'issue', ref: '1', text: '' })
    expect(parseInboxArgs('open 5')).toEqual({ verb: 'open', ref: '5', text: '' })
    expect(parseInboxArgs('list')).toEqual({ verb: 'list' })
    expect(parseInboxArgs('add Call the bank')).toEqual({ verb: 'add', text: 'Call the bank' })
  })

  test('anything else, or a verb missing its number, asks for help', async () => {
    expect(parseInboxArgs('frobnicate')).toEqual({ verb: 'help' })
    expect(parseInboxArgs('reply')).toEqual({ verb: 'help' })
    expect(parseInboxArgs('add')).toEqual({ verb: 'help' })
  })
})

describe('numbering', () => {
  test('numbers follow the pane order and resolve by number or id', async () => {
    const project = snapshotOf([item({ id: 'ib_1' }), item({ id: 'ib_2', sessionId: B, kind: 'action', options: undefined, title: 'Rotate key' })])
    const open = openInOrder(project)
    expect(open.map(i => i.id)).toEqual(['ib_1', 'ib_2'])
    expect(resolveRef('2', open)?.id).toBe('ib_2')
    expect(resolveRef('ib_1', open)?.id).toBe('ib_1')
    expect(resolveRef('9', open)).toBe(undefined)
  })

  test('an option resolves by its number or its label', async () => {
    const view = foldItem(item(), [])
    expect(resolveOption(view, '2')).toBe('1 hour')
    expect(resolveOption(view, '5 MIN')).toBe('5 min')
    expect(resolveOption(view, '7')).toBe(undefined)
  })

  test('the phone list numbers items under their session', async () => {
    const text = phoneList(snapshotOf([item({ id: 'ib_1' }), item({ id: 'ib_2', sessionId: B, title: 'Merge PR #9', kind: 'merge', options: undefined })]))
    expect(text.includes('#1 [decision] Pick a cache TTL')).toBe(true)
    expect(text.includes('options: 1) 5 min  2) 1 hour')).toBe(true)
    expect(text.includes('— Deploy fixes')).toBe(true)
    expect(text.includes('#2 [merge] Merge PR #9')).toBe(true)
    expect(phoneList(snapshotOf([]))).toBe('Nothing waiting on you.')
  })
})

describe('promote to issue', () => {
  test('files in the PR repo, else the project repo', async () => {
    expect(issueRepo(foldItem(item(), []), 'acme/widgets')).toBe('acme/widgets')
    expect(issueRepo(foldItem(item({ pr: { repo: 'other/repo', number: 3 } }), []), 'acme/widgets')).toBe('other/repo')
    expect(issueRepo(foldItem(item(), []), 'widgets')).toBe(undefined)
  })

  test('the body names the item and its session', async () => {
    const body = issueBody(foldItem(item({ detail: 'Why it matters', link: 'https://example.com/x' }), []), 'Deploy fixes')
    expect(body.includes('Why it matters')).toBe(true)
    expect(body.includes('Link: https://example.com/x')).toBe(true)
    expect(body.includes('item ib_1')).toBe(true)
    expect(body.includes('"Deploy fixes"')).toBe(true)
  })

  test('reads the URL gh prints and records it on the item', async () => {
    const made = parseIssueUrl('Creating issue in acme/widgets\nhttps://github.com/acme/widgets/issues/521\n')
    expect(made).toEqual({ url: 'https://github.com/acme/widgets/issues/521', number: 521 })
    const promoted: InboxEvent = { id: 'ev_p', itemId: 'ib_1', at: T0 + 1, type: 'promoted', url: made?.url ?? '', by: A }
    expect(foldItem(item(), [promoted]).issueUrl).toBe('https://github.com/acme/widgets/issues/521')
  })
})
