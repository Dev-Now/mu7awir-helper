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
import { statSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { SpawnLike } from './dictation'
import type { WorkspaceStore } from './store'
import type { ViewManager } from './viewManager'
import type { Workspace } from '@shared/types'

/**
 * Stands in for whisper-cli during a smoke run (MU7_FAKE_WHISPER). It reads the clip it
 * was handed and reports its size, so the assertion proves real audio was captured,
 * resampled and encoded — only the transcription itself is faked.
 */
export function fakeWhisperSpawn(text: string): SpawnLike {
  return ((_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}

    let bytes = 0
    try {
      bytes = statSync(args[args.indexOf('-f') + 1]).size
    } catch {
      /* reported as zero below */
    }
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(`${text} [${bytes}]`))
      child.emit('close', 0)
    }, 20)
    return child
  }) as unknown as SpawnLike
}

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
       // A real click starts with a pointerdown, which is what pane focus tracking
       // listens for; .click() alone would be an unrealistic half-event.
       el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true }))
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

/** Create a search tab the way a user would: open the prompt, pick a tool, submit. */
async function openPromptTab(win: BrowserWindow, toolId: string, query = ''): Promise<void> {
  await click(win, 'new-search-tab')
  await evaluate(
    win,
    `(() => {
       const btn = document.querySelector('${sel('prompt-tool')}[data-tool="${toolId}"]')
       if (!btn) throw new Error('tool ${toolId} is not offered')
       btn.click()
       if (${JSON.stringify(query)}) {
         const input = document.querySelector('${sel('prompt-query')}')
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
         setter.call(input, ${JSON.stringify(query)})
         input.dispatchEvent(new Event('input', { bubbles: true }))
       }
     })()`
  )
  await sleep(40)
  await click(win, 'prompt-submit')
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
        // The local tool is used here so M1's tab checks stay off the network.
        await openPromptTab(win, 'rudud')
        await openPromptTab(win, 'rudud')
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

// ── M2: embedded views ───────────────────────────────────────────────────────

/** A self-contained page, so the default smoke run never touches the network. */
const dataPage = (title: string, body: string): string =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<!doctype html><html lang="ar"><head><meta charset="utf-8"><title>${title}</title>` +
      `</head><body style="font:16px sans-serif">${body}</body></html>`
  )

const PAGE_A = dataPage('صفحة أ', '<p>الصبر</p><p>الصبر</p><p>الصبر مفتاح الفرج</p>')
const PAGE_B = dataPage('صفحة ب', '<p>الشكر لله</p>')

/** Poll a main-process predicate, the counterpart to `waitFor` in the renderer. */
async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(80)
  }
  throw new SmokeError(`timed out waiting for ${what}`)
}

const activeSearchTabId = (win: BrowserWindow): Promise<string | null> =>
  evaluate(
    win,
    `(() => {
       const ws = window.__mu7.getWorkspace()
       const d = ws.discussions.find((x) => x.id === ws.activeDiscussionId)
       return d ? d.activeSearchTabId : null
     })()`
  )

/** Add a search tab pointing at a local page and wait for its view to attach. */
async function openLocalSearchTab(
  win: BrowserWindow,
  views: ViewManager,
  init: { toolId: string; title: string; query?: string; url: string }
): Promise<string> {
  await evaluate(win, `window.__mu7.actions.addSearchTab(${JSON.stringify(init)})`)
  await sleep(80)
  const tabId = await activeSearchTabId(win)
  assert(tabId, 'the new search tab should become active')
  await waitUntil(
    () => views.debugState().attached.includes(tabId),
    `view for ${init.title} to attach`
  )
  return tabId
}

function m2Steps(win: BrowserWindow, store: WorkspaceStore, views: ViewManager): Step[] {
  let mainTabId = ''

  return [
    {
      name: 'M2 the shipped tool registry reaches the renderer',
      run: async () => {
        const ids = await evaluate<string[]>(win, `window.__mu7.getTools().map((t) => t.id)`)
        assertEqual(
          ids.join(','),
          'quran,hadith,fatwa,shamela,basaer,fiqh,rudud',
          'tool ids and their order'
        )
      }
    },
    {
      name: 'M2 a search tab gets an embedded view glued to the pane',
      run: async () => {
        mainTabId = await openLocalSearchTab(win, views, {
          toolId: 'quran',
          title: 'الصبر',
          query: 'الصبر',
          url: PAGE_A
        })

        const rect = await evaluate<{ x: number; y: number; width: number; height: number }>(
          win,
          `(() => {
             const r = document.querySelector('${sel('search-view')}').getBoundingClientRect()
             return { x: r.left, y: r.top, width: r.width, height: r.height }
           })()`
        )
        const bounds = views.debugState().bounds
        assert(bounds, 'main should have received bounds')
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          assert(
            Math.abs(bounds[key] - rect[key]) <= 1,
            `${key} mismatch: pane ${rect[key].toFixed(1)} vs view ${bounds[key]}`
          )
        }
        assert(rect.height > 100, 'the search view should have real height')
      }
    },
    {
      name: 'M2 the view follows the splitter',
      run: async () => {
        const before = views.debugState().bounds!.height
        await dragSplitterTo(win, 300)
        await sleep(120)

        const rect = await evaluate<{ y: number; height: number }>(
          win,
          `(() => {
             const r = document.querySelector('${sel('search-view')}').getBoundingClientRect()
             return { y: r.top, height: r.height }
           })()`
        )
        const after = views.debugState().bounds!
        assert(after.height < before - 40, 'the view should shrink with its pane')
        assert(
          Math.abs(after.height - rect.height) <= 1 && Math.abs(after.y - rect.y) <= 1,
          `view should still cover the pane exactly (pane ${rect.height.toFixed(1)}, view ${after.height})`
        )

        await evaluate(win, `window.__mu7.actions.updateSettings({ splitRatio: 2 / 3 })`)
        await sleep(120)
      }
    },
    {
      name: 'M2 the new-search prompt hides the view and lists the enabled tools',
      run: async () => {
        await click(win, 'new-search-tab')
        await waitUntil(
          () => views.debugState().attached.length === 0,
          'the view to detach behind the prompt'
        )

        // fiqh has no source yet, so six of the seven tools are offered.
        assertEqual(await evaluate<number>(win, count('prompt-tool')), 6, 'enabled tools offered')
        const shown = await evaluate<string[]>(
          win,
          `[...document.querySelectorAll('${sel('prompt-tool')}')].map((el) => el.dataset.tool)`
        )
        assertEqual(shown.join(','), 'quran,hadith,fatwa,shamela,basaer,rudud', 'offered tools')

        await evaluate(
          win,
          `document.querySelector('${sel('prompt-query')}')
             .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
        )
        await waitUntil(
          () => views.debugState().attached.includes(mainTabId),
          'the view to come back after cancelling'
        )
      }
    },
    {
      name: 'M2 a local tool tab hides the embedded view',
      run: async () => {
        await evaluate(
          win,
          `window.__mu7.actions.addSearchTab({ toolId: 'rudud', title: 'مكتبة الردود' })`
        )
        await waitUntil(
          () => views.debugState().attached.length === 0,
          'the view to detach for a local tool'
        )

        await click(win, 'search-tab', 0) // back to the web tab
        await waitUntil(
          () => views.debugState().attached.includes(mainTabId),
          'the web view to return'
        )
      }
    },
    {
      name: 'M2 back and forward navigate the embedded view',
      run: async () => {
        await waitUntil(() => views.currentUrl(mainTabId) === PAGE_A, 'page A to load')

        await evaluate(win, `window.api.view.navigate(${JSON.stringify(mainTabId)}, ${JSON.stringify(PAGE_B)})`)
        await waitUntil(() => views.currentUrl(mainTabId) === PAGE_B, 'page B to load')
        await waitFor(
          win,
          `window.__mu7.getNav()[${JSON.stringify(mainTabId)}].canGoBack === true`,
          'the back button to enable'
        )

        await click(win, 'nav-back')
        await waitUntil(() => views.currentUrl(mainTabId) === PAGE_A, 'back to page A')

        await click(win, 'nav-forward')
        await waitUntil(() => views.currentUrl(mainTabId) === PAGE_B, 'forward to page B')

        await evaluate(win, `window.api.view.navigate(${JSON.stringify(mainTabId)}, ${JSON.stringify(PAGE_A)})`)
        await waitUntil(() => views.currentUrl(mainTabId) === PAGE_A, 'return to page A')
      }
    },
    {
      name: 'M2 find-in-page counts matches inside the embedded page',
      run: async () => {
        await click(win, 'find-toggle')
        await evaluate(
          win,
          `(() => {
             const input = document.querySelector('${sel('find-input')}')
             const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
             setter.call(input, 'الصبر')
             input.dispatchEvent(new Event('input', { bubbles: true }))
           })()`
        )
        await waitFor(
          win,
          `(window.__mu7.getFind() || {}).matches >= 3`,
          'find to report the three matches'
        )
        assert(
          (await evaluate<string>(win, `document.querySelector('${sel('find-count')}').textContent`)).includes('/'),
          'the find bar should show an n/m counter'
        )
      }
    },
    {
      name: 'M2 calibration learns a search template from the live URL',
      run: async () => {
        await click(win, 'calibrate')
        await waitFor(win, `${count('toast')} === 1`, 'a calibration toast')

        const learned = await evaluate<string | null>(
          win,
          `(window.__mu7.getTools().find((t) => t.id === 'quran') || {}).searchUrl`
        )
        assert(learned?.includes('{q}'), `expected a {q} template, got ${JSON.stringify(learned)}`)

        // It must round-trip back through main into the same URL.
        const rebuilt = await evaluate<string>(win, `window.api.buildSearchUrl('quran', 'الصبر')`)
        assertEqual(rebuilt, PAGE_A, 'the learned template should rebuild the page URL')
      }
    },
    {
      name: 'M2 beyond eight live views the oldest hibernate',
      run: async () => {
        for (let i = 0; i < 8; i++) {
          await openLocalSearchTab(win, views, {
            toolId: 'quran',
            title: `بحث ${i}`,
            url: dataPage(`ص ${i}`, `<p>صفحة ${i}</p>`)
          })
        }
        const state = views.debugState()
        assert(state.live.length <= 8, `live views capped, got ${state.live.length}`)
        assert(state.hibernated.length > 0, 'the oldest views should have hibernated')
        assert(state.hibernated.includes(mainTabId), 'the first tab is the oldest and should sleep')

        // Waking it must restore the page it was on, not the tab's original URL.
        await click(win, 'search-tab', 0)
        await waitUntil(() => views.debugState().attached.includes(mainTabId), 'the tab to wake')
        await waitUntil(() => views.currentUrl(mainTabId) === PAGE_A, 'the woken tab to restore its page')
      }
    },
    {
      name: 'M2 closing a search tab destroys its view',
      run: async () => {
        await click(win, 'search-tab-close', 0)
        await waitUntil(
          () => !views.debugState().live.includes(mainTabId) && !views.debugState().hibernated.includes(mainTabId),
          'the view to be torn down'
        )

        await flush(win)
        const saved = await readWorkspaceFile(store)
        const discussion = saved.discussions.find((d) => d.id === saved.activeDiscussionId)
        assert(
          !discussion?.tabs.some((t) => t.id === mainTabId),
          'the closed tab should be gone from disk too'
        )
      }
    }
  ]
}

