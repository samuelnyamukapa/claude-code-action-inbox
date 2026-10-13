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
const env = { ...process.env, ACTION_INBOX_HOME: join(scratch, 'inbox'), PLUGIN_DATA: join(scratch, 'data'), ACTION_INBOX_NO_BROWSER: '1' }
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
const startServer = async capabilities => {
  const proc = spawn('node', [join(DIST, 'server.mjs')], { cwd: repo, env })
  let nextId = 1
  let buf = ''
  const pending = new Map()
  proc.stdout.on('data', chunk => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  const rpc = (method, params) =>
    new Promise(resolve => {
      const id = nextId++
      pending.set(id, resolve)
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.serverInfo.name, 'action-inbox')
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  return { rpc, call: async (name, args) => (await rpc('tools/call', { name, arguments: args })).result, kill: () => proc.kill() }
}

// a client that draws only text, and one that draws MCP Apps
let text
let apps
let rpc
let call

before(async () => {
  text = await startServer({})
  apps = await startServer({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } })
  rpc = text.rpc
  call = text.call
})

after(() => {
  text.kill()
  apps.kill()
})

describe('Copilot edition', () => {
  test('lists the same tools as the Claude Code plugin, plus inbox_command and inbox_view', async () => {
    const { result } = await rpc('tools/list', {})
    assert.deepEqual(
      result.tools.map(t => t.name),
      ['inbox_add', 'inbox_resolve', 'inbox_list', 'inbox_command', 'inbox_view'],
    )
    assert.equal(result.tools.find(t => t.name === 'inbox_view')._meta.ui.resourceUri, 'ui://action-inbox/inbox.html')
  })

  test('a client that draws MCP Apps also gets the app-only button tool and the view', async () => {
    const tools = (await apps.rpc('tools/list', {})).result.tools
    const button = tools.find(t => t.name === 'inbox_app_action')
    assert.deepEqual(button._meta.ui.visibility, ['app'])
    const read = (await apps.rpc('resources/read', { uri: 'ui://action-inbox/inbox.html' })).result
    assert.equal(read.contents[0].mimeType, 'text/html;profile=mcp-app')
    assert.match(read.contents[0].text, /ui\/initialize/)
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

  test('inbox_view returns the view data, a text list and a browser link', async () => {
    await call('inbox_add', { kind: 'decision', title: 'Pick a region', options: ['eu-west', 'us-east'], session: { id: SESSION, cwd: repo } })
    const res = await call('inbox_view', { session: { id: SESSION, cwd: repo } })
    assert.match(res.content[0].text, /\[decision\] Pick a region/)
    assert.match(res.content[0].text, /http:\/\/127\.0\.0\.1:\d+\/[\w-]+\//)
    const view = res.structuredContent
    assert.equal(view.view.projectKey, KEY)
    assert.ok(view.snapshot.projects[0].groups.some(g => g.items.some(i => i.title === 'Pick a region')))
  })

  test("the view's buttons act for the user and return the fresh view", async () => {
    const { structuredContent: before } = await apps.call('inbox_view', { session: { id: SESSION, cwd: repo } })
    const item = before.snapshot.projects[0].groups.flatMap(g => g.items).find(i => i.title === 'Pick a region')
    const after = (await apps.call('inbox_app_action', { action: 'pick', id: item.id, text: 'us-east', projectKey: KEY, session: { id: SESSION, cwd: repo } }))
      .structuredContent
    assert.equal(after.message, 'Chose "us-east".')
    const fb = after.snapshot.projects[0].groups.flatMap(g => g.items).find(i => i.id === item.id).feedback
    assert.deepEqual(fb.map(f => [f.text, f.isChoice]), [['us-east', true]])
    const bad = await apps.call('inbox_app_action', { action: 'pick', id: item.id, text: 'mars', projectKey: KEY, session: { id: SESSION, cwd: repo } })
    assert.equal(bad.structuredContent.message, 'That is not one of its options.')
  })

  test('the browser page answers only its own origin, behind its secret path', async () => {
    const { structuredContent } = await call('inbox_view', { session: { id: SESSION, cwd: repo } })
    const url = new URL(structuredContent.webUrl)
    const page = await fetch(url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /__INBOX_API__/)
    assert.equal((await fetch(new URL('/', url))).status, 404)
    assert.equal((await fetch(new URL('/wrong-token/', url))).status, 404)
    const api = new URL('api/act', url)
    const json = { 'Content-Type': 'application/json' }
    assert.equal((await fetch(api, { method: 'POST', body: '{"action":"refresh"}' })).status, 415)
    assert.equal((await fetch(api, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{"action":"refresh"}' })).status, 403)
    const ok = await fetch(api, { method: 'POST', headers: json, body: JSON.stringify({ action: 'refresh' }) })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).view.projectKey, KEY)
    // another name for 127.0.0.1 is refused (DNS rebinding)
    const rebound = await new Promise(resolve => {
      import('node:http').then(({ request }) => {
        const req = request(
          { host: '127.0.0.1', port: url.port, path: url.pathname, agent: false, headers: { Host: `evil.example:${url.port}`, Connection: 'close' } },
          res => {
            res.resume()
            resolve(res.statusCode)
          },
        )
        req.on('error', () => resolve(0))
        req.end()
      })
    })
    assert.equal(rebound, 403)
  })

  test('sessionEnd marks the session ended', () => {
    hook('sessionEnd', { reason: 'user_exit' })
    assert.equal(files('sessions').find(s => s.sessionId === SESSION).isEnded, true)
  })
})
