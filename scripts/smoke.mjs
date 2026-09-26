/**
 * Launches the built app against a throwaway user-data directory and reports whether the
 * in-process acceptance run (src/main/smoke.ts) passed. This is the "does it actually run"
 * gate that unit tests cannot give us.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const userData = mkdtempSync(path.join(tmpdir(), 'mu7awir-smoke-'))
const TIMEOUT_MS = 90_000

const child = spawn(electron, ['.', `--user-data-dir=${userData}`], {
  cwd: root,
  env: { ...process.env, MU7_SMOKE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let output = ''
const relay = (chunk) => {
  const text = chunk.toString()
  output += text
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) console.log(line)
  }
}
child.stdout.on('data', relay)
child.stderr.on('data', relay)

const timer = setTimeout(() => {
  console.error(`\nsmoke: timed out after ${TIMEOUT_MS / 1000}s`)
  child.kill('SIGKILL')
}, TIMEOUT_MS)

child.on('exit', (code) => {
  clearTimeout(timer)
  rmSync(userData, { recursive: true, force: true })
  const passed = output.includes('SMOKE PASS') && code === 0
  console.log(passed ? '\nsmoke: PASS' : `\nsmoke: FAIL (exit ${code})`)
  process.exit(passed ? 0 : 1)
})
