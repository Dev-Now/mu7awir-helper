import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { WorkspaceStore } from './store'
import { runSmoke } from './smoke'
import type { Workspace } from '@shared/types'

const isSmoke = process.env.MU7_SMOKE === '1'

let mainWindow: BrowserWindow | null = null
let store: WorkspaceStore

/** Main keeps a mirror of the renderer's state so it can flush on quit. */
let workspace: Workspace | null = null

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

  win.once('ready-to-show', () => {
    // Smoke runs stay hidden unless they are going to screenshot the result.
    if (!isSmoke || process.env.MU7_SMOKE_SHOT) win.show()
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
}

void app.whenReady().then(async () => {
  store = new WorkspaceStore(app.getPath('userData'))
  registerIpc()
  mainWindow = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })

  if (isSmoke) {
    await runSmoke(mainWindow, store)
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
