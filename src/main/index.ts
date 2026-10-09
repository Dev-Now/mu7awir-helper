import { app, BrowserWindow, clipboard, ipcMain, session } from 'electron'
import path from 'node:path'
import { WorkspaceStore } from './store'
import { Dictation } from './dictation'
import { RududIndex } from './rududIndex'
import { ToolRegistry, buildSearchUrl, deriveSearchUrl } from './tools'
import { SHORTCUTS, resolveShortcut } from './shortcuts'
import { ViewManager, type Bounds, type SyncRequest, type ViewEvent } from './viewManager'
import { fakeWhisperSpawn, runSmoke } from './smoke'
import { cleanCopiedText, withSource } from '@shared/text'
import type { SearchTool, Workspace } from '@shared/types'

const isSmoke = process.env.MU7_SMOKE === '1'

let mainWindow: BrowserWindow | null = null
let store: WorkspaceStore
let tools: ToolRegistry
let rudud: RududIndex
let dictation: Dictation
let views: ViewManager | null = null

/** Main keeps a mirror of the renderer's state so it can flush on quit. */
let workspace: Workspace | null = null

function resourcePath(...parts: string[]): string {
  // Packaged builds put `resources/` next to the asar; in dev it sits in the repo root.
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../..')
  return path.join(base, ...parts)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#12141a',
    autoHideMenuBar: true,
    title: 'مساعد المحاور',
    webPreferences: {
      preload: path.join(__dirname, '../preload/app.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // Smoke runs show the window too: Chromium throttles requestAnimationFrame to a
  // standstill in a hidden window, which stalls both the bounds sync and the in-page
  // hover overlay — failures that would never happen in front of a user.
  win.once('ready-to-show', () => win.show())

  /**
   * Shortcut matching lives here rather than in the renderer so that keys keep working
   * when focus is inside an embedded page — which, in a browser-shaped app, is most of
   * the time. `fromView` is the page's contents when the key came from a search view,
   * which lets tool shortcuts pick up the current text selection.
   */
  const handleInput = (
    event: Electron.Event,
    input: Electron.Input,
    fromView?: Electron.WebContents
  ): void => {
    const hit = resolveShortcut(input)
    if (!hit || win.isDestroyed()) return

    if (hit.kind === 'dictation') {
      // Deliberately not prevented: suppressing the key-down makes Chromium drop the
      // matching key-up, which would leave push-to-talk stuck recording. F4 has no
      // default action worth blocking anyway.
      win.webContents.send('shortcut:dictation', hit.edge)
      return
    }

    event.preventDefault()

    if (fromView && /^tool\.\d$/.test(hit.id)) {
      void fromView
        .executeJavaScript('window.getSelection ? String(window.getSelection()) : ""', true)
        .then((selection: string) => {
          if (!win.isDestroyed()) win.webContents.send('shortcut', { id: hit.id, selection })
        })
        .catch(() => win.webContents.send('shortcut', { id: hit.id }))
      return
    }

    win.webContents.send('shortcut', { id: hit.id })
  }

  win.webContents.on('before-input-event', (event, input) => handleInput(event, input))

  views = new ViewManager(
    win,
    path.join(__dirname, '../preload/site.js'),
    (event: ViewEvent) => {
      if (!win.isDestroyed()) win.webContents.send('view:event', event)
    },
    (event, input, wc) => handleInput(event, input, wc)
  )

  win.on('closed', () => {
    views?.destroyAll()
    views = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle('workspace:load', async () => {
    workspace = await store.load()
    return workspace
  })

  ipcMain.on('workspace:save', (_event, next: Workspace) => {
    workspace = next
    store.queue(next)
  })

  ipcMain.handle('workspace:flush', async () => {
    await store.flush()
  })

  // ── tools ────────────────────────────────────────────────────────────────

  ipcMain.handle('tools:list', (): SearchTool[] => tools.list())

  ipcMain.handle('shortcuts:list', () => SHORTCUTS)

  ipcMain.handle('tools:setSearchUrl', (_e, toolId: string, searchUrl: string | null) =>
    tools.setSearchUrl(toolId, searchUrl)
  )

  ipcMain.handle('tools:setCopyOverlay', async (_e, toolId: string, copyOverlay: boolean) => {
    const next = await tools.setCopyOverlay(toolId, copyOverlay)
    // Pages already open with this tool switch over without a reload.
    for (const wc of views?.contentsForTool(toolId) ?? []) {
      wc.send('site:config', { copyOverlay })
    }
    return next
  })

  ipcMain.handle('dictation:status', () => dictation.refresh())
  ipcMain.handle('dictation:install', () => dictation.install())
  ipcMain.handle('dictation:transcribe', (_e, wav: Uint8Array) =>
    dictation.transcribe(Buffer.from(wav))
  )
  ipcMain.handle('dictation:warm', () => dictation.warm())
  ipcMain.handle('dictation:segment', (_e, wav: Uint8Array, prompt: string) =>
    dictation.transcribeSegment(Buffer.from(wav), prompt)
  )
  ipcMain.handle('dictation:preview', (_e, wav: Uint8Array, prompt: string) =>
    dictation.preview(Buffer.from(wav), prompt)
  )

  ipcMain.handle('rudud:search', (_e, query: string) => rudud.search(query))
  ipcMain.handle('rudud:status', () => ({ available: rudud.available, size: rudud.size }))

  ipcMain.handle('tools:buildUrl', (_e, toolId: string, query: string): string => {
    const tool = tools.get(toolId)
    return tool ? buildSearchUrl(tool, query) : ''
  })

  /**
   * Calibration: learn a site's search pattern from the page the user is looking at.
   * Returns the derived template, or null when the query is not visible in the URL.
   */
  ipcMain.handle(
    'tools:calibrate',
    async (_e, toolId: string, tabId: string, query: string): Promise<string | null> => {
      const url = views?.currentUrl(tabId) ?? ''
      const template = deriveSearchUrl(url, query)
      if (template) await tools.setSearchUrl(toolId, template)
      return template
    }
  )

  // ── embedded views ───────────────────────────────────────────────────────

  ipcMain.on('view:sync', (_e, request: SyncRequest) => views?.sync(request))
  ipcMain.on('view:bounds', (_e, bounds: Bounds) => views?.setBounds(bounds))
  ipcMain.on('view:navigate', (_e, tabId: string, url: string) => views?.navigate(tabId, url))
  ipcMain.on('view:close', (_e, tabId: string) => views?.closeTab(tabId))
  ipcMain.on('view:back', (_e, tabId: string) => views?.goBack(tabId))
  ipcMain.on('view:forward', (_e, tabId: string) => views?.goForward(tabId))
  ipcMain.on('view:reload', (_e, tabId: string) => views?.reload(tabId))
  ipcMain.on('view:stop', (_e, tabId: string) => views?.stop(tabId))
  ipcMain.on('view:find', (_e, tabId: string, text: string, forward: boolean, next: boolean) => {
    void views?.find(tabId, text, forward, next)
  })
  ipcMain.on('view:stopFind', (_e, tabId: string) => views?.stopFind(tabId))

  // ── copy pipeline ────────────────────────────────────────────────────────

  /** Asked synchronously by each page preload before it decides what to draw. */
  ipcMain.on('site:config', (event) => {
    const toolId = views?.toolIdFor(event.sender.id) ?? null
    const tool = toolId ? tools.get(toolId) : undefined
    event.returnValue = { copyOverlay: tool?.copyOverlay ?? true }
  })

  /**
   * An embedded page asking to copy something. Main owns the clipboard and is the only
   * side that can tell which tab the sending page belongs to.
   */
  ipcMain.on('site:copy', (event, payload: CopyRequest) => {
    const text = cleanCopiedText(payload.text ?? '')
    if (!text || !mainWindow || mainWindow.isDestroyed()) return

    const composed =
      payload.action === 'copy' ? text : withSource(text, payload.pageTitle ?? '', payload.url ?? '')
    if (payload.action !== 'to-draft') clipboard.writeText(composed)

    mainWindow.webContents.send('copy:event', {
      action: payload.action,
      tabId: views?.tabIdFor(event.sender.id) ?? null,
      text,
      pageTitle: payload.pageTitle ?? '',
      url: payload.url ?? ''
    })
  })

  /** Copying from the app's own chrome, where the renderer already has the text. */
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.handle('clipboard:read', () => clipboard.readText())
}

interface CopyRequest {
  action: 'copy' | 'copy-with-source' | 'to-draft'
  text: string
  pageTitle: string
  url: string
}

void app.whenReady().then(async () => {
  store = new WorkspaceStore(app.getPath('userData'))
  tools = new ToolRegistry(app.getPath('userData'), resourcePath('resources', 'tools.default.json'))
  await tools.load()

  // Dictation needs the microphone; embedded sites live in another partition and get
  // nothing. Without this Electron denies getUserMedia outright.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media' && contents === mainWindow?.webContents)
  })
  // Sites may write the clipboard so their own copy buttons work (issue #7) — Chromium only
  // grants it on a user gesture. Reading it, and everything else, stays denied.
  session.fromPartition('persist:sites').setPermissionRequestHandler((_c, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write')
  )

  const fakeTranscript = process.env.MU7_FAKE_WHISPER
  dictation = new Dictation(
    app.getPath('userData'),
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dictation:status', status)
      }
    },
    // A stand-in run has no server binary and must not depend on this machine's GPU.
    fakeTranscript
      ? { spawnImpl: fakeWhisperSpawn(fakeTranscript), useServer: false, detectGpu: async () => null }
      : {}
  )
  await dictation.refresh()

  rudud = new RududIndex()
  if (await rudud.load(resourcePath('resources', 'rudud.json'))) {
    console.log(`[rudud] indexed ${rudud.size} documents`)
  } else {
    console.warn('[rudud] no index found — run `npm run build:rudud`')
  }

  registerIpc()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  if (isSmoke && views) {
    await runSmoke(mainWindow, store, views)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Autosave is debounced, so the last few hundred ms of edits only survive if we flush here.
app.on('before-quit', (event) => {
  // No whisper-server may outlive the app; it would hold the model in memory for nothing.
  dictation?.dispose()
  if (!workspace) return
  event.preventDefault()
  workspace = null
  void store.flush().finally(() => app.quit())
})
