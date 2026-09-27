import { app, BrowserWindow, clipboard, ipcMain } from 'electron'
import path from 'node:path'
import { WorkspaceStore } from './store'
import { RududIndex } from './rududIndex'
import { ToolRegistry, buildSearchUrl, deriveSearchUrl } from './tools'
import { ViewManager, type Bounds, type SyncRequest, type ViewEvent } from './viewManager'
import { runSmoke } from './smoke'
import { cleanCopiedText, withSource } from '@shared/text'
import type { SearchTool, Workspace } from '@shared/types'

const isSmoke = process.env.MU7_SMOKE === '1'

let mainWindow: BrowserWindow | null = null
let store: WorkspaceStore
let tools: ToolRegistry
let rudud: RududIndex
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

  views = new ViewManager(win, path.join(__dirname, '../preload/site.js'), (event: ViewEvent) => {
    if (!win.isDestroyed()) win.webContents.send('view:event', event)
  })

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
  if (!workspace) return
  event.preventDefault()
  workspace = null
  void store.flush().finally(() => app.quit())
})
