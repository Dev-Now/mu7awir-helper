/**
 * Pure, immutable operations over the workspace tree.
 *
 * Everything the UI does to discussions, tabs and drafts goes through this module so the
 * behaviour is testable without React or Electron. The renderer's zustand store is a thin
 * wrapper; the main process persists whatever comes out.
 */
import {
  WORKSPACE_VERSION,
  type Discussion,
  type DraftTab,
  type SearchTab,
  type Settings,
  type Source,
  type Tab,
  type TabKind,
  type Workspace
} from './types'

export const MIN_SPLIT_RATIO = 0.2
export const MAX_SPLIT_RATIO = 0.85

export function newId(): string {
  return globalThis.crypto.randomUUID()
}

function nowIso(): string {
  return new Date().toISOString()
}

export function defaultSettings(): Settings {
  return { splitRatio: 2 / 3, sidebarCollapsed: false, appendSources: true, showArchived: false }
}

export function defaultWorkspace(): Workspace {
  return {
    version: WORKSPACE_VERSION,
    discussions: [],
    activeDiscussionId: null,
    settings: defaultSettings()
  }
}

// ── lookups ──────────────────────────────────────────────────────────────────

export function findDiscussion(ws: Workspace, id: string | null): Discussion | null {
  if (!id) return null
  return ws.discussions.find((d) => d.id === id) ?? null
}

export function activeDiscussion(ws: Workspace): Discussion | null {
  return findDiscussion(ws, ws.activeDiscussionId)
}

/** Discussions shown in the sidebar, honouring the archive filter. */
export function visibleDiscussions(ws: Workspace): Discussion[] {
  return ws.settings.showArchived ? ws.discussions : ws.discussions.filter((d) => !d.archived)
}

export function tabsOfKind(d: Discussion, kind: 'search'): SearchTab[]
export function tabsOfKind(d: Discussion, kind: 'draft'): DraftTab[]
export function tabsOfKind(d: Discussion, kind: TabKind): Tab[]
export function tabsOfKind(d: Discussion, kind: TabKind): Tab[] {
  return d.tabs.filter((t) => t.kind === kind)
}

export function activeTabId(d: Discussion, kind: TabKind): string | null {
  return kind === 'search' ? d.activeSearchTabId : d.activeDraftTabId
}

export function activeTab(d: Discussion, kind: 'search'): SearchTab | null
export function activeTab(d: Discussion, kind: 'draft'): DraftTab | null
export function activeTab(d: Discussion, kind: TabKind): Tab | null {
  const id = activeTabId(d, kind)
  if (!id) return null
  return d.tabs.find((t) => t.id === id && t.kind === kind) ?? null
}

export function findTab(ws: Workspace, discussionId: string, tabId: string): Tab | null {
  return findDiscussion(ws, discussionId)?.tabs.find((t) => t.id === tabId) ?? null
}

// ── internals ────────────────────────────────────────────────────────────────

/** Apply `fn` to one discussion, bumping its `updatedAt`. Unknown ids are a no-op. */
function mapDiscussion(
  ws: Workspace,
  id: string,
  fn: (d: Discussion) => Discussion
): Workspace {
  let changed = false
  const discussions = ws.discussions.map((d) => {
    if (d.id !== id) return d
    changed = true
    return { ...fn(d), updatedAt: nowIso() }
  })
  return changed ? { ...ws, discussions } : ws
}

function setActiveTab(d: Discussion, kind: TabKind, tabId: string | null): Discussion {
  return kind === 'search'
    ? { ...d, activeSearchTabId: tabId }
    : { ...d, activeDraftTabId: tabId }
}

/** After removing `index` from `list`, which id should take focus? */
function neighbourId(list: Tab[], index: number): string | null {
  return list[index + 1]?.id ?? list[index - 1]?.id ?? null
}

// ── discussions ──────────────────────────────────────────────────────────────

export function createDiscussion(ws: Workspace, title: string): Workspace {
  const at = nowIso()
  const discussion: Discussion = {
    id: newId(),
    title: title.trim() || 'مناقشة جديدة',
    createdAt: at,
    updatedAt: at,
    archived: false,
    tabs: [],
    activeSearchTabId: null,
    activeDraftTabId: null
  }
  return {
    ...ws,
    discussions: [...ws.discussions, discussion],
    activeDiscussionId: discussion.id
  }
}