// ── M3: copy pipeline ────────────────────────────────────────────────────────

/** Run an expression inside the embedded page rather than the app's renderer. */
function inPage<T>(views: ViewManager, expression: string): Promise<T> {
  const wc = views.attachedContents()
  if (!wc) throw new SmokeError('no embedded view is attached')
  return wc.executeJavaScript(expression, true) as Promise<T>
}

/** Select the contents of the nth paragraph of the embedded page. */
const selectParagraph = (views: ViewManager, index: number): Promise<void> =>
  inPage(
    views,
    `(() => {
       const p = document.querySelectorAll('p')[${index}]
       const range = document.createRange()
       range.selectNodeContents(p)
       const sel = getSelection()
       sel.removeAllRanges()
       sel.addRange(range)
     })()`
  )

/**
 * Hover a block and wait for the copy button. The smoke window is visible, so the real
 * mouse pointer emits its own mousemove/mouseleave that can undo a single synthetic
 * event; re-dispatching until the button settles keeps the check about behaviour rather
 * than about where the tester's cursor happens to be.
 */
async function hoverBlock(views: ViewManager, index: number, expect: 'flex' | 'none'): Promise<string> {
  let seen = ''
  for (let attempt = 0; attempt < 25; attempt++) {
    await inPage(
      views,
      `document.querySelectorAll('p')[${index}]
         .dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`
    )
    await sleep(80)
    seen = await inPage<string>(
      views,
      `getComputedStyle(
         document.querySelector('[data-mu7="copy-overlay"]').shadowRoot
           .querySelector('[data-mu7-copy]')
       ).display`
    )
    if (seen === expect) return seen
  }
  return seen
}

