// Hands the user's replies to Copilot sessions by resuming the session with the
// reply as its prompt (`copilot --resume <id>`, prompt on stdin). Copilot has no
// API to message a session that is open, so by default a session another process
// holds open is left alone: it gets the reply from the hooks at its next step or
// message. With "wake": "always" it is resumed anyway (never mid-turn); Copilot
// allows two processes on one session and its history is append-only, but the
// app holding it may not show the new turn until the session is reopened.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SessionInfo } from '../../types'
import { pendingFor, replyPrompt, statusNote } from '../../hooks/model'
import { addEvent, heartbeat, inboxHome, listProjects, loadProject, type Project } from './inbox'

export type WakeMode = 'on' | 'always' | 'off'

export type Config = {
  /**
   * on (default): wake sessions nobody has open; always: also sessions open in
   * another process, such as the GitHub Copilot app (never mid-turn); off: never
   */
  wake: WakeMode
  /** Extra arguments for the resumed run, e.g. ["--allow-all-tools"] */
  wakeArgs: string[]
}

const DEFAULTS: Config = { wake: 'on', wakeArgs: [] }
const RUNNING_STALE_MS = 15 * 60 * 1000

export const configPath = () => join(inboxHome(), 'config.json')

export const readConfig = (): Config => {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<Config>
    return {
      wake: raw.wake === 'off' || raw.wake === 'always' ? raw.wake : 'on',
      // these reach a shell on Windows, so only plain flags and values pass
      wakeArgs: Array.isArray(raw.wakeArgs) ? raw.wakeArgs.filter(a => typeof a === 'string' && /^[\w=.:,@/+-]+$/.test(a)) : [],
    }
  } catch {
    return DEFAULTS
  }
}

export const copilotHome = () => process.env.COPILOT_HOME ?? join(homedir(), '.copilot')

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type Hold = { file: string; pid: number; isLive: boolean }

/**
 * The in-use locks on a session's folder. Copilot keeps an inuse.<pid>.hold file
 * there while a process has the session loaded, locked, and deletes it on a clean
 * exit. A process that was killed leaves its file behind, and Windows may have
 * given its id to another process since, so on Windows a hold counts only while
 * the file is still locked (reading it fails with EBUSY). Undefined when the
 * folder cannot be found (another Copilot home, or a client that keeps none).
 */
export const holdsOf = (sessionId: string): Hold[] | undefined => {
  const dir = join(copilotHome(), 'session-state', sessionId)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return undefined
  }
  const holds: Hold[] = []
  for (const name of names) {
    const pid = Number(name.match(/^inuse\.(\d+)\.hold$/)?.[1])
    if (!(pid > 0)) continue
    const file = join(dir, name)
    let isLive = false
    if (pid !== process.pid) {
      if (process.platform === 'win32') {
        try {
          readFileSync(file)
        } catch (err) {
          isLive = (err as NodeJS.ErrnoException).code === 'EBUSY'
        }
      } else {
        isLive = isAlive(pid)
      }
    }
    holds.push({ file, pid, isLive })
  }
  return holds
}

export const isHeld = (sessionId: string): boolean | undefined => holdsOf(sessionId)?.some(h => h.isLive)

/** Why a session cannot be woken now, or undefined when it can. */
export type WakeBlock = 'not-copilot' | 'off' | 'mid-turn' | 'open' | 'unknown-open'

export const wakeBlock = (session: SessionInfo | undefined, cfg: Config, now: number): WakeBlock | undefined => {
  if (!session || session.client !== 'copilot' || !/^[\w-]+$/.test(session.sessionId)) return 'not-copilot'
  if (cfg.wake === 'off') return 'off'
  // never start a turn on top of one; a "running" older than this is a session that died mid-turn
  if (session.turn === 'running' && now - session.lastSeen < RUNNING_STALE_MS) return 'mid-turn'
  const held = isHeld(session.sessionId)
  if (held === true && cfg.wake !== 'always') return 'open'
  // no folder to check: only a session that said it ended is surely not open
  if (held === undefined && !session.isEnded && cfg.wake !== 'always') return 'unknown-open'
  return undefined
}

/** Whether a session may be given a turn now. */
export const canWake = (session: SessionInfo | undefined, cfg: Config, now: number): boolean => wakeBlock(session, cfg, now) === undefined

/** For the inbox view: each Copilot session's wake status, "ready" when it can be woken. */
export const wakeStatusOf = (sessions: readonly SessionInfo[], cfg: Config = readConfig()): Record<string, WakeBlock | 'ready'> => {
  const now = Date.now()
  const out: Record<string, WakeBlock | 'ready'> = {}
  for (const session of sessions) {
    if (session.client !== 'copilot') continue
    out[session.sessionId] = wakeBlock(session, cfg, now) ?? 'ready'
  }
  return out
}