export function renameDiscussion(ws: Workspace, id: string, title: string): Workspace {
  const trimmed = title.trim()
  if (!trimmed) return ws
  return mapDiscussion(ws, id, (d) => ({ ...d, title: trimmed }))
}

export function setDiscussionArchived(ws: Workspace, id: string, archived: boolean): Workspace {
  const next = mapDiscussion(ws, id, (d) => ({ ...d, archived }))
  if (next === ws) return ws
  // Archiving the selected discussion hands focus to something still visible.
  if (archived && next.activeDiscussionId === id && !next.settings.showArchived) {
    const fallback = visibleDiscussions(next)[0] ?? null
    return { ...next, activeDiscussionId: fallback?.id ?? null }
  }
  return next
}

export function deleteDiscussion(ws: Workspace, id: string): Workspace {
  const index = ws.discussions.findIndex((d) => d.id === id)
  if (index === -1) return ws
  const discussions = ws.discussions.filter((d) => d.id !== id)
  const activeDiscussionId =
    ws.activeDiscussionId === id
      ? (discussions[index] ?? discussions[index - 1] ?? null)?.id ?? null
      : ws.activeDiscussionId
  return { ...ws, discussions, activeDiscussionId }
}

export function selectDiscussion(ws: Workspace, id: string): Workspace {
  if (!findDiscussion(ws, id)) return ws
  return { ...ws, activeDiscussionId: id }
}

/** Browser-tab style navigation across the visible discussions, wrapping at both ends. */
export function cycleDiscussion(ws: Workspace, delta: number): Workspace {
  const list = visibleDiscussions(ws)
  if (list.length === 0) return ws
  const current = list.findIndex((d) => d.id === ws.activeDiscussionId)
  const from = current === -1 ? (delta > 0 ? -1 : 0) : current
  const next = (((from + delta) % list.length) + list.length) % list.length
  return { ...ws, activeDiscussionId: list[next].id }
}

// ── tabs ─────────────────────────────────────────────────────────────────────

export function addSearchTab(
  ws: Workspace,
  discussionId: string,
  init: { toolId: string; title: string; query?: string; url?: string }
): Workspace {
  const tab: SearchTab = {
    id: newId(),
    kind: 'search',
    title: init.title,
    toolId: init.toolId,
    query: init.query ?? '',
    url: init.url ?? '',
    createdAt: nowIso()
  }
  return mapDiscussion(ws, discussionId, (d) => ({
    ...d,
    tabs: [...d.tabs, tab],
    activeSearchTabId: tab.id
  }))
}

export function addDraftTab(ws: Workspace, discussionId: string, title?: string): Workspace {
  const at = nowIso()
  const existing = findDiscussion(ws, discussionId)
    ? tabsOfKind(findDiscussion(ws, discussionId)!, 'draft').length
    : 0
  const tab: DraftTab = {
    id: newId(),
    kind: 'draft',
    title: title?.trim() || `رد ${existing + 1}`,
    content: '',
    sources: [],
    createdAt: at,
    updatedAt: at
  }
  return mapDiscussion(ws, discussionId, (d) => ({
    ...d,
    tabs: [...d.tabs, tab],
    activeDraftTabId: tab.id
  }))
}

export function closeTab(ws: Workspace, discussionId: string, tabId: string): Workspace {
  return mapDiscussion(ws, discussionId, (d) => {
    const tab = d.tabs.find((t) => t.id === tabId)
    if (!tab) return d
    const sameKind = tabsOfKind(d, tab.kind)
    const index = sameKind.findIndex((t) => t.id === tabId)
    const next: Discussion = { ...d, tabs: d.tabs.filter((t) => t.id !== tabId) }
    if (activeTabId(d, tab.kind) !== tabId) return next
    return setActiveTab(next, tab.kind, neighbourId(sameKind, index))
  })
}

export function renameTab(
  ws: Workspace,
  discussionId: string,
  tabId: string,
  title: string
): Workspace {
  const trimmed = title.trim()
  if (!trimmed) return ws
  return mapDiscussion(ws, discussionId, (d) => ({
    ...d,
    tabs: d.tabs.map((t) => (t.id === tabId ? { ...t, title: trimmed } : t))
  }))
}

