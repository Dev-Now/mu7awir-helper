import type { AppApi } from './app'

declare global {
  interface Window {
    api: AppApi
    /** Test/debug hook used by the smoke harness; see src/renderer/testHook.ts. */
    __mu7: {
      ready: boolean
      getWorkspace: () => import('@shared/types').Workspace
      getNav: () => Record<string, unknown>
      getFind: () => unknown
      getTools: () => import('@shared/types').SearchTool[]
      actions: Record<string, (...args: never[]) => unknown>
      flush: () => Promise<void>
    }
  }
}

export {}