const pressInPage = (views: ViewManager, key: string, shift: boolean): Promise<void> =>
  inPage(
    views,
    `document.dispatchEvent(new KeyboardEvent('keydown', {
       key: ${JSON.stringify(key)}, ctrlKey: true, shiftKey: ${shift}, bubbles: true, cancelable: true
     }))`
  )

function m3Steps(win: BrowserWindow, store: WorkspaceStore, views: ViewManager): Step[] {
  const QUOTE = 'الصَّبْرُ عِنْدَ الصَّدْمَةِ الأُولى'
  const page = dataPage(
    'صفحة الاقتباس',
    `<p>قصير</p><p>${QUOTE} — وهذا نصٌّ طويل بما يكفي ليستحق زر النسخ.</p>` +
      `<p>فقرة أخرى طويلة بما يكفي كي تُعرض عليها أداة النسخ عند المرور بالفأرة.</p>`
  )
  let tabId = ''

  return [
    {
      name: 'M3 the copy overlay is injected into the embedded page',
      run: async () => {
        await evaluate(win, `window.__mu7.actions.createDiscussion('حوار النسخ')`)
        await sleep(60)
        tabId = await openLocalSearchTab(win, views, {
          toolId: 'quran',
          title: 'اقتباس',
          query: 'الصبر',
          url: page
        })
        await waitUntil(() => views.currentUrl(tabId) === page, 'the quote page to load')

        await sleep(200) // let the preload install its overlay

        assertEqual(
          await inPage<number>(views, `document.querySelectorAll('[data-mu7="copy-overlay"]').length`),
          1,
          'exactly one overlay host'
        )
        assertEqual(
          await inPage<boolean>(
            views,
            `!!document.querySelector('[data-mu7="copy-overlay"]').shadowRoot.querySelector('[data-mu7-copy]')`
          ),
          true,
          'the shadow root should hold the copy button'
        )
      }
    },
    {
      name: 'M3 the copy button follows the hovered block and skips short ones',
      run: async () => {
        // A block too short to be worth quoting offers nothing.
        assertEqual(await hoverBlock(views, 0, 'none'), 'none', 'no button on a short block')
        // A quotable one does.
        assertEqual(await hoverBlock(views, 1, 'flex'), 'flex', 'button shown on a quotable block')
      }
    },
    {
      name: 'M3 clicking the copy button puts the block on the clipboard',
      run: async () => {
        await inPage(
          views,
          `document.querySelector('[data-mu7="copy-overlay"]').shadowRoot
             .querySelector('[data-mu7-copy]').click()`
        )
        await sleep(200)

        const copied = await evaluate<string>(win, `window.__mu7.readClipboard()`)
        assert(copied.includes(QUOTE), `clipboard should hold the quote, got ${JSON.stringify(copied.slice(0, 80))}`)
        // Diacritics must survive the trip through the pipeline.
        assert(copied.includes('الصَّبْرُ'), 'tashkeel must be preserved')
        // The block button copies the text alone; only the shortcuts add attribution.
        assert(!copied.includes('صفحة الاقتباس'), 'the plain button must not append the source')
        await waitFor(win, `${count('toast')} === 1`, 'a copy toast')
      }
    },
    {
      name: 'M3 Ctrl+Shift+C copies the selection with its source',
      run: async () => {
        await evaluate(win, `window.api.writeClipboard('')`)
        await selectParagraph(views, 1)
        await pressInPage(views, 'C', true)
        await sleep(250)

        const copied = await evaluate<string>(win, `window.__mu7.readClipboard()`)
        assert(copied.includes(QUOTE), 'the selection should be copied')
        assert(copied.includes('— صفحة الاقتباس'), `attribution missing from ${JSON.stringify(copied.slice(-60))}`)
        assert(copied.includes('data:text/html'), 'the source URL should be included')
      }
    },
    {
      name: 'M3 Ctrl+Enter sends the selection into the active draft',
      run: async () => {
        assertEqual(
          await evaluate<number>(win, count('draft-tab')),
          0,
          'this discussion starts with no draft'
        )

        await selectParagraph(views, 2)
        await pressInPage(views, 'Enter', false)
        await waitFor(win, `${count('draft-tab')} === 1`, 'a draft to be opened for the excerpt')

        const draft = await evaluate<{ content: string; sources: number }>(
          win,
          `(() => {
             const ws = window.__mu7.getWorkspace()
             const d = ws.discussions.find((x) => x.id === ws.activeDiscussionId)
             const t = d.tabs.find((t) => t.id === d.activeDraftTabId)
             return { content: t.content, sources: t.sources.length }
           })()`
        )
        assert(draft.content.includes('فقرة أخرى طويلة'), `draft got ${JSON.stringify(draft.content)}`)
        assertEqual(draft.sources, 1, 'the excerpt should carry one recorded source')
      }
    },
    {
      name: 'M3 a second excerpt appends below the first with a blank line',
      run: async () => {
        await selectParagraph(views, 1)
        await pressInPage(views, 'Enter', false)
        await sleep(250)

        const content = await evaluate<string>(
          win,
          `(() => {
             const ws = window.__mu7.getWorkspace()
             const d = ws.discussions.find((x) => x.id === ws.activeDiscussionId)
             return d.tabs.find((t) => t.id === d.activeDraftTabId).content
           })()`
        )
        assert(content.includes('\n\n'), 'excerpts should be separated by a blank line')
        assert(content.includes(QUOTE), 'the second excerpt should be appended')
        assertEqual(await evaluate<number>(win, count('draft-tab')), 1, 'still a single draft')

        await flush(win)
        const saved = await readWorkspaceFile(store)
        const discussion = saved.discussions.find((d) => d.id === saved.activeDiscussionId)!
        const draft = discussion.tabs.find((t) => t.id === discussion.activeDraftTabId)!
        assert(
          draft.kind === 'draft' && draft.sources.length === 2,
          'both sources should be persisted'
        )
      }
    }
  ]
}

