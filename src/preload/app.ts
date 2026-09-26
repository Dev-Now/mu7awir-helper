import { contextBridge, ipcRenderer } from 'electron'
import type { Workspace } from '@shared/types'

/** The renderer's only channel to the main process. */
const api = {
  loadWorkspace: (): Promise<Workspace> => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (ws: Workspace): void => ipcRenderer.send('workspace:save', ws),
  flushWorkspace: (): Promise<void> => ipcRenderer.invoke('workspace:flush')
}

export type AppApi = typeof api

contextBridge.exposeInMainWorld('api', api)
