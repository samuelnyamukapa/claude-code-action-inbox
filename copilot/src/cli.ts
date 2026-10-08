// The inbox from a terminal, for clients with no pane:
//   node cli.mjs [--cwd <dir>] [list | reply <n> <text> | pick <n> <option> | done <n> | dismiss <n> | issue <n> | add <text>]
import { heartbeat, loadProject, locate, runCommand, saveProjectMeta } from './inbox'

const VIEWER = 'terminal'

const argv = process.argv.slice(2)
let cwd = process.cwd()
const at = argv.indexOf('--cwd')
if (at >= 0) {
  cwd = argv[at + 1] ?? cwd
  argv.splice(at, 2)
}

const where = locate(cwd)
saveProjectMeta(where)
const project = loadProject(where)
const args = argv.join(' ')
// items you add here are filed under a "terminal" group
if (/^add\b/i.test(args.trim())) heartbeat(project, { sessionId: VIEWER, label: 'added from the terminal' })
process.stdout.write(`Action Inbox · ${where.name}\n${runCommand(project, VIEWER, args)}\n`)