// a file created with "wx" exists once: whichever process makes it owns the wake
const claim = (dir: string, ref: string): boolean => {
  mkdirSync(dir, { recursive: true })
  try {
    closeSync(openSync(join(dir, `${ref}.lock`), 'wx'))
    return true
  } catch {
    return false
  }
}

/** The command that runs Copilot; tests swap in a stand-in through ACTION_INBOX_COPILOT_CMD (a JSON array). */
const copilotCommand = (args: string[]): { cmd: string; args: string[]; shell: boolean } => {
  const custom = process.env.ACTION_INBOX_COPILOT_CMD
  if (custom) {
    const [cmd = 'copilot', ...pre] = JSON.parse(custom) as string[]
    return { cmd, args: [...pre, ...args], shell: false }
  }
  // copilot is a .cmd shim on Windows, which only a shell can start; every
  // argument here is a checked id or flag, and the prompt goes on stdin
  return { cmd: 'copilot', args, shell: process.platform === 'win32' }
}

export type WakeResult = { sessionId: string; refs: string[]; ok: boolean; detail?: string }

/** Starts one turn in the session with everything it has yet to hear. Resolves when the turn ends. */
const wakeOne = (project: Project, session: SessionInfo, cfg: Config): Promise<WakeResult> | undefined => {
  const { replies, notes } = pendingFor(session.sessionId, project.items, project.events)
  const fresh = replies.filter(r => claim(join(project.dir, 'wake'), r.event.id))
  if (fresh.length === 0) return undefined

  const by = `waker:${process.pid}`
  for (const { item, event } of [...fresh, ...notes]) addEvent(project, by, { type: 'delivered', itemId: item.id, ref: event.id })
  // marked running now, so neither this process nor another starts a second turn
  heartbeat(project, { sessionId: session.sessionId, client: 'copilot', turn: 'running' })

  const prompt = [
    ...notes.map(({ item, event }) => statusNote(item, event.status, event.note)),
    ...fresh.map(({ item, event }) => replyPrompt(item, event.text, event.isChoice)),
  ].join('\n\n')
  const logDir = join(inboxHome(), '.wake-logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${session.sessionId}.log`)
  writeFileSync(logPath, `${new Date().toISOString()} resuming with:\n${prompt}\n---\n`, { flag: 'a' })
  const out = openSync(logPath, 'a')

  const record = (ok: boolean, detail?: string): WakeResult => {
    for (const { item, event } of fresh) addEvent(project, by, { type: 'wake', itemId: item.id, ref: event.id, ok, detail })
    if (!ok) heartbeat(project, { sessionId: session.sessionId, client: 'copilot', turn: 'idle' })
    return { sessionId: session.sessionId, refs: fresh.map(f => f.event.id), ok, detail }
  }

  return new Promise(resolve => {
    // the woken turn runs unattended: it may use the inbox's own tools (to resolve
    // the item), and whatever else config.json's wakeArgs allow
    const { cmd, args, shell } = copilotCommand(['--resume', session.sessionId, '--allow-tool=action-inbox', ...cfg.wakeArgs])
    const cwd = session.cwd && existsSync(session.cwd) ? session.cwd : homedir()
    let isDone = false
    const finish = (ok: boolean, detail?: string) => {
      if (isDone) return
      isDone = true
      closeSync(out)
      resolve(record(ok, detail))
    }
    try {
      const child = spawn(cmd, args, { cwd, shell, stdio: ['pipe', out, out], windowsHide: true, env: process.env })
      child.on('error', err => finish(false, (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Copilot CLI (copilot) is not on PATH' : String(err)))
      child.on('exit', code => finish(code === 0, code === 0 ? undefined : `copilot exited with code ${code}; see ${logPath}`))
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(prompt)
    } catch (err) {
      finish(false, String(err))
    }
  })
}

/** One pass over every project: wake each eligible session that has replies waiting. */
export const wakePass = (cfg: Config = readConfig()): Promise<WakeResult>[] => {
  if (cfg.wake === 'off') return []
  const now = Date.now()
  const started: Promise<WakeResult>[] = []
  for (const meta of listProjects()) {
    const project = loadProject(meta)
    for (const session of project.sessions) {
      if (!canWake(session, cfg, now)) continue
      const run = wakeOne(project, session, cfg)
      if (run) started.push(run)
    }
  }
  return started
}
