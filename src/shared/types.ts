export const WORKSPACE_VERSION = 1

export type TabKind = 'search' | 'draft'

/** A configured search tool. `web` tools load a URL in a WebContentsView; `local` tools render in-app. */
export interface SearchTool {
  id: string
  label: string
  shortcut: string
  type: 'web' | 'local'
  /** Loaded when there is no query, or when `searchUrl` is null. */
  homeUrl: string
  /** URL template with a `{q}` placeholder, or null when the site's pattern is not known yet. */
  searchUrl: string | null
  enabled: boolean
  /**
   * Draw the hover copy button over the page. Off for sites whose own copy tools are good
   * enough, so the page is shown as-is. The selection shortcuts work either way.
   */
  copyOverlay: boolean
}

/** An excerpt copied out of a search view, kept for attribution. */
export interface Source {
  text: string
  pageTitle: string
  url: string
  at: string
}

export interface SearchTab {
  id: string
  kind: 'search'
  title: string
  toolId: string
  query: string
  /** Last committed URL, restored when the tab is reopened. */
  url: string
  createdAt: string
}

export interface DraftTab {
  id: string
  kind: 'draft'
  title: string
  content: string
  sources: Source[]
  createdAt: string
  updatedAt: string
}

export type Tab = SearchTab | DraftTab

export interface Discussion {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archived: boolean
  /** One ordered list; each tab carries its own kind. */
  tabs: Tab[]
  activeSearchTabId: string | null
  activeDraftTabId: string | null
}

export interface Settings {
  /** Fraction of the content height given to the search pane. */
  splitRatio: number
  sidebarCollapsed: boolean
  /** Append collected sources as a footnote block when copying a whole draft. */
  appendSources: boolean
  showArchived: boolean
}

export interface Workspace {
  version: typeof WORKSPACE_VERSION
  discussions: Discussion[]
  activeDiscussionId: string | null
  settings: Settings
}