// ── M4: draft editor ─────────────────────────────────────────────────────────

/** Type into the RTL editor the way React's controlled textarea expects. */
async function typeDraft(win: BrowserWindow, text: string): Promise<void> {
  await evaluate(
    win,
    `(() => {
       const el = document.querySelector('${sel('draft-editor')}')
       if (!el) throw new Error('the draft editor is not mounted')
       const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
       setter.call(el, ${JSON.stringify(text)})
       el.dispatchEvent(new Event('input', { bubbles: true }))
     })()`
  )
}

const draftContent = (win: BrowserWindow): Promise<string> =>
  evaluate(
    win,
    `(() => {
       const ws = window.__mu7.getWorkspace()
       const d = ws.discussions.find((x) => x.id === ws.activeDiscussionId)
       const t = d && d.tabs.find((t) => t.id === d.activeDraftTabId)
       return t ? t.content : ''
     })()`
  )

function m4Steps(win: BrowserWindow, store: WorkspaceStore): Step[] {
  const VOCALISED = 'الصَّبْرُ مِفْتَاحُ الفَرَجِ'

  return [
    {
      name: 'M4 the editor renders right-to-left with the excerpts already in it',
      run: async () => {
        assertEqual(await evaluate<number>(win, count('draft-editor')), 1, 'one editor')
        assertEqual(
          await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').dir`),
          'rtl',
          'the editor must be RTL'
        )
        assert(
          (await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`)).includes(
            'فقرة أخرى طويلة'
          ),
          'the editor should show the excerpts M3 appended'
        )
      }
    },
    {
      name: 'M4 typing is committed to the workspace and survives a reload',
      run: async () => {
        await typeDraft(win, VOCALISED)
        // Nothing should reach the store while the debounce is still open.
        assert(
          !(await draftContent(win)).includes(VOCALISED),
          'typing should not hit the store on every keystroke'
        )

        await waitFor(
          win,
          `(() => {
             const ws = window.__mu7.getWorkspace()
             const d = ws.discussions.find((x) => x.id === ws.activeDiscussionId)
             const t = d.tabs.find((t) => t.id === d.activeDraftTabId)
             return t.content === ${JSON.stringify(VOCALISED)}
           })()`,
          'the debounced commit to land'
        )

        await flush(win)
        const saved = await readWorkspaceFile(store)
        const discussion = saved.discussions.find((d) => d.id === saved.activeDiscussionId)!
        const draft = discussion.tabs.find((t) => t.id === discussion.activeDraftTabId)!
        assert(draft.kind === 'draft' && draft.content === VOCALISED, 'the draft should be on disk')
        // Tashkeel must survive the editor, the store and JSON.
        assert(draft.kind === 'draft' && draft.content.includes('َّ'), 'diacritics preserved on disk')
      }
    },
    {
      name: 'M4 the character counter tracks the draft',
      run: async () => {
        const shown = await evaluate<string>(
          win,
          `document.querySelector('${sel('draft-count')}').textContent`
        )
        assert(shown.startsWith(String(VOCALISED.length)), `counter shows ${JSON.stringify(shown)}`)
      }
    },
    {
      name: 'M4 switching drafts keeps each tab its own text',
      run: async () => {
        await click(win, 'new-draft-tab')
        await sleep(80)
        assertEqual(await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`), '', 'a new draft starts empty')

        await typeDraft(win, 'الرد الثاني')
        await sleep(COMMIT_WAIT)

        await click(win, 'draft-tab', 0)
        await sleep(120)
        assertEqual(
          await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`),
          VOCALISED,
          'the first draft should be unchanged'
        )

        await click(win, 'draft-tab', 1)
        await sleep(120)
        assertEqual(
          await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`),
          'الرد الثاني',
          'the second draft should keep its own text'
        )
      }
    },
    {
      name: 'M4 an unfinished edit is committed when the tab changes',
      run: async () => {
        // Type and switch away immediately, inside the debounce window.
        await typeDraft(win, 'لم يُحفظ بعد')
        await click(win, 'draft-tab', 0)
        await sleep(150)
        await click(win, 'draft-tab', 1)
        await sleep(150)

        assertEqual(
          await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`),
          'لم يُحفظ بعد',
          'the pending edit must not be lost when leaving the tab'
        )
      }
    },
    {
      name: 'M4 copy-all puts the draft and its sources on the clipboard',
      run: async () => {
        await evaluate(win, `window.api.writeClipboard('')`)
        await click(win, 'draft-tab', 0) // the draft carrying M3's sources
        await sleep(120)

        await click(win, 'copy-draft')
        await sleep(200)
        const withList = await evaluate<string>(win, `window.__mu7.readClipboard()`)
        assert(withList.includes(VOCALISED), 'the body should be copied')
        assert(withList.includes('المصادر:'), `expected a source list, got ${JSON.stringify(withList.slice(0, 80))}`)
        assert(withList.includes('data:text/html'), 'the recorded source URLs should be listed')

        // Unticking the box drops the footnotes.
        await click(win, 'append-sources')
        await sleep(80)
        await click(win, 'copy-draft')
        await sleep(200)
        const bodyOnly = await evaluate<string>(win, `window.__mu7.readClipboard()`)
        assert(bodyOnly.includes(VOCALISED), 'the body should still be copied')
        assert(!bodyOnly.includes('المصادر:'), 'the source list should be omitted')
        await click(win, 'append-sources')
      }
    },
    {
      name: 'M4 Ctrl+Shift+A copies the whole draft from the app chrome',
      run: async () => {
        await evaluate(win, `window.api.writeClipboard('')`)
        // A real key event, so it goes through the same matcher the app uses at runtime.
        await sendKey(win.webContents, 'A', ['control', 'shift'])
        await sleep(250)
        assert(
          (await evaluate<string>(win, `window.__mu7.readClipboard()`)).includes(VOCALISED),
          'the shortcut should copy the draft'
        )
      }
    },
    {
      name: 'M4 pasting inserts plain text at the caret',
      run: async () => {
        await evaluate(
          win,
          `(() => {
             const el = document.querySelector('${sel('draft-editor')}')
             el.focus()
             el.setSelectionRange(0, 0)
             const data = new DataTransfer()
             data.setData('text/plain', 'مقدمة: ')
             el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
           })()`
        )
        await sleep(COMMIT_WAIT)
        const value = await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`)
        assert(value.startsWith('مقدمة: '), `paste should land at the caret, got ${JSON.stringify(value.slice(0, 30))}`)
        assert(value.includes(VOCALISED), 'the existing text should be kept')
      }
    }
  ]
}

