// One entry point for every Copilot hook: `node hook.mjs <event>` with the
// event's JSON on stdin. A hook must never break the agent, so every failure
// ends quietly with exit code 0.
import { appendFileSync, readFileSync } from 'node:fs'

import { clip, isPrCreate, parseMergeTarget, parsePrUrl } from '../../hooks/model'
import {
  addEvent,
  addItem,
  GUIDE,
  heartbeat,
  loadProject,
  locate,
  openOwnedBy,
  recallWhere,
  rememberWhere,
  saveProjectMeta,
  setStatus,
  takePending,
  viewOf,
} from './inbox'

const INBOX_TOOL = /inbox_(add|resolve|list|command)$/
const SHELL_TOOL = /^(bash|powershell|shell|run_in_terminal|runInTerminal)$/i
const ASK_TOOL = /^(ask_user|AskUserQuestion)$/i
const WAITING = 'Waiting on your answer: '

type Payload = {
  sessionId: string
  cwd: string
  toolName: string
  toolArgs: Record<string, unknown>
  resultText: string
  prompt?: string
  /** Claude-shaped callers (VS Code, Codex) want answers inside hookSpecificOutput. */
  isClaudeShape: boolean
}

const parseMaybe = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return parseMaybe(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const v = value as Record<string, unknown>
  if (typeof v.textResultForLlm === 'string') return v.textResultForLlm
  return JSON.stringify(value)
}

/** Copilot CLI sends camelCase; Claude-compatible callers (VS Code, Codex) send snake_case. */
const normalise = (raw: Record<string, unknown>): Payload => ({
  sessionId: String(raw.sessionId ?? raw.session_id ?? ''),
  cwd: String(raw.cwd ?? process.cwd()),
  toolName: String(raw.toolName ?? raw.tool_name ?? ''),
  toolArgs: parseMaybe(raw.toolArgs ?? raw.tool_input),
  resultText: textOf(raw.toolResult ?? raw.tool_response),
  prompt: typeof (raw.initialPrompt ?? raw.prompt) === 'string' ? String(raw.initialPrompt ?? raw.prompt) : undefined,
  isClaudeShape: raw.sessionId === undefined && (raw.session_id !== undefined || raw.hook_event_name !== undefined),
})

// each caller rejects the other's answer shape, so answer in the caller's own
const contextOut = (p: Payload, event: string, lines: string[]) => {
  if (lines.length === 0) return undefined
  const additionalContext = lines.join('\n\n')
  return p.isClaudeShape ? { hookSpecificOutput: { hookEventName: event, additionalContext } } : { additionalContext }
}

const closeWaiting = (project: ReturnType<typeof loadProject>, sessionId: string, status: 'done' | 'dismissed', note: string) => {
  for (const item of openOwnedBy(project, sessionId)) {
    if (item.kind === 'waiting') setStatus(project, sessionId, item.id, status, 'auto', note)
  }
}

