// Hands the user's replies to Copilot sessions that nobody has open, by resuming
// the session with the reply as its prompt (`copilot --resume <id>`, prompt on
// stdin). Copilot has no API to message a session that is open, and resuming one
// that is would race the app, so a session another process holds is left alone:
// it gets the reply from the hooks at its next step or message.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SessionInfo } from '../../types'
import { pendingFor, replyPrompt, statusNote } from '../../hooks/model'
import { addEvent, heartbeat, inboxHome, listProjects, loadProject, type Project } from './inbox'

export type WakeMode = 'on' | 'off'

export type Config = {
  /** on (default): wake sessions nobody has open; off: never */
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
      wake: raw.wake === 'off' ? 'off' : 'on',
      // these reach a shell on Windows, so only plain flags and values pass
      wakeArgs: Array.isArray(raw.wakeArgs) ? raw.wakeArgs.filter(a => typeof a === 'string' && /^[\w=.:,@/+-]+$/.test(a)) : [],
    }
  } catch {
    return DEFAULTS
  }
}

const copilotHome = () => process.env.COPILOT_HOME ?? join(homedir(), '.copilot')

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it just is not ours to signal
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Whether some process has the session open. Copilot keeps an inuse.<pid>.hold
 * file in the session's folder while a process has it loaded. Undefined when the
 * folder cannot be found (another Copilot home, or a client that keeps none).
 */
export const isHeld = (sessionId: string): boolean | undefined => {
  let names: string[]
  try {
    names = readdirSync(join(copilotHome(), 'session-state', sessionId))
  } catch {
    return undefined
  }
  return names.some(name => {
    const pid = Number(name.match(/^inuse\.(\d+)\.hold$/)?.[1])
    return pid > 0 && pid !== process.pid && isAlive(pid)
  })
}

/** Whether a session may be given a turn now. */
export const canWake = (session: SessionInfo | undefined, cfg: Config, now: number): boolean => {
  if (!session || session.client !== 'copilot' || cfg.wake === 'off') return false
  if (!/^[\w-]+$/.test(session.sessionId)) return false
  // never start a turn on top of one; a "running" older than this is a session that died mid-turn
  if (session.turn === 'running' && now - session.lastSeen < RUNNING_STALE_MS) return false
  const held = isHeld(session.sessionId)
  if (held === true) return false
  // no folder to check: only a session that said it ended is surely not open
  if (held === undefined) return session.isEnded === true
  return true
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
