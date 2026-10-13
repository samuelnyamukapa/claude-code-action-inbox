// Opens the inbox page (served by daemon.ts) in the default browser, for when
// the user asks for it there; links shown in the chat open wherever the app
// opens links, such as the GitHub Copilot app's own browser panel.
import { spawn } from 'node:child_process'

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
