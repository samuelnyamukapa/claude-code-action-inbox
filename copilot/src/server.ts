// The Action Inbox as an MCP server (stdio, newline-delimited JSON-RPC) for
// GitHub Copilot and any other MCP client. No dependencies: the protocol
// surface it needs is small.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { clip, phoneList } from '../../hooks/model'
import {
  addItem,
  applyAction,
  GUIDE,
  heartbeat,
  inboxView,
  itemFromInput,
  loadProject,
  locate,
  pollPrs,
  runCommand,
  saveProjectMeta,
  setStatus,
  snapshotOf,
  type UiAction,
  type ViewOptions,
  viewOf,
  type Where,
} from './inbox'
import INBOX_HTML from './ui/inbox.html'
import { openBrowser, startWeb } from './web'

const VERSION = '0.4.0'
const UI_URI = 'ui://action-inbox/inbox.html'
const UI_MIME = 'text/html;profile=mcp-app'
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const PR_POLL_MS = 5 * 60 * 1000
// filed under this until a hook names the real session (see hook.ts)
const UNKNOWN_SESSION = `copilot-${process.pid.toString(36)}`

type Json = Record<string, unknown>

const send = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`)

// ---------- where the client is working ----------

let rootCwd: string | undefined
let canListRoots = false
// whether the client draws MCP Apps (interactive views in the chat)
let canShowApps = false
// the last session a hook named, for the browser page, which has no session of its own
let lastSession: { id?: string; cwd?: string } = {}
let hasOpenedBrowser = false
const located = new Map<string, Where>()

const whereOf = (cwd: string | undefined): Where => {
  const dir = cwd ?? rootCwd ?? process.cwd()
  let where = located.get(dir)
  if (!where) {
    where = locate(dir)
    located.set(dir, where)
    saveProjectMeta(where)
  }
  return where
}

let nextRequest = 1
const waiting = new Map<string, (result: unknown) => void>()

const ask = (method: string, params?: Json): Promise<unknown> =>
  new Promise(resolve => {
    const id = `srv-${nextRequest++}`
    waiting.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
    setTimeout(() => waiting.delete(id) && resolve(undefined), 5000).unref()
  })

const refreshRoots = async () => {
  if (!canListRoots) return
  const result = (await ask('roots/list')) as { roots?: { uri: string }[] } | undefined
  const uri = result?.roots?.find(r => r.uri.startsWith('file:'))?.uri
  if (uri) rootCwd = fileURLToPath(uri)
}

// ---------- tools ----------

const SESSION_PROP = {
  type: 'object',
  description: 'Filled in automatically by the Action Inbox hooks; leave it out.',
  properties: { id: { type: 'string' }, cwd: { type: 'string' } },
}

const TOOLS = [
  {
    name: 'inbox_add',
    description:
      "Log a decision or manual action the USER owes to their cross-session Action Inbox so it is not lost in the scroll. Use it alongside asking in chat, once per distinct item. Returns the item id; the user's reply arrives later as context starting with [Action Inbox].",
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
        session: SESSION_PROP,
      },
      required: ['kind', 'title'],
    },
  },
  {
    name: 'inbox_resolve',
    description: 'Mark an Action Inbox item settled: done when the decision or action happened, dismissed when it no longer applies.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item id (ib_...)' },
        status: { type: 'string', enum: ['done', 'dismissed'] },
        note: { type: 'string', description: 'What was decided or done, in a few words' },
        session: SESSION_PROP,
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'inbox_list',
    description: "List the open Action Inbox items for this project, with the user's replies.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'project'], description: 'This session only (default) or the whole project' },
        session: SESSION_PROP,
      },
    },
  },
  {
    name: 'inbox_command',
    description:
      'Run the USER\'s own Action Inbox command, e.g. "list", "reply 3 go ahead", "pick 3 2", "done 3", "dismiss 3", "issue 3", "add Call the accountant". Call it ONLY when the user explicitly asks to act on their inbox, passing their words after "inbox" unchanged; never use it to answer items yourself. Show the user the result.',
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'string', description: 'The user\'s words after "inbox", unchanged' },
        session: SESSION_PROP,
      },
      required: ['args'],
    },
  },
  {
    name: 'inbox_view',
    description:
      "Show the user's Action Inbox as an interactive view: colour-coded items with buttons to choose a decision's option, reply, mark done, dismiss, reopen or promote to a GitHub issue. Call it whenever the user asks to see, open or work through their inbox.",
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'all'], description: 'This project (default) or every project' },
        open_in_browser: { type: 'boolean', description: 'Also open the view in the browser; use it when the user asks or cannot see the view in the chat' },
        session: SESSION_PROP,
      },
    },
    _meta: { ui: { resourceUri: UI_URI } },
  },
]

// the inbox view's own buttons; hosts keep "app" tools away from the model
const APP_TOOL = {
  name: 'inbox_app_action',
  description: "Used by the Action Inbox view's buttons on the user's behalf. Never call it yourself.",
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['refresh', 'pick', 'reply', 'done', 'dismiss', 'reopen', 'issue'] },
      id: { type: 'string' },
      text: { type: 'string' },
      projectKey: { type: 'string' },
      scope: { type: 'string', enum: ['project', 'all'] },
      showClosed: { type: 'boolean' },
      session: SESSION_PROP,
    },
    required: ['action'],
  },
  _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] } },
}

type ToolOut = { text: string; isError?: boolean; structured?: Json }

/** What the inbox view draws, and a plain-text version for clients that only show text. */
const viewPayload = async (where: Where, viewer: string, opts: ViewOptions, message?: string): Promise<ToolOut> => {
  const snapshot = inboxView(where, viewer, opts)
  const webUrl = await startWeb(INBOX_HTML, webAct).catch(() => undefined)
  const self = snapshot.projects.find(p => p.isSelf)
  const lines = [phoneList(self).replace(/\/inbox /g, 'inbox ')]
  if (webUrl) lines.push('', `Clickable inbox in your browser (works while this session runs): ${webUrl}`)
  return {
    text: lines.join('\n'),
    structured: { snapshot, view: { ...opts, projectKey: where.key, projectName: where.name }, webUrl, message },
  }
}

const optsOf = (input: Json): ViewOptions => ({ scope: input.scope === 'all' ? 'all' : 'project', showClosed: input.showClosed === true })

/** A button press in the inbox view, from the chat or the browser. */
const uiAct = async (input: Json, viewer: string, where: Where): Promise<ToolOut> => {
  const action = String(input.action ?? 'refresh')
  let message: string | undefined
  if (action !== 'refresh') {
    message = applyAction(viewer, {
      action: action as UiAction['action'],
      id: String(input.id ?? ''),
      text: typeof input.text === 'string' ? input.text : undefined,
      projectKey: String(input.projectKey ?? where.key),
    })
  }
  return viewPayload(where, viewer, optsOf(input), message)
}

// the browser page has no session of its own: it acts for the last one a hook named
const webAct = async (body: Json): Promise<Json | undefined> => {
  const where = whereOf(lastSession.cwd)
  return (await uiAct(body, lastSession.id ?? UNKNOWN_SESSION, where)).structured
}

const callTool = async (name: string, input: Json): Promise<ToolOut> => {
  const session = (input.session ?? {}) as { id?: string; cwd?: string }
  const sessionId = typeof session.id === 'string' && session.id ? session.id : UNKNOWN_SESSION
  if (sessionId !== UNKNOWN_SESSION) lastSession = { id: sessionId, cwd: typeof session.cwd === 'string' ? session.cwd : undefined }
  const where = whereOf(typeof session.cwd === 'string' && session.cwd ? session.cwd : undefined)
  const project = loadProject(where)

  if (name === 'inbox_view') {
    const out = await viewPayload(where, sessionId, optsOf(input))
    const webUrl = out.structured?.webUrl
    // a client that cannot draw the view gets the browser page instead, once unasked
    const shouldOpen = input.open_in_browser === true || (!canShowApps && !hasOpenedBrowser)
    if (shouldOpen && typeof webUrl === 'string') {
      hasOpenedBrowser = true
      openBrowser(webUrl)
      out.text += '\nOpened it in the browser.'
    }
    return out
  }

  if (name === 'inbox_app_action') return uiAct(input, sessionId, where)

  if (name === 'inbox_add') {
    const fields = itemFromInput(input)
    if (typeof fields === 'string') return { text: fields, isError: true }
    if (sessionId === UNKNOWN_SESSION) {
      heartbeat(project, { sessionId, branch: where.branch, cwd: where.root, client: 'copilot', label: 'Copilot session' })
    }
    const item = addItem(project, sessionId, { ...fields, source: 'model' })
    return { text: `Logged inbox item ${item.id}. The user's reply, if any, will arrive as context starting with [Action Inbox].` }
  }

  if (name === 'inbox_resolve') {
    const view = typeof input.id === 'string' ? viewOf(project, input.id) : undefined
    if (!view) return { text: `No inbox item ${String(input.id)} in this project.`, isError: true }
    const status = input.status === 'dismissed' ? 'dismissed' : 'done'
    setStatus(project, sessionId, view.id, status, 'model', typeof input.note === 'string' ? clip(input.note, 200) : undefined)
    return { text: `Inbox item ${view.id} marked ${status}.` }
  }

  if (name === 'inbox_list') {
    const isProject = input.scope === 'project' || sessionId === UNKNOWN_SESSION
    const lines: string[] = []
    for (const group of snapshotOf(project, sessionId).projects[0]?.groups ?? []) {
      if (!isProject && !group.isSelf) continue
      for (const item of group.items.filter(i => i.status === 'open')) {
        const who = group.isSelf ? 'this session' : (group.branch ?? group.label ?? group.sessionId.slice(0, 8))
        lines.push(`- ${item.id} [${item.kind}${item.blocking ? ', blocking' : ''}] ${item.title} (${who})`)
        for (const fb of item.feedback) lines.push(`  user ${fb.isChoice ? 'chose' : 'replied'}: ${fb.text}`)
      }
    }
    return { text: lines.length ? lines.join('\n') : 'No open inbox items.' }
  }

  if (name === 'inbox_command') {
    return { text: runCommand(project, sessionId, typeof input.args === 'string' ? input.args : '') }
  }

  return { text: `Unknown tool ${name}.`, isError: true }
}