const handle = (event: string, p: Payload): unknown => {
  if (!p.sessionId) return undefined

  if (event === 'sessionStart') {
    const where = locate(p.cwd)
    rememberWhere(p.sessionId, where)
    saveProjectMeta(where)
    const project = loadProject(where)
    heartbeat(project, { sessionId: p.sessionId, branch: where.branch, cwd: p.cwd, client: 'copilot', label: p.prompt && clip(p.prompt, 60) })
    // a "waiting" item outlives its question only when the process died mid-question
    closeWaiting(project, p.sessionId, 'dismissed', 'session restarted')
    const { replies, notes } = takePending(project, p.sessionId)
    return contextOut(p, 'SessionStart', [GUIDE, ...notes, ...replies])
  }

  const where = recallWhere(p.sessionId, p.cwd)
  const project = loadProject(where)
  const beat = (isEnded?: boolean) =>
    heartbeat(project, { sessionId: p.sessionId, branch: where.branch, cwd: p.cwd, client: 'copilot', isEnded })

  if (event === 'userPromptSubmitted') {
    if (p.prompt && !p.prompt.startsWith('[Action Inbox]')) {
      heartbeat(project, { sessionId: p.sessionId, branch: where.branch, cwd: p.cwd, client: 'copilot', label: clip(p.prompt, 60) })
    }
    // Copilot CLI drops this hook's output; Claude-shaped callers take context here,
    // which is how a reply reaches an idle session with the user's next prompt
    if (!p.isClaudeShape) return undefined
    const { replies, notes } = takePending(project, p.sessionId)
    return contextOut(p, 'UserPromptSubmit', [...notes, ...replies])
  }

  if (event === 'preToolUse') {
    if (INBOX_TOOL.test(p.toolName)) {
      // tell the inbox server which session is calling, so items are filed under it
      const modifiedArgs = { ...p.toolArgs, session: { id: p.sessionId, cwd: p.cwd } }
      // Claude-shaped callers accept new input only alongside a permission grant,
      // which is not this hook's to give: postToolUse claims the item instead
      return p.isClaudeShape ? undefined : { modifiedArgs }
    }
    if (ASK_TOOL.test(p.toolName)) {
      const question = p.toolArgs.question ?? (p.toolArgs.questions as { question?: string }[] | undefined)?.[0]?.question
      addItem(project, p.sessionId, {
        kind: 'waiting',
        title: `${WAITING}${clip(typeof question === 'string' ? question : 'a question', 110)}`,
        source: 'auto',
        blocking: true,
      })
    }
    return undefined
  }

  if (event === 'postToolUse') {
    beat()
    if (/inbox_add$/.test(p.toolName)) {
      // when the server could not be told the session, claim the item now
      const id = p.resultText.match(/\bib_[a-z0-9]+\b/)?.[0]
      const view = id ? viewOf(project, id) : undefined
      if (view && view.owner !== p.sessionId) addEvent(project, p.sessionId, { type: 'claim', itemId: view.id })
    }
    if (ASK_TOOL.test(p.toolName)) closeWaiting(project, p.sessionId, 'done', 'answered in the session')
    const command = typeof p.toolArgs.command === 'string' ? p.toolArgs.command : ''
    if (SHELL_TOOL.test(p.toolName) && command) {
      if (isPrCreate(command)) {
        const pr = parsePrUrl(p.resultText)
        const isKnown = pr && project.items.some(i => i.pr?.number === pr.number && i.pr?.repo === pr.repo)
        if (pr && !isKnown) {
          addItem(project, p.sessionId, {
            kind: 'merge',
            title: `Review & merge PR #${pr.number}`,
            link: pr.url,
            pr: { repo: pr.repo, number: pr.number },
            source: 'auto',
          })
        }
      }
      const merged = parseMergeTarget(command)
      if (merged && !/--auto\b/.test(command)) {
        for (const item of project.items) {
          const view = viewOf(project, item.id)
          const isTarget = view?.pr?.number === merged.number && (!merged.repo || view.pr.repo === merged.repo)
          if (view && isTarget && view.status === 'open') setStatus(project, p.sessionId, view.id, 'done', 'auto', 'merged with gh pr merge')
        }
      }
    }
    // the user's answers reach a working session at its next step
    const { replies, notes } = takePending(project, p.sessionId)
    return contextOut(p, 'PostToolUse', [...notes, ...replies])
  }

  if (event === 'agentStop') {
    beat()
    // an answer that arrived while the agent worked starts one more turn
    const { replies, notes } = takePending(project, p.sessionId, { onlyIfReplies: true })
    return replies.length ? { decision: 'block', reason: [...notes, ...replies].join('\n\n') } : undefined
  }

  if (event === 'sessionEnd') {
    closeWaiting(project, p.sessionId, 'dismissed', 'session ended')
    beat(true)
  }
  return undefined
}

// ACTION_INBOX_DEBUG=<file> appends each call, its payload and its answer to that file
const trace = (entry: Record<string, unknown>) => {
  const file = process.env.ACTION_INBOX_DEBUG
  if (file) appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

const event = process.argv[2] ?? ''
let raw: Record<string, unknown> = {}
try {
  raw = parseMaybe(readFileSync(0, 'utf8'))
  const out = handle(event, normalise(raw))
  trace({ event, raw, out })
  if (out) process.stdout.write(JSON.stringify(out))
} catch (err) {
  try {
    trace({ event, raw, error: String((err as Error).stack ?? err) })
  } catch {
    // tracing is best effort
  }
}
process.exitCode = 0
