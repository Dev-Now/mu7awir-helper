import { contextBridge, ipcRenderer } from 'electron'
import type { SearchTool, Workspace } from '@shared/types'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

interface SyncRequest {
  tabId: string | null
  initialUrl: string
  bounds: Bounds | null
  visible: boolean
}

/** The renderer's only channel to the main process. */
const api = {
  loadWorkspace: (): Promise<Workspace> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (ws: Workspace): void => ipcRenderer.send('workspace:save', ws),
  flushWorkspace: (): Promise<void> => ipcRenderer.invoke('workspace:flush'),

  listTools: (): Promise<SearchTool[]> => ipcRenderer.invoke('tools:list'),
  buildSearchUrl: (toolId: string, query: string): Promise<string> =>
    ipcRenderer.invoke('tools:buildUrl', toolId, query),
  calibrateTool: (toolId: string, tabId: string, query: string): Promise<string | null> =>
    ipcRenderer.invoke('tools:calibrate', toolId, tabId, query),

  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),

  /** Copy requests originating inside an embedded page. */
  onCopy: (handler: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => handler(payload)
    ipcRenderer.on('copy:event', listener)
    return () => ipcRenderer.removeListener('copy:event', listener)
  },

  view: {
    sync: (request: SyncRequest): void => ipcRenderer.send('view:sync', request),
    bounds: (bounds: Bounds): void => ipcRenderer.send('view:bounds', bounds),
    navigate: (tabId: string, url: string): void => ipcRenderer.send('view:navigate', tabId, url),
    close: (tabId: string): void => ipcRenderer.send('view:close', tabId),
    back: (tabId: string): void => ipcRenderer.send('view:back', tabId),
    forward: (tabId: string): void => ipcRenderer.send('view:forward', tabId),
    reload: (tabId: string): void => ipcRenderer.send('view:reload', tabId),
    stop: (tabId: string): void => ipcRenderer.send('view:stop', tabId),
    find: (tabId: string, text: string, forward = true, findNext = false): void =>
      ipcRenderer.send('view:find', tabId, text, forward, findNext),
    stopFind: (tabId: string): void => ipcRenderer.send('view:stopFind', tabId),
    /** Navigation, find-in-page and popup notifications from the embedded views. */
    onEvent: (handler: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('view:event', listener)
      return () => ipcRenderer.removeListener('view:event', listener)
    }
  }
}

export type AppApi = typeof api

contextBridge.exposeInMainWorld('api', api)
