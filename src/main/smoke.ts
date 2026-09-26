/**
 * In-process acceptance run.
 *
 * Launched by `npm run smoke`, which starts the real app against a throwaway user-data
 * directory, drives the renderer through its own DOM, and asserts on both what is on
 * screen and what actually landed on disk. Each milestone appends a block of steps, so the
 * suite doubles as a regression net for everything shipped so far.
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
    throw new SmokeError(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

// ── renderer driving ─────────────────────────────────────────────────────────

function evaluate<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function waitForLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoadingMainFrame()) return Promise.resolve()
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve()))
}

/** Poll a renderer-side boolean expression until it holds, or fail with the last value seen. */
async function waitFor(
  win: BrowserWindow,
  expression: string,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      last = await evaluate<unknown>(
        win,
        `(() => { try { return ${expression} } catch (e) { return 'threw: ' + e.message } })()`
      )
      if (last === true) return
    } catch (err) {
      last = `evaluate failed: ${(err as Error).message}`
    }
    await sleep(100)
  }
  throw new SmokeError(`timed out waiting for ${what} (last value: ${JSON.stringify(last)})`)
}

const sel = (testId: string): string => `[data-testid="${testId}"]`
const count = (testId: string): string => `document.querySelectorAll('${sel(testId)}').length`

/** Click the nth element with a test id and let React flush. */
async function click(win: BrowserWindow, testId: string, index = 0): Promise<void> {
  await evaluate(
    win,
    `(() => {
       const els = document.querySelectorAll('${sel(testId)}')
       const el = els[${index}]
       if (!el) throw new Error('no ${testId} at index ${index} (found ' + els.length + ')')
       el.click()
     })()`
  )
  await sleep(60)
}

/** Type into the visible inline-rename input the way React's controlled input expects. */
async function typeInlineEdit(win: BrowserWindow, text: string, key = 'Enter'): Promise<void> {
  await evaluate(
    win,
    `(() => {
       const input = document.querySelector('input.inline-edit')
       if (!input) throw new Error('no inline editor is open')
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
       setter.call(input, ${JSON.stringify(text)})
       input.dispatchEvent(new Event('input', { bubbles: true }))
       input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))
     })()`
  )
  await sleep(60)
}

/** Drag the splitter to an absolute y position with real pointer events. */
async function dragSplitterTo(win: BrowserWindow, clientY: number): Promise<void> {
  await evaluate(
    win,
    `(() => {
       const el = document.querySelector('${sel('splitter')}')
       const box = el.getBoundingClientRect()
       const opts = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
       el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientY: box.top, clientX: box.left + 10 }))
     })()`
  )
  await sleep(60)
  await evaluate(
    win,
    `(() => {
       const el = document.querySelector('${sel('splitter')}')
       const opts = { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
       el.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientY: ${clientY}, clientX: 40 }))
       el.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientY: ${clientY}, clientX: 40 }))
     })()`
  )
  await sleep(80)
}

function paneHeights(win: BrowserWindow): Promise<{ search: number; draft: number; ratio: number }> {
  return evaluate(
    win,
    `(() => {
       const s = document.querySelector('${sel('search-pane')}').getBoundingClientRect()
       const d = document.querySelector('${sel('draft-pane')}').getBoundingClientRect()
       return { search: s.height, draft: d.height, ratio: s.height / (s.height + d.height) }
     })()`
  )
}

async function readWorkspaceFile(store: WorkspaceStore): Promise<Workspace> {
  return JSON.parse(await fs.readFile(store.file, 'utf8')) as Workspace
}

const flush = (win: BrowserWindow): Promise<void> => evaluate(win, `window.__mu7.flush()`)

// ── steps ────────────────────────────────────────────────────────────────────

