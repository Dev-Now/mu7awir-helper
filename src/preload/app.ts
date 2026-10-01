import { contextBridge, ipcRenderer } from 'electron'
import type { SearchTool, Workspace } from '@shared/types'

interface DictationStatus {
  ready: boolean
  binaryPath: string | null
  modelPath: string | null
  progress: { what: string; received: number; total: number } | null
  error: string | null
  errorDetail: string | null
  gpu: string | null
  cudaInstalled: boolean
  backend: 'cuda' | 'cpu' | null
  backendDetail: string | null
}

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

  searchRudud: (query: string): Promise<unknown> => ipcRenderer.invoke('rudud:search', query),
  rududStatus: (): Promise<{ available: boolean; size: number }> =>
    ipcRenderer.invoke('rudud:status'),

  dictationStatus: (): Promise<DictationStatus> => ipcRenderer.invoke('dictation:status'),
  installDictation: (): Promise<DictationStatus> => ipcRenderer.invoke('dictation:install'),
  transcribe: (wav: Uint8Array): Promise<string> => ipcRenderer.invoke('dictation:transcribe', wav),
  /** Start the resident model so it is loaded by the time the first phrase is ready. */
  warmDictation: (): Promise<void> => ipcRenderer.invoke('dictation:warm'),
  transcribeSegment: (wav: Uint8Array, prompt: string): Promise<string> =>
    ipcRenderer.invoke('dictation:segment', wav, prompt),
  /** Null when the model is busy with real phrases or no resident model is running. */
  previewSegment: (wav: Uint8Array, prompt: string): Promise<string | null> =>
    ipcRenderer.invoke('dictation:preview', wav, prompt),
  onDictationStatus: (handler: (status: DictationStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: DictationStatus): void => handler(status)
    ipcRenderer.on('dictation:status', listener)
    return () => ipcRenderer.removeListener('dictation:status', listener)
  },

  listShortcuts: (): Promise<Array<{ id: string; accelerator: string; description: string }>> =>
    ipcRenderer.invoke('shortcuts:list'),
  setToolSearchUrl: (toolId: string, searchUrl: string | null): Promise<SearchTool[]> =>
    ipcRenderer.invoke('tools:setSearchUrl', toolId, searchUrl),
  onShortcut: (handler: (message: unknown) => void): (() => void) => {
    const listener = (_e: unknown, message: unknown): void => handler(message)
    ipcRenderer.on('shortcut', listener)
    return () => ipcRenderer.removeListener('shortcut', listener)
  },
  onDictationKey: (handler: (edge: 'down' | 'up') => void): (() => void) => {
    const listener = (_e: unknown, edge: 'down' | 'up'): void => handler(edge)
    ipcRenderer.on('shortcut:dictation', listener)
    return () => ipcRenderer.removeListener('shortcut:dictation', listener)
  },

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
