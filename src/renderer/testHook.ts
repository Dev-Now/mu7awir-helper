import { useApp } from './state/store'

/**
 * Exposes the store to the smoke harness (and to the devtools console) on `window.__mu7`.
 * Safe to ship: only the app's own renderer origin can reach it — embedded sites run in
 * separate, sandboxed WebContentsViews with their own context.
 */
export function installTestHook(): void {
  window.__mu7 = {
    ready: true,
    getWorkspace: () => useApp.getState().workspace,
    getNav: () => useApp.getState().nav,
    getFind: () => useApp.getState().find,
    getTools: () => useApp.getState().tools,
    readClipboard: () => window.api.readClipboard(),
    rududStatus: () => window.api.rududStatus(),
    getUi: () => useApp.getState().ui as unknown as Record<string, unknown>,
    actions: useApp.getState() as unknown as Record<string, (...args: never[]) => unknown>,
    flush: () => window.api.flushWorkspace()
  }
}