export function selectTab(ws: Workspace, discussionId: string, tabId: string): Workspace {
  return mapDiscussion(ws, discussionId, (d) => {
    const tab = d.tabs.find((t) => t.id === tabId)
    return tab ? setActiveTab(d, tab.kind, tab.id) : d
  })
}

/** Next/previous within one kind of tab, wrapping at both ends. */
export function cycleTab(
  ws: Workspace,
  discussionId: string,
  kind: TabKind,
  delta: number
): Workspace {
  return mapDiscussion(ws, discussionId, (d) => {
    const list = tabsOfKind(d, kind)
    if (list.length === 0) return d
    const current = list.findIndex((t) => t.id === activeTabId(d, kind))
    const from = current === -1 ? (delta > 0 ? -1 : 0) : current
    const next = (((from + delta) % list.length) + list.length) % list.length
    return setActiveTab(d, kind, list[next].id)
  })
}

export function jumpTab(
  ws: Workspace,
  discussionId: string,
  kind: TabKind,
  edge: 'first' | 'last'
): Workspace {
  return mapDiscussion(ws, discussionId, (d) => {
    const list = tabsOfKind(d, kind)
    if (list.length === 0) return d
    return setActiveTab(d, kind, (edge === 'first' ? list[0] : list[list.length - 1]).id)
  })
}

// ── tab contents ─────────────────────────────────────────────────────────────

function mapTab<T extends Tab>(
  ws: Workspace,
  discussionId: string,
  tabId: string,
  kind: T['kind'],
  fn: (t: T) => T
): Workspace {
  return mapDiscussion(ws, discussionId, (d) => ({
    ...d,
    tabs: d.tabs.map((t) => (t.id === tabId && t.kind === kind ? fn(t as T) : t))
  }))
}

/** Record where a search tab actually navigated, so it can be restored verbatim. */
export function setSearchTabLocation(
  ws: Workspace,
  discussionId: string,
  tabId: string,
  url: string,
  query?: string
): Workspace {
  return mapTab<SearchTab>(ws, discussionId, tabId, 'search', (t) => ({
    ...t,
    url,
    query: query ?? t.query
  }))
}

export function setDraftContent(
  ws: Workspace,
  discussionId: string,
  tabId: string,
  content: string
): Workspace {
  return mapTab<DraftTab>(ws, discussionId, tabId, 'draft', (t) =>
    t.content === content ? t : { ...t, content, updatedAt: nowIso() }
  )
}

/** Append copied material to a draft, separated by a blank line, recording its source. */
export function appendToDraft(
  ws: Workspace,
  discussionId: string,
  tabId: string,
  text: string,
  source?: Source
): Workspace {
  const addition = text.trim()
  if (!addition) return ws
  return mapTab<DraftTab>(ws, discussionId, tabId, 'draft', (t) => ({
    ...t,
    content: t.content.trim() ? `${t.content.replace(/\s+$/, '')}\n\n${addition}` : addition,
    sources: source ? [...t.sources, source] : t.sources,
    updatedAt: nowIso()
  }))
}

/**
 * Append to whichever draft is in focus, opening one if the discussion has none.
 * This is what Ctrl+Enter lands on, so it must never be a dead end.
 */
export function appendToActiveDraft(
  ws: Workspace,
  discussionId: string,
  text: string,
  source?: Source
): Workspace {
  if (!text.trim()) return ws
  const discussion = findDiscussion(ws, discussionId)
  if (!discussion) return ws

  const next = activeTab(discussion, 'draft') ? ws : addDraftTab(ws, discussionId)
  const target = activeTab(findDiscussion(next, discussionId)!, 'draft')
  return target ? appendToDraft(next, discussionId, target.id, text, source) : ws
}

// ── settings ─────────────────────────────────────────────────────────────────

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return defaultSettings().splitRatio
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio))
}

export function updateSettings(ws: Workspace, patch: Partial<Settings>): Workspace {
  const settings = { ...ws.settings, ...patch }
  if (patch.splitRatio !== undefined) settings.splitRatio = clampSplitRatio(patch.splitRatio)
  return { ...ws, settings }
}
