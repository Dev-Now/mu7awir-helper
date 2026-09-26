/**
 * In-process acceptance run.
 *
 * Launched by `npm run smoke`, which starts the real app against a throwaway user-data
 * directory, drives the renderer through `window.__mu7`, and asserts on both the DOM and
 * what actually landed on disk. Each milestone appends steps here, so the suite doubles as
 * a regression net for everything shipped so far.
 */
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import type { WorkspaceStore } from './store'
import type { Workspace } from '@shared/types'

interface Step {
  name: string
  run: () => Promise<void>
}

class SmokeError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError(message)
}

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new SmokeError(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function evaluate<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

function waitForLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoadingMainFrame()) return Promise.resolve()
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

/** Poll a renderer-side boolean expression until it holds, or fail with context. */
async function waitFor(win: BrowserWindow, expression: string, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      last = await evaluate<unknown>(win, `(() => { try { return ${expression} } catch (e) { return 'threw: ' + e.message } })()`)
      if (last === true) return
    } catch (err) {
      last = `evaluate failed: ${(err as Error).message}`
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new SmokeError(`timed out waiting for ${what} (last value: ${JSON.stringify(last)})`)
}

async function readWorkspaceFile(store: WorkspaceStore): Promise<Workspace> {
  return JSON.parse(await fs.readFile(store.file, 'utf8')) as Workspace
}

/** `document.querySelector` count for a test id, as a renderer expression. */
const count = (testId: string): string => `document.querySelectorAll('[data-testid="${testId}"]').length`

function buildSteps(win: BrowserWindow, store: WorkspaceStore): Step[] {
  return [
    {
      name: 'M0 renderer boots',
      run: async () => {
        await waitForLoad(win)
        await waitFor(win, `!!window.__mu7 && window.__mu7.ready === true`, 'the renderer test hook')
        await waitFor(win, `document.querySelectorAll('#root > *').length > 0`, 'React to mount')
      }
    },
    {
      name: 'M0 shell renders sidebar, both panes and the splitter',
      run: async () => {
        for (const id of ['sidebar', 'search-pane', 'draft-pane', 'splitter']) {
          assertEqual(await evaluate<number>(win, count(id)), 1, `expected exactly one ${id}`)
        }
      }
    },
    {
      name: 'M0 search pane sits above the draft pane, split near 2/3',
      run: async () => {
        const geometry = await evaluate<{ searchTop: number; draftTop: number; ratio: number }>(
          win,
          `(() => {
             const s = document.querySelector('[data-testid="search-pane"]').getBoundingClientRect()
             const d = document.querySelector('[data-testid="draft-pane"]').getBoundingClientRect()
             return { searchTop: s.top, draftTop: d.top, ratio: s.height / (s.height + d.height) }
           })()`
        )
        assert(geometry.draftTop > geometry.searchTop, 'draft pane must sit below the search pane')
        assert(
          Math.abs(geometry.ratio - 2 / 3) < 0.06,
          `split ratio should start near 2/3, got ${geometry.ratio.toFixed(3)}`
        )
      }
    },
    {
      name: 'M0 starts from an empty workspace',
      run: async () => {
        assertEqual(
          await evaluate<number>(win, `window.__mu7.getWorkspace().discussions.length`),
          0,
          'fresh user-data directory should have no discussions'
        )
      }
    },
    {
      name: 'M0 autosave writes the workspace to disk',
      run: async () => {
        await evaluate(win, `window.__mu7.actions.createDiscussion('حوار الإلحاد')`)
        await evaluate(win, `window.__mu7.flush()`)
        const saved = await readWorkspaceFile(store)
        assertEqual(saved.discussions.length, 1, 'one discussion should be persisted')
        assertEqual(saved.discussions[0].title, 'حوار الإلحاد', 'persisted title')
        assertEqual(saved.activeDiscussionId, saved.discussions[0].id, 'new discussion becomes active')
      }
    },
    {
      name: 'M0 a reload restores the saved workspace',
      run: async () => {
        win.reload()
        await waitForLoad(win)
        await waitFor(win, `!!window.__mu7 && window.__mu7.ready === true`, 'the renderer test hook after reload')
        await waitFor(
          win,
          `window.__mu7.getWorkspace().discussions.length === 1`,
          'the persisted discussion to come back'
        )
        assertEqual(
          await evaluate<string>(win, `window.__mu7.getWorkspace().discussions[0].title`),
          'حوار الإلحاد',
          'restored title'
        )
      }
    }
  ]
}

export async function runSmoke(win: BrowserWindow, store: WorkspaceStore): Promise<void> {
  const steps = buildSteps(win, store)
  let failed = false
  for (const step of steps) {
    try {
      await step.run()
      console.log(`SMOKE ok    ${step.name}`)
    } catch (err) {
      failed = true
      console.log(`SMOKE FAIL  ${step.name}: ${(err as Error).message}`)
      break
    }
  }
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASS')
  app.exit(failed ? 1 : 0)
}