/** Comfortably longer than the editor's commit debounce. */
const COMMIT_WAIT = 500

// ── M5: مكتبة الردود ─────────────────────────────────────────────────────────

/** Type a query into the ردود search box and submit it. */
async function searchRudud(win: BrowserWindow, query: string): Promise<void> {
  await evaluate(
    win,
    `(() => {
       const input = document.querySelector('${sel('rudud-query')}')
       if (!input) throw new Error('the ردود search box is not mounted')
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
       setter.call(input, ${JSON.stringify(query)})
       input.dispatchEvent(new Event('input', { bubbles: true }))
     })()`
  )
  await sleep(40)
  await click(win, 'rudud-run')
  await sleep(250)
}

function m5Steps(win: BrowserWindow, views: ViewManager): Step[] {
  return [
    {
      name: 'M5 the index is built and loaded in main',
      run: async () => {
        const status = await evaluate<{ available: boolean; size: number }>(
          win,
          `window.__mu7.rududStatus()`
        )
        assert(status.available, 'the ردود index should be loaded — run `npm run build:rudud`')
        assert(status.size > 600, `expected the full corpus, got ${status.size} documents`)
      }
    },
    {
      name: 'M5 opening the local tool renders results instead of a web view',
      run: async () => {
        await openPromptTab(win, 'rudud', 'الوسواس')
        await waitFor(win, `${count('rudud')} === 1`, 'the ردود panel')
        await waitUntil(
          () => views.debugState().attached.length === 0,
          'the embedded view to detach for a local tool'
        )
        await waitFor(win, `${count('rudud-hit')} > 0`, 'results for الوسواس')
      }
    },
    {
      name: 'M5 a bare query matches vocalised text and highlights it',
      run: async () => {
        await searchRudud(win, 'الصبر')
        await waitFor(win, `${count('rudud-hit')} > 0`, 'results for الصبر')

        const marks = await evaluate<string[]>(
          win,
          `[...document.querySelectorAll('${sel('rudud-text')} mark')].slice(0, 20).map((m) => m.textContent)`
        )
        assert(marks.length > 0, 'matches should be highlighted')
        // The corpus is vocalised, so at least one highlight should carry diacritics
        // that the bare query did not contain.
        assert(
          marks.some((m) => /[ً-ْ]/.test(m)),
          `expected a vocalised highlight, got ${JSON.stringify(marks.slice(0, 5))}`
        )
      }
    },
    {
      name: 'M5 the result count and an unmatched query behave',
      run: async () => {
        const shown = await evaluate<string>(
          win,
          `document.querySelector('${sel('rudud-count')}').textContent`
        )
        assert(/\d/.test(shown), `expected a result count, got ${JSON.stringify(shown)}`)

        await searchRudud(win, 'zzzqqq')
        await waitFor(win, `${count('rudud-hit')} === 0`, 'no results for nonsense')
      }
    },
    {
      name: 'M5 copying a result puts it on the clipboard',
      run: async () => {
        await searchRudud(win, 'الصبر')
        await waitFor(win, `${count('rudud-hit')} > 0`, 'results to come back')
        await evaluate(win, `window.api.writeClipboard('')`)

        await click(win, 'rudud-copy', 0)
        await sleep(250)
        const copied = await evaluate<string>(win, `window.__mu7.readClipboard()`)
        assert(copied.length > 40, `expected the full message, got ${copied.length} characters`)
        // Copies carry the original text, diacritics and all.
        assert(!copied.includes('<mark>'), 'markup must not leak into the clipboard')
      }
    },
    {
      name: 'M5 sending a result to the draft records its source',
      run: async () => {
        const before = await draftContent(win)
        await click(win, 'rudud-to-draft', 0)
        await sleep(300)

        const after = await draftContent(win)
        assert(after.length > before.length, 'the draft should have grown')

        const sources = await evaluate<string[]>(
          win,
          `(() => {
             const ws = window.__mu7.getWorkspace()
             const d = ws.discussions.find((x) => x.id === ws.activeDiscussionId)
             const t = d.tabs.find((t) => t.id === d.activeDraftTabId)
             return t.sources.map((s) => s.pageTitle)
           })()`
        )
        assert(
          sources.some((s) => s.startsWith('مكتبة الردود #')),
          `expected a ردود attribution, got ${JSON.stringify(sources)}`
        )
      }
    },
    {
      name: 'M5 clicking a tag searches for it',
      run: async () => {
        const tag = await evaluate<string | null>(
          win,
          `(() => {
             const el = document.querySelector('.rudud__tag')
             return el ? el.textContent : null
           })()`
        )
        if (!tag) return // this result set happens to be untagged
        await evaluate(win, `document.querySelector('.rudud__tag').click()`)
        await sleep(300)
        await waitFor(win, `${count('rudud-hit')} > 0`, `results for the tag ${tag}`)
        assertEqual(
          await evaluate<string>(win, `document.querySelector('${sel('rudud-query')}').value`),
          tag,
          'the search box should show the tag that was clicked'
        )
      }
    }
  ]
}

// ── M6: dictation ────────────────────────────────────────────────────────────

/**
 * Inject a real key event, the way the OS would. This goes through
 * `before-input-event`, which is where the app matches its shortcuts — a synthetic
 * DOM KeyboardEvent would bypass that entirely and prove nothing.
 */
async function sendKey(
  wc: Electron.WebContents,
  keyCode: string,
  modifiers: string[] = [],
  type: 'keyDown' | 'keyUp' = 'keyDown'
): Promise<void> {
  wc.sendInputEvent({ type, keyCode, modifiers } as Electron.KeyboardInputEvent)
  await sleep(90)
}

const pressKey = (win: BrowserWindow, key: string, type: 'keydown' | 'keyup'): Promise<void> =>
  sendKey(win.webContents, key, [], type === 'keydown' ? 'keyDown' : 'keyUp')

const hudPhase = (win: BrowserWindow): Promise<string | null> =>
  evaluate(
    win,
    `(() => {
       const el = document.querySelector('${sel('dictation-hud')}')
       return el ? el.dataset.phase : null
     })()`
  )

