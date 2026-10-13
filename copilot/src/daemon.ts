// One background process per machine: serves the clickable inbox at a stable
// local address, so a link keeps working after the session that opened it ends,
// and wakes Copilot sessions that have replies waiting (wake.ts). Inbox servers
// start it (ensureDaemon); it stops itself once unused.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { Snapshot } from '../../types'
import { applyAction, inboxHome, inboxView, listProjects, loadProject, type UiAction, type ViewOptions } from './inbox'
import INBOX_HTML from './ui/inbox.html'
import { readConfig, wakePass } from './wake'

export const DAEMON_VERSION = '0.5.0'
const VIEWER = 'browser'
const IDLE_EXIT_MS = 6 * 60 * 60 * 1000

type State = { port: number; token: string; pid: number; version: string }

// ACTION_INBOX_DEBUG=<file> also records how the background process starts and stops
const trace = (event: string, extra: Record<string, unknown> = {}) => {
  const file = process.env.ACTION_INBOX_DEBUG
  if (!file) return
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...extra })}\n`)
  } catch {
    // tracing is best effort
  }
}

const statePath = () => join(inboxHome(), '.daemon.json')

export const readState = (): State | undefined => {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as State
  } catch {
    return undefined
  }
}

const request = (state: State, path: string, method = 'GET'): Promise<{ status: number; body: string }> =>
  fetch(`http://127.0.0.1:${state.port}/${state.token}/${path}`, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(1500),
  })
    .then(async res => ({ status: res.status, body: await res.text() }))
    .catch(() => ({ status: 0, body: '' }))

export const isHealthy = async (state: State | undefined): Promise<boolean> => {
  if (!state) return false
  const res = await request(state, 'health')
  return res.status === 200 && res.body === DAEMON_VERSION
}

// settings the background process needs from whoever starts it
const PASSED_ENV = /^(ACTION_INBOX_|COPILOT_HOME$|FAKE_COPILOT_LOG$|PATH$)/i
const envPath = () => join(inboxHome(), '.daemon-env.json')

/**
 * Starts the background process so that it outlives its starter. Copilot runs
 * MCP servers in a Windows job that kills every process in it when Copilot exits,
 * detached or not, so on Windows the process is created through WMI, which puts
 * it outside the job. It then has the user's default environment, so the few
 * settings it needs travel in a file.
 */
const launch = (script: string) => {
  mkdirSync(inboxHome(), { recursive: true })
  writeFileSync(envPath(), JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => PASSED_ENV.test(k)))))
  const quote = (s: string) => `"${s.replace(/"/g, '')}"`
  if (process.platform === 'win32' && !process.env.ACTION_INBOX_PLAIN_SPAWN) {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:AI_DAEMON_CMD; CurrentDirectory = $env:AI_DAEMON_CWD }; exit $r.ReturnValue',
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, AI_DAEMON_CMD: `${quote(process.execPath)} ${quote(script)} --home ${quote(inboxHome())}`, AI_DAEMON_CWD: inboxHome() },
      },
    )
    ps.on('error', err => trace('daemon.launch-error', { error: String(err) }))
    ps.on('exit', code => trace('daemon.launched', { via: 'wmi', code }))
    return
  }
  const child = spawn(process.execPath, [script, '--home', inboxHome()], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
  child.on('error', err => trace('daemon.launch-error', { error: String(err) }))
  child.unref()
  trace('daemon.launched', { via: 'spawn', child: child.pid })
}

/** The inbox page's address, starting the background process if it is not running. */
export const ensureDaemon = async (script: string): Promise<string | undefined> => {
  let state = readState()
  if (await isHealthy(state)) return `http://127.0.0.1:${state!.port}/${state!.token}/`
  // an older version keeps the address but hands over to this one
  if (state) await request(state, 'shutdown', 'POST')
  launch(script)
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100))
    state = readState()
    if (await isHealthy(state)) return `http://127.0.0.1:${state!.port}/${state!.token}/`
  }
  trace('daemon.not-ready', { state })
  return undefined
}

// ---------- the background process itself ----------

const projectFor = (key: unknown) => {
  const all = listProjects()
  const named = all.find(p => p.key === key)
  if (named) return named
  // no project named: the one whose sessions were active last
  let best = all[0]
  let bestSeen = -1
  for (const meta of all) {
    const seen = Math.max(0, ...loadProject(meta).sessions.map(s => s.lastSeen))
    if (seen > bestSeen) {
      best = meta
      bestSeen = seen
    }
  }
  return best
}