function m0Steps(win: BrowserWindow, store: WorkspaceStore): Step[] {
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
        const g = await evaluate<{ searchTop: number; draftTop: number; ratio: number }>(
          win,
          `(() => {
             const s = document.querySelector('${sel('search-pane')}').getBoundingClientRect()
             const d = document.querySelector('${sel('draft-pane')}').getBoundingClientRect()
             return { searchTop: s.top, draftTop: d.top, ratio: s.height / (s.height + d.height) }
           })()`
        )
        assert(g.draftTop > g.searchTop, 'draft pane must sit below the search pane')
        assert(
          Math.abs(g.ratio - 2 / 3) < 0.06,
          `split ratio should start near 2/3, got ${g.ratio.toFixed(3)}`
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
        await flush(win)
        const saved = await readWorkspaceFile(store)
        assertEqual(saved.discussions.length, 1, 'one discussion should be persisted')
        assertEqual(saved.discussions[0].title, 'حوار الإلحاد', 'persisted title')
        assertEqual(saved.activeDiscussionId, saved.discussions[0].id, 'new discussion is active')
      }
    },
    {
      name: 'M0 a reload restores the saved workspace',
      run: async () => {
        win.reload()
        await waitForLoad(win)
        await waitFor(win, `!!window.__mu7 && window.__mu7.ready === true`, 'the hook after reload')
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

function m1Steps(win: BrowserWindow, store: WorkspaceStore): Step[] {
  return [
    {
      name: 'M1 the restored discussion renders as a row',
      run: async () => {
        assertEqual(await evaluate<number>(win, count('discussion')), 1, 'one discussion row')
        assertEqual(
          await evaluate<number>(win, `document.querySelectorAll('${sel('discussion')}[data-active]').length`),
          1,
          'the restored discussion should be selected'
        )
      }
    },
    {
      name: 'M1 the + button adds a discussion and opens the rename editor',
      run: async () => {
        await click(win, 'new-discussion')
        assertEqual(await evaluate<number>(win, count('discussion')), 2, 'two discussion rows')
        assertEqual(
          await evaluate<number>(win, `document.querySelectorAll('input.inline-edit').length`),
          1,
          'the new discussion should open its rename editor'
        )
        await typeInlineEdit(win, 'حوار النصرانية')
        assertEqual(
          await evaluate<string>(win, `window.__mu7.getWorkspace().discussions[1].title`),
          'حوار النصرانية',
          'renamed title'
        )
      }
    },
    {
      name: 'M1 Escape abandons a rename',
      run: async () => {
        // The rename handler lives on the title span, not the row.
        await evaluate(
          win,
          `document
             .querySelectorAll('${sel('discussion')}')[1]
             .querySelector('.discussion__title')
             .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
        )
        await sleep(60)
        await typeInlineEdit(win, 'يجب تجاهل هذا', 'Escape')
        assertEqual(
          await evaluate<string>(win, `window.__mu7.getWorkspace().discussions[1].title`),
          'حوار النصرانية',
          'title after Escape'
        )
      }
    },
    {
      name: 'M1 tab bars add search and draft tabs independently',
      run: async () => {
        await click(win, 'new-search-tab')
        await click(win, 'new-search-tab')
        await click(win, 'new-draft-tab')
        assertEqual(await evaluate<number>(win, count('search-tab')), 2, 'two search tabs')
        assertEqual(await evaluate<number>(win, count('draft-tab')), 1, 'one draft tab')

        // Selecting the first search tab must not disturb the active draft.
        const draftBefore = await evaluate<string>(
          win,
          `window.__mu7.getWorkspace().discussions[1].activeDraftTabId`
        )
        await click(win, 'search-tab', 0)
        assertEqual(
          await evaluate<number>(win, `document.querySelectorAll('${sel('search-tab')}[data-active]').length`),
          1,
          'exactly one active search tab'
        )
        assertEqual(
          await evaluate<string>(win, `window.__mu7.getWorkspace().discussions[1].activeDraftTabId`),
          draftBefore,
          'the active draft should be untouched by a search-tab click'
        )
      }
    },
    {
      name: 'M1 closing the active tab moves focus to a neighbour',
      run: async () => {
        await click(win, 'search-tab-close', 0) // closes the active first tab
        assertEqual(await evaluate<number>(win, count('search-tab')), 1, 'one search tab left')
        assertEqual(
          await evaluate<number>(win, `document.querySelectorAll('${sel('search-tab')}[data-active]').length`),
          1,
          'focus should move to the surviving tab'
        )
      }
    },
    {
      name: 'M1 tabs belong to their own discussion',
      run: async () => {
        await click(win, 'discussion', 0)
        assertEqual(await evaluate<number>(win, count('search-tab')), 0, 'first discussion has no tabs')
        await click(win, 'discussion', 1)
        assertEqual(await evaluate<number>(win, count('search-tab')), 1, 'tabs come back on return')
      }
    },
    {
      name: 'M1 dragging the splitter resizes the panes and persists the ratio',
      run: async () => {
        const before = await paneHeights(win)
        await dragSplitterTo(win, 300)
        const after = await paneHeights(win)
        assert(
          after.search < before.search - 40,
          `search pane should shrink (before ${before.search.toFixed(0)}, after ${after.search.toFixed(0)})`
        )
        assert(after.draft > before.draft + 40, 'draft pane should grow by what search lost')

        await flush(win)
        const saved = await readWorkspaceFile(store)
        assert(
          Math.abs(saved.settings.splitRatio - after.ratio) < 0.02,
          `persisted ratio ${saved.settings.splitRatio} should match the on-screen ${after.ratio.toFixed(3)}`
        )
      }
    },
    {
      name: 'M1 the splitter will not collapse a pane below its minimum',
      run: async () => {
        await dragSplitterTo(win, -500) // far above the window
        const top = await paneHeights(win)
        assert(top.search >= 120, `search pane floor, got ${top.search.toFixed(0)}px`)

        await dragSplitterTo(win, 5000) // far below the window
        const bottom = await paneHeights(win)
        assert(bottom.draft >= 120, `draft pane floor, got ${bottom.draft.toFixed(0)}px`)

        await evaluate(win, `window.__mu7.actions.updateSettings({ splitRatio: 2 / 3 })`)
        await sleep(60)
      }
    },
    {
      name: 'M1 archiving hides a discussion and reselects a visible one',
      run: async () => {
        await click(win, 'discussion', 1)
        await click(win, 'archive-discussion', 1)
        assertEqual(await evaluate<number>(win, count('discussion')), 1, 'archived row is hidden')
        assertEqual(
          await evaluate<number>(win, `document.querySelectorAll('${sel('discussion')}[data-active]').length`),
          1,
          'selection should move to a still-visible discussion'
        )

        await click(win, 'toggle-archived')
        assertEqual(await evaluate<number>(win, count('discussion')), 2, 'archived row shown again')

        // Unarchive and hide again. The toggle disappears once nothing is archived, so
        // the filter is reset through the store rather than by clicking a gone button.
        await click(win, 'archive-discussion', 1)
        assertEqual(await evaluate<number>(win, count('toggle-archived')), 0, 'toggle hides when nothing is archived')
        await evaluate(win, `window.__mu7.actions.updateSettings({ showArchived: false })`)
        await sleep(60)
        assertEqual(await evaluate<number>(win, count('discussion')), 2, 'both discussions visible again')
      }
    },
    {
      name: 'M1 delete asks for confirmation first',
      run: async () => {
        await click(win, 'delete-discussion', 1)
        assertEqual(await evaluate<number>(win, count('discussion')), 2, 'nothing deleted yet')
        assertEqual(await evaluate<number>(win, count('confirm-delete')), 1, 'confirmation shown')

        await click(win, 'confirm-delete')
        assertEqual(await evaluate<number>(win, count('discussion')), 1, 'row removed after confirming')

        await flush(win)
        assertEqual(
          (await readWorkspaceFile(store)).discussions.length,
          1,
          'the delete should be persisted'
        )
      }
    }
  ]
}

/** Capture the final window state when MU7_SMOKE_SHOT names a path — handy for eyeballing UI work. */
async function capture(win: BrowserWindow): Promise<void> {
  const target = process.env.MU7_SMOKE_SHOT
  if (!target) return
  try {
    const image = await win.webContents.capturePage()
    await fs.writeFile(target, image.toPNG())
    console.log(`SMOKE shot  ${target}`)
  } catch (err) {
    console.log(`SMOKE shot failed: ${(err as Error).message}`)
  }
}

export async function runSmoke(win: BrowserWindow, store: WorkspaceStore): Promise<void> {
  const steps = [...m0Steps(win, store), ...m1Steps(win, store)]
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
  await capture(win)
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASS')
  app.exit(failed ? 1 : 0)
}
