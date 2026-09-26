import { create } from 'zustand'
import type { Settings, Source, TabKind, Workspace } from '@shared/types'
import * as W from '@shared/workspace'

/**
 * The renderer owns the authoritative workspace. Every mutation runs a pure reducer from
 * `@shared/workspace` and then pushes the whole document to main, which debounces the write.
 */
interface AppState {
  workspace: Workspace
  loaded: boolean

  hydrate: () => Promise<void>
  /** Run a reducer over the workspace and persist the result. */
  apply: (fn: (ws: Workspace) => Workspace) => void
  /** Same, scoped to the active discussion; a no-op when nothing is selected. */
  applyToActive: (fn: (ws: Workspace, discussionId: string) => Workspace) => void

  createDiscussion: (title: string) => void
  renameDiscussion: (id: string, title: string) => void
  setDiscussionArchived: (id: string, archived: boolean) => void
  deleteDiscussion: (id: string) => void
  selectDiscussion: (id: string) => void
  cycleDiscussion: (delta: number) => void

  addSearchTab: (init: { toolId: string; title: string; query?: string; url?: string }) => void
  addDraftTab: (title?: string) => void
  closeTab: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  selectTab: (tabId: string) => void
  cycleTab: (kind: TabKind, delta: number) => void
  jumpTab: (kind: TabKind, edge: 'first' | 'last') => void

  setSearchTabLocation: (tabId: string, url: string, query?: string) => void
  setDraftContent: (tabId: string, content: string) => void
  appendToDraft: (tabId: string, text: string, source?: Source) => void

  updateSettings: (patch: Partial<Settings>) => void
}

export const useApp = create<AppState>((set, get) => ({
  workspace: W.defaultWorkspace(),
  loaded: false,

  hydrate: async () => {
    const workspace = await window.api.loadWorkspace()
    set({ workspace, loaded: true })
  },

  apply: (fn) => {
    const next = fn(get().workspace)
    if (next === get().workspace) return
    set({ workspace: next })
    window.api.saveWorkspace(next)
  },

  applyToActive: (fn) => {
    const id = get().workspace.activeDiscussionId
    if (!id) return
    get().apply((ws) => fn(ws, id))
  },

  createDiscussion: (title) => get().apply((ws) => W.createDiscussion(ws, title)),
  renameDiscussion: (id, title) => get().apply((ws) => W.renameDiscussion(ws, id, title)),
  setDiscussionArchived: (id, archived) =>
    get().apply((ws) => W.setDiscussionArchived(ws, id, archived)),
  deleteDiscussion: (id) => get().apply((ws) => W.deleteDiscussion(ws, id)),
  selectDiscussion: (id) => get().apply((ws) => W.selectDiscussion(ws, id)),
  cycleDiscussion: (delta) => get().apply((ws) => W.cycleDiscussion(ws, delta)),

  addSearchTab: (init) => get().applyToActive((ws, d) => W.addSearchTab(ws, d, init)),
  addDraftTab: (title) => get().applyToActive((ws, d) => W.addDraftTab(ws, d, title)),
  closeTab: (tabId) => get().applyToActive((ws, d) => W.closeTab(ws, d, tabId)),
  renameTab: (tabId, title) => get().applyToActive((ws, d) => W.renameTab(ws, d, tabId, title)),
  selectTab: (tabId) => get().applyToActive((ws, d) => W.selectTab(ws, d, tabId)),
  cycleTab: (kind, delta) => get().applyToActive((ws, d) => W.cycleTab(ws, d, kind, delta)),
  jumpTab: (kind, edge) => get().applyToActive((ws, d) => W.jumpTab(ws, d, kind, edge)),

  setSearchTabLocation: (tabId, url, query) =>
    get().applyToActive((ws, d) => W.setSearchTabLocation(ws, d, tabId, url, query)),
  setDraftContent: (tabId, content) =>
    get().applyToActive((ws, d) => W.setDraftContent(ws, d, tabId, content)),
  appendToDraft: (tabId, text, source) =>
    get().applyToActive((ws, d) => W.appendToDraft(ws, d, tabId, text, source)),

  updateSettings: (patch) => get().apply((ws) => W.updateSettings(ws, patch))
}))

/** Selector helpers, so components do not re-derive the same lookups. */
export const selectActiveDiscussion = (s: AppState) => W.activeDiscussion(s.workspace)
export const selectVisibleDiscussions = (s: AppState) => W.visibleDiscussions(s.workspace)
