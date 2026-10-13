// The clickable inbox as a page in the user's browser, for clients that cannot
// show it in the chat. It listens on 127.0.0.1 only, behind a random path, and
// answers only same-origin JSON posts, so other sites cannot drive it.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

type Act = (body: Record<string, unknown>) => Promise<unknown>

let started: Promise<string> | undefined

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

/** Starts the page once per server process and returns its address. */
export const startWeb = (html: string, act: Act): Promise<string> => {
  if (started) return started
  started = new Promise((resolve, reject) => {
    const token = randomBytes(18).toString('base64url')
    let origin = ''
    const page = html.replace('<script>', `<script>window.__INBOX_API__ = ${JSON.stringify(`/${token}/api`)}</script>\n<script>`)

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const deny = (code: number, text: string) => {
        res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(text)
      }
      // another hostname pointing at 127.0.0.1 must not reach the inbox
      if (`http://${req.headers.host ?? ''}` !== origin) return deny(403, 'Forbidden')
      const url = req.url ?? '/'
      if (req.method === 'GET' && url === `/${token}/`) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        res.end(page)
        return
      }
      if (req.method === 'POST' && url === `/${token}/api/act`) {
        const from = req.headers.origin
        if (from !== undefined && from !== origin) return deny(403, 'Forbidden')
        // a JSON body cannot be sent cross-site without a preflight this server never answers
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return deny(415, 'Expected JSON')
        readBody(req)
          .then(async text => {
            const out = await act(JSON.parse(text) as Record<string, unknown>)
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(out))
          })
          .catch(err => deny(400, String((err as Error).message ?? err)))
        return
      }
      deny(404, 'Not found')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      origin = `http://127.0.0.1:${port}`
      server.unref()
      resolve(`${origin}/${token}/`)
    })
  })
  return started
}

/** Opens a URL in the default browser. */
export const openBrowser = (url: string) => {
  if (process.env.ACTION_INBOX_NO_BROWSER) return
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref()
  } catch {
    // no browser to open: the link is in the tool result
  }
}