const act = (body: Record<string, unknown>): { snapshot: Snapshot; view: Record<string, unknown>; webUrl?: string; message?: string; wake: string } | { error: string } => {
  const meta = projectFor(body.projectKey)
  if (!meta) return { error: 'The inbox is empty: no session has used it yet.' }
  const opts: ViewOptions = { scope: body.scope === 'all' ? 'all' : 'project', showClosed: body.showClosed === true }
  const action = String(body.action ?? 'refresh')
  let message: string | undefined
  if (action !== 'refresh') {
    message = applyAction(VIEWER, {
      action: action as UiAction['action'],
      id: String(body.id ?? ''),
      text: typeof body.text === 'string' ? body.text : undefined,
      projectKey: String(body.itemProjectKey ?? body.projectKey ?? meta.key),
    })
    // a reply to a session that can be woken goes out now, not at the next tick
    setTimeout(tick, 50)
  }
  return {
    snapshot: inboxView(meta, VIEWER, opts),
    view: { ...opts, projectKey: meta.key, projectName: meta.name },
    message,
    wake: readConfig().wake,
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

let lastUsed = Date.now()
let isWaking = false

function tick() {
  if (isWaking) return
  isWaking = true
  try {
    const runs = wakePass()
    if (runs.length) lastUsed = Date.now()
    void Promise.allSettled(runs)
  } catch {
    // a half-written file: next tick
  } finally {
    isWaking = false
  }
}

const main = () => {
  // started outside its starter's environment (see launch): take back what it passed
  const at = process.argv.indexOf('--home')
  if (at > 0 && process.argv[at + 1]) process.env.ACTION_INBOX_HOME = process.argv[at + 1]
  try {
    const passed = JSON.parse(readFileSync(envPath(), 'utf8')) as Record<string, string>
    // PATH too: the default one often lacks git, and the copilot it resumes needs both
    for (const [k, v] of Object.entries(passed)) {
      if (!PASSED_ENV.test(k)) continue
      if (/^path$/i.test(k)) process.env.PATH = v
      else if (process.env[k] === undefined) process.env[k] = v
    }
  } catch {
    // started by hand: its own environment will do
  }
  trace('daemon.start', { ppid: process.ppid })
  process.on('exit', code => trace('daemon.exit', { code }))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, () => {
      trace('daemon.signal', { signal })
      process.exit(0)
    })
  }
  const prior = readState()
  const token = prior?.token ?? randomBytes(18).toString('base64url')
  let origin = ''
  const page = INBOX_HTML.replace('<script>', `<script>window.__INBOX_API__ = ${JSON.stringify(`/${token}/api`)}</script>\n<script>`)

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra })
      res.end(body)
    }
    // another hostname pointing at 127.0.0.1 must not reach the inbox
    if (`http://${req.headers.host ?? ''}` !== origin) return send(403, 'text/plain', 'Forbidden')
    const path = (req.url ?? '/').split('?')[0]
    lastUsed = Date.now()

    if (req.method === 'GET' && path === `/${token}/`) {
      return send(200, 'text/html; charset=utf-8', page, {
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
    }
    if (req.method === 'GET' && path === `/${token}/health`) return send(200, 'text/plain', DAEMON_VERSION)
    if (req.method === 'POST' && (path === `/${token}/api/act` || path === `/${token}/shutdown`)) {
      const from = req.headers.origin
      if (from !== undefined && from !== origin) return send(403, 'text/plain', 'Forbidden')
      // a JSON body cannot be sent cross-site without a preflight this server never answers
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, 'text/plain', 'Expected JSON')
      if (path.endsWith('/shutdown')) {
        send(200, 'text/plain', 'bye')
        server.close()
        setTimeout(() => process.exit(0), 50)
        return
      }
      readBody(req)
        .then(text => send(200, 'application/json; charset=utf-8', JSON.stringify(act(JSON.parse(text) as Record<string, unknown>))))
        .catch(err => send(400, 'text/plain', String((err as Error).message ?? err)))
      return
    }
    send(404, 'text/plain', 'Not found')
  })

  const listen = (port: number) => server.listen(port, '127.0.0.1')
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE' || server.listening || !prior?.port) process.exit(1)
    // the saved port is taken: by another copy of this process (step aside),
    // or by something else (take a new port; the link changes once)
    void isHealthy(readState()).then(isRunning => {
      if (isRunning) process.exit(0)
      listen(0)
    })
  })
  const onListening = async () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    origin = `http://127.0.0.1:${port}`
    // two sessions may start this at once: the first to record itself wins
    const current = readState()
    if (current && current.pid !== process.pid && current.port !== port && (await isHealthy(current))) process.exit(0)
    writeFileSync(statePath(), JSON.stringify({ port, token, pid: process.pid, version: DAEMON_VERSION } satisfies State))
    trace('daemon.listening', { port })
  }
  server.on('listening', () => void onListening())
  listen(prior?.port ?? 0)

  setInterval(tick, Number(process.env.ACTION_INBOX_WAKE_MS ?? 4000))
  setInterval(() => {
    const recent = listProjects().some(meta => loadProject(meta).sessions.some(s => Date.now() - s.lastSeen < IDLE_EXIT_MS))
    if (!recent && Date.now() - lastUsed > IDLE_EXIT_MS) process.exit(0)
  }, 60 * 1000)
}

if (process.argv[1] && /daemon\.m?[jt]s$/.test(process.argv[1])) main()