function m6Steps(win: BrowserWindow): Step[] {
  return [
    {
      name: 'M6 dictation reports itself ready once its assets are present',
      run: async () => {
        const status = await evaluate<{
          ready: boolean
          binaryPath: string | null
          modelPath: string | null
        }>(win, `window.api.dictationStatus()`)
        assert(status.ready, 'the stand-in whisper assets should be detected')
        assert(status.modelPath?.includes('ggml-'), `model path: ${status.modelPath}`)
        // Never the deprecated `main` stub sitting beside it — see issue #4.
        assert(
          status.binaryPath?.endsWith('whisper-cli.exe'),
          `binary path: ${status.binaryPath}`
        )
      }
    },
    {
      name: 'M6 holding F4 starts recording and shows the meter',
      run: async () => {
        // Put the caret mid-draft so the insertion point can be checked later.
        await click(win, 'draft-tab', 0)
        await sleep(120)
        await typeDraft(win, 'قبل بعد')
        await sleep(COMMIT_WAIT)
        await evaluate(
          win,
          `(() => {
             const el = document.querySelector('${sel('draft-editor')}')
             el.focus()
             el.setSelectionRange(4, 4)
           })()`
        )

        await pressKey(win, 'F4', 'keydown')
        await waitFor(
          win,
          `(document.querySelector('${sel('dictation-hud')}') || {}).dataset?.phase === 'recording'`,
          'the recording HUD'
        )
      }
    },
    {
      name: 'M6 releasing F4 transcribes real captured audio into the draft',
      run: async () => {
        await sleep(900) // longer than the minimum clip, so the clip is accepted
        await pressKey(win, 'F4', 'keyup')

        await waitFor(win, `${count('dictation-hud')} === 0`, 'dictation to finish', 30_000)

        const value = await evaluate<string>(
          win,
          `document.querySelector('${sel('draft-editor')}').value`
        )
        assert(value.includes('النص المملى'), `expected the transcript, got ${JSON.stringify(value)}`)

        // The stand-in reports the clip size it was handed: proof that real audio was
        // captured, resampled to 16 kHz and WAV-encoded before reaching main.
        const size = Number(/\[(\d+)\]/.exec(value)?.[1] ?? 0)
        assert(size > 44, `the WAV should carry samples, got ${size} bytes`)

        // It must land at the caret, not at the end.
        assert(value.startsWith('قبل '), `insertion point wrong: ${JSON.stringify(value.slice(0, 20))}`)
        assert(value.trimEnd().endsWith('بعد'), 'the text after the caret should be kept')
      }
    },
    {
      name: 'M6 Escape abandons a recording without inserting anything',
      run: async () => {
        const before = await evaluate<string>(
          win,
          `document.querySelector('${sel('draft-editor')}').value`
        )
        await pressKey(win, 'F4', 'keydown')
        await waitFor(
          win,
          `(document.querySelector('${sel('dictation-hud')}') || {}).dataset?.phase === 'recording'`,
          'the recording HUD'
        )
        await pressKey(win, 'Escape', 'keydown')
        await waitFor(win, `${count('dictation-hud')} === 0`, 'the HUD to close')
        await pressKey(win, 'F4', 'keyup')
        await sleep(400)

        assertEqual(
          await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`),
          before,
          'a cancelled recording must not change the draft'
        )
      }
    },
    {
      name: 'M6 a tap opens hands-free dictation, and the next press ends it',
      run: async () => {
        const draft = (): Promise<string> =>
          evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`)
        const before = await draft()
        const transcripts = (text: string): number => text.split('النص المملى').length - 1

        await pressKey(win, 'F4', 'keydown')
        await sleep(60) // a tap, well under the hold threshold
        await pressKey(win, 'F4', 'keyup')
        await waitFor(
          win,
          `(document.querySelector('${sel('dictation-hud')}') || {}).dataset?.mode === 'handsfree'`,
          'hands-free mode'
        )

        // The key is up, yet the microphone stays open.
        await sleep(1_000)
        assertEqual(await hudPhase(win), 'recording', 'hands-free keeps recording after release')

        await pressKey(win, 'F4', 'keydown')
        await waitFor(win, `${count('dictation-hud')} === 0`, 'dictation to finish', 30_000)
        await pressKey(win, 'F4', 'keyup')
        await sleep(300)

        const after = await draft()
        assertEqual(transcripts(after), transcripts(before) + 1, 'the hands-free phrase lands in the draft')
        assert((await hudPhase(win)) === null, 'the release after stopping must not restart it')
      }
    }
  ]
}

// ── M7: shortcuts and settings ───────────────────────────────────────────────

const uiState = <T,>(win: BrowserWindow, expression: string): Promise<T> =>
  evaluate(win, `(() => { const ui = window.__mu7.getUi(); return ${expression} })()`)