// ---------- prompts: "/inbox" in clients that surface MCP prompts ----------

const PROMPTS = [
  {
    name: 'inbox',
    description: 'Action Inbox: show it, or list, reply, pick, done, dismiss, issue or add',
    arguments: [{ name: 'command', description: 'e.g. "reply 3 go ahead" (empty shows the inbox)', required: false }],
  },
]

// ---------- the JSON-RPC loop ----------

const handle = async (msg: Json): Promise<Json | undefined> => {
  const method = typeof msg.method === 'string' ? msg.method : undefined
  if (!method) {
    // a reply to something this server asked the client
    const resolve = waiting.get(String(msg.id))
    if (resolve) {
      waiting.delete(String(msg.id))
      resolve(msg.result)
    }
    return undefined
  }
  const params = (msg.params ?? {}) as Json

  switch (method) {
    case 'initialize': {
      const caps = (params.capabilities ?? {}) as Json
      canListRoots = Boolean(caps.roots)
      const ui = ((caps.extensions ?? {}) as Json)['io.modelcontextprotocol/ui'] as { mimeTypes?: string[] } | undefined
      canShowApps = Boolean(ui?.mimeTypes?.includes(UI_MIME))
      if (process.env.ACTION_INBOX_DEBUG) {
        appendFileSync(process.env.ACTION_INBOX_DEBUG, `${JSON.stringify({ at: new Date().toISOString(), event: 'mcp.initialize', clientInfo: params.clientInfo, capabilities: caps })}\n`)
      }
      const asked = String(params.protocolVersion ?? '')
      return {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: {}, prompts: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': {} } },
        serverInfo: { name: 'action-inbox', version: VERSION },
        instructions: GUIDE,
      }
    }
    case 'notifications/initialized':
    case 'notifications/roots/list_changed':
      void refreshRoots()
      return undefined
    case 'ping':
      return {}
    case 'tools/list':
      // the view's button tool exists only where a view can press it
      return { tools: canShowApps ? [...TOOLS, APP_TOOL] : TOOLS }
    case 'tools/call': {
      try {
        const { text, isError, structured } = await callTool(String(params.name), (params.arguments ?? {}) as Json)
        return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), isError: Boolean(isError) }
      } catch (err) {
        return { content: [{ type: 'text', text: `Action Inbox failed: ${clip(String(err), 300)}` }], isError: true }
      }
    }
    case 'resources/list':
      return { resources: [{ uri: UI_URI, name: 'Action Inbox', description: 'The interactive inbox view', mimeType: UI_MIME }] }
    case 'resources/read': {
      if (params.uri !== UI_URI) throw Object.assign(new Error(`Unknown resource ${String(params.uri)}`), { code: -32002 })
      return { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: INBOX_HTML, _meta: { ui: { prefersBorder: false } } }] }
    }
    case 'prompts/list':
      return { prompts: PROMPTS }
    case 'prompts/get': {
      const command = String((params.arguments as Json | undefined)?.command ?? '').trim()
      const text = command
        ? `Run my Action Inbox command with inbox_command, args "${command}", and show me the result.`
        : 'Show my Action Inbox with inbox_view.'
      return { description: 'Action Inbox', messages: [{ role: 'user', content: { type: 'text', text } }] }
    }
    default:
      if (method.startsWith('notifications/')) return undefined
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  if (!line.trim()) return
  let msg: Json
  try {
    msg = JSON.parse(line) as Json
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  const hasId = msg.id !== undefined && msg.id !== null
  handle(msg).then(
    result => {
      if (hasId && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} })
    },
    (err: Error & { code?: number }) => {
      if (hasId) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } })
    },
  )
})
lines.on('close', () => process.exit(0))

// PRs raised by Copilot sessions, or by sessions no longer running, close themselves on merge
setInterval(() => {
  try {
    const project = loadProject(whereOf(undefined))
    const groups = snapshotOf(project, UNKNOWN_SESSION).projects[0]?.groups ?? []
    const mine = new Set(groups.filter(g => g.client === 'copilot' || g.presence !== 'live').map(g => g.sessionId))
    pollPrs(project, UNKNOWN_SESSION, owner => mine.has(owner))
  } catch {
    // gh missing or offline: try again next time
  }
}, PR_POLL_MS).unref()
