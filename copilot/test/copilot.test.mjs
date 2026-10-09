// End-to-end checks of the built Copilot edition: the MCP server, the hooks and
// the CLI, run as child processes against a throwaway inbox and git repository.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const scratch = mkdtempSync(join(tmpdir(), 'action-inbox-test-'))
const repo = join(scratch, 'repo')
const env = { ...process.env, ACTION_INBOX_HOME: join(scratch, 'inbox'), PLUGIN_DATA: join(scratch, 'data') }
const KEY = 'acme-widgets'
const SESSION = 'copilot-session-1'

execFileSync('git', ['init', '-q', repo])
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'])

const hook = (event, payload) => {
  const out = execFileSync('node', [join(DIST, 'hook.mjs'), event], {
    env,
    input: JSON.stringify({ sessionId: SESSION, cwd: repo, timestamp: Date.now(), ...payload }),
    encoding: 'utf8',
  })
  return out ? JSON.parse(out) : undefined
}

const cli = (...args) => execFileSync('node', [join(DIST, 'cli.mjs'), '--cwd', repo, ...args], { env, encoding: 'utf8' })

const files = sub => {
  const dir = join(env.ACTION_INBOX_HOME, KEY, sub)
  return readdirSync(dir).map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

// a minimal MCP client over stdio
let server
let nextId = 1
const pending = new Map()
const rpc = (method, params) =>
  new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result

before(async () => {
  server = spawn('node', [join(DIST, 'server.mjs')], { cwd: repo, env })
  let buf = ''
  server.stdout.on('data', chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.serverInfo.name, 'action-inbox')
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
})

after(() => server.kill())

describe('Copilot edition', () => {
  test('lists the same tools as the Claude Code plugin, plus inbox_command', async () => {
    const { result } = await rpc('tools/list', {})
    assert.deepEqual(
      result.tools.map(t => t.name),
      ['inbox_add', 'inbox_resolve', 'inbox_list', 'inbox_command'],
    )
  })

  test('sessionStart writes a heartbeat and injects the guide', () => {
    const out = hook('sessionStart', { source: 'new', initialPrompt: 'Ship the cache layer' })
    assert.match(out.additionalContext, /# Action Inbox/)
    const me = files('sessions').find(s => s.sessionId === SESSION)
    assert.equal(me.client, 'copilot')
    assert.equal(me.label, 'Ship the cache layer')
  })

  test('preToolUse names the session for inbox tools', () => {
    const out = hook('preToolUse', { toolName: 'action-inbox-inbox_add', toolArgs: { kind: 'action', title: 'x' } })
    assert.deepEqual(out.modifiedArgs.session, { id: SESSION, cwd: repo })
  })

  test('Claude-shaped callers (VS Code, Codex) get answers inside hookSpecificOutput only', () => {
    const run = (event, payload) => {
      const out = execFileSync('node', [join(DIST, 'hook.mjs'), event], {
        env,
        input: JSON.stringify({ session_id: 'codex-1', cwd: repo, hook_event_name: 'X', ...payload }),
        encoding: 'utf8',
      })
      return out ? JSON.parse(out) : undefined
    }
    const start = run('sessionStart', {})
    assert.deepEqual(Object.keys(start), ['hookSpecificOutput'])
    assert.match(start.hookSpecificOutput.additionalContext, /# Action Inbox/)
    // no input rewrite without a permission grant
    assert.equal(run('preToolUse', { tool_name: 'mcp__action_inbox__inbox_add', tool_input: { kind: 'action', title: 'x' } }), undefined)
    // a reply reaches an idle session with the next prompt
    const added = execFileSync('node', [join(DIST, 'cli.mjs'), '--cwd', repo, 'add', 'Rotate the staging key'], { env, encoding: 'utf8' })
    assert.match(added, /Added/)
    const item = files('items').find(i => i.title === 'Rotate the staging key')
    execFileSync('node', [join(DIST, 'hook.mjs'), 'postToolUse'], {
      env,
      input: JSON.stringify({ session_id: 'codex-1', cwd: repo, tool_name: 'mcp__action_inbox__inbox_add', tool_input: {}, tool_response: `Logged inbox item ${item.id}.` }),
    })
    const n = cli('list').match(/#(\d+) \[action\] Rotate the staging key/)[1]
    cli('reply', n, 'done it already')
    const prompt = run('userPromptSubmitted', { prompt: 'carry on' })
    assert.match(prompt.hookSpecificOutput.additionalContext, /Their reply: done it already/)
    cli('dismiss', n)
  })

  test('inbox_add files the item under the session it is told about, in the repo project', async () => {
    const res = await call('inbox_add', {
      kind: 'decision',
      title: 'Pick a cache TTL',
      options: ['5 min', '1 hour'],
      session: { id: SESSION, cwd: repo },
    })
    const id = res.content[0].text.match(/ib_[a-z0-9]+/)[0]
    const item = files('items').find(i => i.id === id)
    assert.equal(item.sessionId, SESSION)
    assert.equal(item.kind, 'decision')
  })

  test('without the hook, postToolUse claims the item for the session', async () => {
    const res = await call('inbox_add', { kind: 'action', title: 'Set the API secret in the portal' })
    const text = res.content[0].text
    const id = text.match(/ib_[a-z0-9]+/)[0]
    assert.notEqual(files('items').find(i => i.id === id).sessionId, SESSION)
    hook('postToolUse', { toolName: 'action-inbox-inbox_add', toolArgs: {}, toolResult: { resultType: 'success', textResultForLlm: text } })
    assert.ok(files('events').some(e => e.type === 'claim' && e.itemId === id && e.by === SESSION))
  })

  test('a reply from the terminal reaches the session at its next tool call, once', () => {
    const n = cli('list').match(/#(\d+) \[decision\] Pick a cache TTL/)[1]
    assert.match(cli('pick', n, '2'), /Chose "1 hour"/)
    const out = hook('postToolUse', { toolName: 'view', toolArgs: { path: 'x' }, toolResult: { textResultForLlm: '' } })
    assert.match(out.additionalContext, /\[Action Inbox\][\s\S]*They chose: 1 hour/)
    assert.equal(hook('postToolUse', { toolName: 'view', toolArgs: {}, toolResult: { textResultForLlm: '' } }), undefined)
  })

  test('a reply that lands while the agent works starts another turn at agentStop', () => {
    const n = cli('list').match(/#(\d+) \[decision\] Pick a cache TTL/)[1]
    cli('reply', n, 'actually make it 10 min')
    const out = hook('agentStop', { stopReason: 'end_turn' })
    assert.equal(out.decision, 'block')
    assert.match(out.reason, /Their reply: actually make it 10 min/)
    assert.equal(hook('agentStop', { stopReason: 'end_turn' }), undefined)
  })

  test('ask_user shows as waiting while the question is open', () => {
    hook('preToolUse', { toolName: 'ask_user', toolArgs: { question: 'Which region?' } })
    assert.match(cli('list'), /\[BLOCKING\] \[waiting\] Waiting on your answer: Which region\?/)
    hook('postToolUse', { toolName: 'ask_user', toolArgs: {}, toolResult: { textResultForLlm: 'eu-west' } })
    assert.doesNotMatch(cli('list'), /Which region/)
  })

  test('gh pr create adds a merge item; gh pr merge closes it', () => {
    hook('postToolUse', {
      toolName: 'powershell',
      toolArgs: { command: 'gh pr create --fill' },
      toolResult: { textResultForLlm: 'https://github.com/acme/widgets/pull/42\n' },
    })
    assert.match(cli('list'), /\[merge\] Review & merge PR #42/)
    hook('postToolUse', { toolName: 'bash', toolArgs: { command: 'gh pr merge 42 --squash' }, toolResult: { textResultForLlm: 'merged' } })
    assert.doesNotMatch(cli('list'), /PR #42/)
  })

  test('inbox_resolve and inbox_command work for the session', async () => {
    const listed = (await call('inbox_list', { session: { id: SESSION, cwd: repo } })).content[0].text
    const id = listed.match(/ib_[a-z0-9]+/)[0]
    assert.match((await call('inbox_resolve', { id, status: 'done', note: '10 min', session: { id: SESSION, cwd: repo } })).content[0].text, /marked done/)
    assert.match((await call('inbox_command', { args: 'add Call the accountant', session: { id: SESSION, cwd: repo } })).content[0].text, /Added/)
  })

  test('sessionEnd marks the session ended', () => {
    hook('sessionEnd', { reason: 'user_exit' })
    assert.equal(files('sessions').find(s => s.sessionId === SESSION).isEnded, true)
  })
})