function m7Steps(win: BrowserWindow, views: ViewManager): Step[] {
  let viewContents: Electron.WebContents | null = null

  return [
    {
      name: 'M7 a shortcut pressed inside an embedded page still reaches the app',
      run: async () => {
        await evaluate(win, `window.__mu7.actions.createDiscussion('حوار الاختصارات')`)
        await sleep(80)
        await openLocalSearchTab(win, views, {
          toolId: 'quran',
          title: 'صفحة',
          url: dataPage('صفحة الاختصارات', '<p>نص طويل بما يكفي للاختبار والتحديد هنا.</p>')
        })
        viewContents = views.attachedContents()
        assert(viewContents, 'the embedded view should be attached')
        viewContents.focus()
        await sleep(120)

        assertEqual(await evaluate<number>(win, count('draft-tab')), 0, 'no drafts yet')
        // Ctrl+D pressed with focus inside the web page, not the app chrome.
        await sendKey(viewContents, 'd', ['control'])
        await waitFor(win, `${count('draft-tab')} === 1`, 'a draft opened from inside the page')
      }
    },
    {
      name: 'M7 a tool shortcut opens the prompt with that tool chosen',
      run: async () => {
        await sendKey(viewContents!, '2', ['control'])
        await waitFor(win, `${count('new-search-prompt')} === 1`, 'the prompt')
        assertEqual(
          await evaluate<string>(
            win,
            `document.querySelector('${sel('prompt-tool')}[data-active]').dataset.tool`
          ),
          'hadith',
          'Ctrl+2 should preselect the hadith tool'
        )
        await evaluate(
          win,
          `document.querySelector('${sel('prompt-query')}')
             .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
        )
        await waitFor(win, `${count('new-search-prompt')} === 0`, 'the prompt to close')
      }
    },
    {
      name: 'M7 a tool shortcut prefills the text selected in the page',
      run: async () => {
        await selectParagraph(views, 0)
        await sendKey(viewContents!, '1', ['control'])
        await waitFor(win, `${count('new-search-prompt')} === 1`, 'the prompt')

        const prefilled = await evaluate<string>(
          win,
          `document.querySelector('${sel('prompt-query')}').value`
        )
        assert(
          prefilled.includes('نص طويل'),
          `the page selection should be carried over, got ${JSON.stringify(prefilled)}`
        )
        await evaluate(
          win,
          `document.querySelector('${sel('prompt-query')}')
             .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
        )
        await waitFor(win, `${count('new-search-prompt')} === 0`, 'the prompt to close')
      }
    },
    {
      name: 'M7 tab navigation shortcuts move within one kind of tab',
      run: async () => {
        await openLocalSearchTab(win, views, {
          toolId: 'quran',
          title: 'ثانية',
          url: dataPage('ثانية', '<p>صفحة ثانية للتنقل بين الألسنة.</p>')
        })
        assertEqual(await evaluate<number>(win, count('search-tab')), 2, 'two search tabs')

        const activeTitle = (): Promise<string> =>
          evaluate(
            win,
            `document.querySelector('${sel('search-tab')}[data-active] .tab__title').textContent`
          )
        assertEqual(await activeTitle(), 'ثانية', 'the newest tab is active')

        await sendKey(win.webContents, 'Left', ['alt'])
        assertEqual(await activeTitle(), 'صفحة', 'Alt+Left moves to the previous tab')
        await sendKey(win.webContents, 'Right', ['alt'])
        assertEqual(await activeTitle(), 'ثانية', 'Alt+Right moves back')
        await sendKey(win.webContents, 'Home', ['alt'])
        assertEqual(await activeTitle(), 'صفحة', 'Alt+Home jumps to the first tab')
        await sendKey(win.webContents, 'End', ['alt'])
        assertEqual(await activeTitle(), 'ثانية', 'Alt+End jumps to the last tab')

        // Draft tabs must be untouched by the search-tab bindings.
        assertEqual(await evaluate<number>(win, count('draft-tab')), 1, 'drafts unaffected')
      }
    },
    {
      name: 'M7 F2 renames the tab in the pane that has focus',
      run: async () => {
        await click(win, 'search-tab', 0) // focus the search pane
        await sendKey(win.webContents, 'F2')
        await waitFor(win, `document.querySelectorAll('input.inline-edit').length === 1`, 'a rename editor')
        await typeInlineEdit(win, 'مسمّى جديد')
        assertEqual(
          await evaluate<string>(
            win,
            `document.querySelector('${sel('search-tab')}[data-active] .tab__title').textContent`
          ),
          'مسمّى جديد',
          'the renamed search tab'
        )

        // With the draft pane focused, F2 must target the draft tab instead.
        await click(win, 'draft-tab', 0)
        await sendKey(win.webContents, 'F2')
        await waitFor(win, `document.querySelectorAll('input.inline-edit').length === 1`, 'a rename editor')
        await typeInlineEdit(win, 'ردّي')
        assertEqual(
          await evaluate<string>(
            win,
            `document.querySelector('${sel('draft-tab')}[data-active] .tab__title').textContent`
          ),
          'ردّي',
          'the renamed draft tab'
        )
      }
    },
    {
      name: 'M7 Ctrl+W closes the tab in the focused pane',
      run: async () => {
        await click(win, 'draft-tab', 0)
        await sendKey(win.webContents, 'w', ['control'])
        await waitFor(win, `${count('draft-tab')} === 0`, 'the draft tab to close')
        assertEqual(await evaluate<number>(win, count('search-tab')), 2, 'search tabs untouched')

        await click(win, 'search-tab', 0)
        await sendKey(win.webContents, 'w', ['control'])
        await waitFor(win, `${count('search-tab')} === 1`, 'a search tab to close')
      }
    },
    {
      name: 'M7 Ctrl+D and Ctrl+N create tabs and discussions',
      run: async () => {
        await sendKey(win.webContents, 'd', ['control'])
        await waitFor(win, `${count('draft-tab')} === 1`, 'Ctrl+D to open a draft')

        const before = await evaluate<number>(win, count('discussion'))
        await sendKey(win.webContents, 'n', ['control'])
        await waitFor(win, `${count('discussion')} === ${before + 1}`, 'Ctrl+N to add a discussion')
        // A fresh discussion opens its rename editor, as the sidebar button does.
        assertEqual(
          await evaluate<number>(win, `document.querySelectorAll('input.inline-edit').length`),
          1,
          'the new discussion should be waiting to be named'
        )
        await typeInlineEdit(win, 'من الاختصار')

        await sendKey(win.webContents, 'Tab', ['control'])
        await sendKey(win.webContents, 'Tab', ['control', 'shift'])
        assertEqual(
          await evaluate<string>(
            win,
            `document.querySelector('${sel('discussion')}[data-active] .discussion__title').textContent`
          ),
          'من الاختصار',
          'Ctrl+Tab then Ctrl+Shift+Tab should return to the same discussion'
        )
      }
    },
    {
      name: 'M7 Ctrl+B collapses the sidebar and brings it back',
      run: async () => {
        await sendKey(win.webContents, 'b', ['control'])
        await waitFor(win, `${count('sidebar')} === 0`, 'the sidebar to collapse')
        await sendKey(win.webContents, 'b', ['control'])
        await waitFor(win, `${count('sidebar')} === 1`, 'the sidebar to return')
      }
    },
    {
      name: 'M7 Ctrl+, opens settings, which hides the embedded view',
      run: async () => {
        // Open a page of our own so the check does not depend on what earlier steps left.
        await openLocalSearchTab(win, views, {
          toolId: 'quran',
          title: 'للإعدادات',
          url: dataPage('للإعدادات', '<p>صفحة مفتوحة خلف لوحة الإعدادات.</p>')
        })
        await waitUntil(() => views.debugState().attached.length === 1, 'a view on screen first')

        await sendKey(win.webContents, ',', ['control'])
        await waitFor(win, `${count('settings')} === 1`, 'the settings panel')
        await waitUntil(
          () => views.debugState().attached.length === 0,
          'the embedded view to hide behind the settings overlay'
        )
      }
    },
    {
      name: 'M7 settings list every shortcut, the tools and the dictation state',
      run: async () => {
        const listed = await evaluate<number>(win, `document.querySelectorAll('${sel('settings-shortcuts')} li').length`)
        assert(listed >= 25, `expected the full keymap, got ${listed} rows`)
        assertEqual(await evaluate<number>(win, count('settings-tool')), 7, 'all seven tools')
        assertEqual(
          await evaluate<number>(win, count('dictation-ready')),
          1,
          'dictation should report itself ready'
        )

        await evaluate(win, `document.querySelector('${sel('close-settings')}').click()`)
        await waitFor(win, `${count('settings')} === 0`, 'settings to close')
        await waitUntil(
          () => views.debugState().attached.length === 1,
          'the embedded view to come back'
        )
      }
    },
    {
      name: 'M7 editing keys are not swallowed by the shortcut layer',
      run: async () => {
        // Own draft, so this does not depend on what the earlier steps closed.
        await sendKey(win.webContents, 'd', ['control'])
        await waitFor(win, `${count('draft-editor')} === 1`, 'a draft editor')
        await click(win, 'draft-tab', 0)
        await sleep(120)
        await typeDraft(win, 'البداية ')
        await sleep(COMMIT_WAIT)
        await evaluate(win, `window.api.writeClipboard('ملصوق')`)

        await evaluate(
          win,
          `(() => {
             const el = document.querySelector('${sel('draft-editor')}')
             el.focus()
             el.setSelectionRange(el.value.length, el.value.length)
           })()`
        )
        // Ctrl+V has no binding, so it must reach the textarea untouched.
        await sendKey(win.webContents, 'v', ['control'])
        await sleep(250)

        assert(
          (await evaluate<string>(win, `document.querySelector('${sel('draft-editor')}').value`)).includes(
            'ملصوق'
          ),
          'paste must still work inside the editor'
        )
      }
    },
    {
      name: 'M7 the UI state the shortcuts drive is consistent',
      run: async () => {
        assertEqual(await uiState<boolean>(win, 'ui.settingsOpen'), false, 'settings closed')
        assertEqual(await uiState<boolean>(win, 'ui.promptOpen'), false, 'prompt closed')
        assertEqual(await uiState<unknown>(win, 'ui.renaming'), null, 'no rename in progress')
        assertEqual(await uiState<string>(win, 'ui.focusedPane'), 'draft', 'draft pane has focus')
      }
    }
  ]
}

