// Stands in for the copilot command in tests: records how it was started and
// the prompt it was given, and fails when the prompt says FAIL.
import { appendFileSync, readFileSync } from 'node:fs'

const stdin = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_COPILOT_LOG, `${JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin })}\n`)
process.exit(stdin.includes('FAIL') ? 3 : 0)