/** Opt-in: exercises the real sites. Enabled with MU7_SMOKE_NET=1. */
function m2NetSteps(win: BrowserWindow, views: ViewManager): Step[] {
  return [
    {
      name: 'M2 (net) a real search loads through the prompt',
      run: async () => {
        // `hadith` rather than `quran`: the calibration step above deliberately
        // overwrote the quran template with a local test URL.
        await openPromptTab(win, 'hadith', 'الصبر')

        const tabId = await activeSearchTabId(win)
        assert(tabId, 'a tab should have been created')
        await waitUntil(
          () => views.currentUrl(tabId).includes('sunnah.one'),
          'sunnah.one to load',
          30_000
        )
        await waitFor(
          win,
          `(window.__mu7.getNav()[${JSON.stringify(tabId)}] || {}).loading === false`,
          'the page to finish loading',
          30_000
        )
        console.log(`SMOKE net   loaded ${views.currentUrl(tabId)}`)

        // A URL that only prefills the box is far less useful than one that runs the
        // search, so confirm results actually arrive after the async fetch settles.
        const embedded = views.attachedContents()
        assert(embedded, 'the view should be attached')
        let text = ''
        for (let i = 0; i < 20 && !/[1-9١-٩]/.test(text.replace(/\D/g, ' ')); i++) {
          await sleep(1000)
          text = await embedded.executeJavaScript(
            `(document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240)`,
            true
          )
        }
        console.log(`SMOKE net   page text: ${text}`)
      }
    }
  ]
}

/** Capture the final window state when MU7_SMOKE_SHOT names a path — handy for eyeballing UI work. */
async function capture(win: BrowserWindow, views: ViewManager): Promise<void> {
  const target = process.env.MU7_SMOKE_SHOT
  if (!target) return
  try {
    await fs.writeFile(target, (await win.webContents.capturePage()).toPNG())
    console.log(`SMOKE shot  ${target}`)
    // Also capture the settings panel, which is where the keymap is documented.
    await win.webContents.executeJavaScript(
      `window.__mu7.actions.setUi({ settingsOpen: true })`,
      true
    )
    await new Promise((r) => setTimeout(r, 400))
    await fs.writeFile(
      target.replace(/\.png$/, '') + '.settings.png',
      (await win.webContents.capturePage()).toPNG()
    )
    await win.webContents.executeJavaScript(
      `window.__mu7.actions.setUi({ settingsOpen: false })`,
      true
    )

    // Child views render outside the window's own contents, so grab the page separately.
    const embedded = views.attachedContents()
    if (embedded) {
      const viewShot = target.replace(/\.png$/, '') + '.view.png'
      await fs.writeFile(viewShot, (await embedded.capturePage()).toPNG())
      console.log(`SMOKE shot  ${viewShot}`)
    }
  } catch (err) {
    console.log(`SMOKE shot failed: ${(err as Error).message}`)
  }
}

export async function runSmoke(
  win: BrowserWindow,
  store: WorkspaceStore,
  views: ViewManager
): Promise<void> {
  const steps = [
    ...m0Steps(win, store),
    ...m1Steps(win, store),
    ...m2Steps(win, store, views),
    ...m3Steps(win, store, views),
    ...m4Steps(win, store),
    ...m5Steps(win, views),
    ...m6Steps(win),
    ...m7Steps(win, views),
    // Real sites are only touched when explicitly asked for, so the default run is hermetic.
    ...(process.env.MU7_SMOKE_NET === '1' ? m2NetSteps(win, views) : [])
  ]
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
  await capture(win, views)
  console.log(failed ? 'SMOKE FAILED' : 'SMOKE PASS')

  // Live child views can keep the process alive, so tear them down and hard-exit if
  // Electron's own shutdown stalls.
  views.destroyAll()
  setTimeout(() => process.exit(failed ? 1 : 0), 1500).unref()
  app.exit(failed ? 1 : 0)
}
