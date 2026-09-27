/**
 * Owns one `WebContentsView` per search tab.
 *
 * The views are OS-level overlays stacked on top of the React window, so the renderer
 * measures the search pane and pushes a rectangle here; nothing about their geometry is
 * derived from the split ratio. Only one view is ever attached at a time — hiding is done
 * by detaching from the window rather than resizing to zero, which also keeps modals and
 * overlays in the renderer from being painted over.
 */
import { WebContentsView, session, type BrowserWindow, type WebContents } from 'electron'

/** Some sites serve degraded pages to the Electron UA. */
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Shared, persistent partition so logins and site preferences survive restarts. */
const PARTITION = 'persist:sites'
/** Beyond this, the least recently used tabs are hibernated down to their URL. */
const MAX_LIVE_VIEWS = 8

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NavState {
  tabId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export type ViewEvent =
  | ({ type: 'nav' } & NavState)
  | { type: 'found'; tabId: string; matches: number; activeMatchOrdinal: number }
  | { type: 'popup'; tabId: string; url: string }

interface Entry {
  view: WebContentsView
  attached: boolean
  lastUsed: number
}

export interface SyncRequest {
  /** The search tab to display, or null to show nothing. */
  tabId: string | null
  /** Used only when the view is created or woken from hibernation. */
  initialUrl: string
  bounds: Bounds | null
  /** False while an overlay covers the pane, or when a local tool is active. */
  visible: boolean
}

export class ViewManager {
  private readonly entries = new Map<string, Entry>()
  /** Tabs whose view was evicted, remembered by their last URL. */
  private readonly hibernated = new Map<string, string>()
  /** Per-tab find bar state, since the match count is computed rather than reported. */
  private readonly findState = new Map<string, { text: string; ordinal: number }>()
  private bounds: Bounds | null = null
  private activeTabId: string | null = null
  private clock = 0
  private uaApplied = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly preload: string,
    private readonly emit: (event: ViewEvent) => void,
    /** Called for every key pressed inside an embedded page, so app shortcuts survive
     *  focus moving into a search view. */
    private readonly onBeforeInput?: (
      event: Electron.Event,
      input: Electron.Input,
      wc: WebContents
    ) => void
  ) {}

  // ── presentation ───────────────────────────────────────────────────────────

  sync(request: SyncRequest): void {
    if (request.bounds) this.bounds = request.bounds

    if (!request.tabId || !request.visible) {
      this.detachAll()
      this.activeTabId = request.tabId
      return
    }

    const entry = this.ensure(request.tabId, request.initialUrl)
    this.activeTabId = request.tabId
    entry.lastUsed = ++this.clock

    for (const [id, other] of this.entries) {
      if (id !== request.tabId) this.detach(other)
    }
    this.attach(entry)
    this.applyBounds(entry)
    this.evictExcess()
  }

  /** Re-apply the current rectangle; called on every renderer-side layout change. */
  setBounds(bounds: Bounds): void {
    this.bounds = bounds
    const entry = this.activeTabId ? this.entries.get(this.activeTabId) : undefined
    if (entry?.attached) this.applyBounds(entry)
  }

  private applyBounds(entry: Entry): void {
    if (!this.bounds || entry.view.webContents.isDestroyed()) return
    const { x, y, width, height } = this.bounds
    entry.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height))
    })
  }

  private attach(entry: Entry): void {
    if (entry.attached) return
    this.win.contentView.addChildView(entry.view)
    entry.attached = true
  }

  private detach(entry: Entry): void {
    if (!entry.attached) return
    this.win.contentView.removeChildView(entry.view)
    entry.attached = false
  }

  private detachAll(): void {
    for (const entry of this.entries.values()) this.detach(entry)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  private ensure(tabId: string, initialUrl: string): Entry {
    const existing = this.entries.get(tabId)
    if (existing && !existing.view.webContents.isDestroyed()) return existing

    const view = this.create(tabId)
    const entry: Entry = { view, attached: false, lastUsed: ++this.clock }
    this.entries.set(tabId, entry)

    // A woken tab returns to where it was, not to the tab's original URL.
    const url = this.hibernated.get(tabId) ?? initialUrl
    this.hibernated.delete(tabId)
    if (url) void view.webContents.loadURL(url).catch(() => {})
    return entry
  }

  private create(tabId: string): WebContentsView {
    if (!this.uaApplied) {
      session.fromPartition(PARTITION).setUserAgent(CHROME_UA)
      this.uaApplied = true
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION,
        webviewTag: false
      }
    })
    view.setBackgroundColor('#ffffff')
    this.wire(tabId, view.webContents)
    return view
  }

  private wire(tabId: string, wc: WebContents): void {
    const report = (): void => {
      if (wc.isDestroyed()) return
      this.emit({
        type: 'nav',
        tabId,
        url: wc.getURL(),
        title: wc.getTitle(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        loading: wc.isLoading()
      })
    }

    // Listed one by one: the overloads on `WebContents.on` do not unify over a loop.
    wc.on('did-navigate', report)
    wc.on('did-navigate-in-page', report)
    wc.on('did-start-loading', report)
    wc.on('did-stop-loading', report)
    wc.on('did-finish-load', report)
    wc.on('page-title-updated', report)

    if (this.onBeforeInput) {
      wc.on('before-input-event', (event, input) => this.onBeforeInput!(event, input, wc))
    }

    // No `found-in-page` listener here on purpose — see `find()`.

    // Popups become app tabs instead of detached browser windows.
    wc.setWindowOpenHandler(({ url }) => {
      this.emit({ type: 'popup', tabId, url })
      return { action: 'deny' }
    })
  }

  /** Hibernate the least recently used views once too many are alive at once. */
  private evictExcess(): void {
    if (this.entries.size <= MAX_LIVE_VIEWS) return
    const byAge = [...this.entries.entries()]
      .filter(([id]) => id !== this.activeTabId)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)

    for (const [id, entry] of byAge) {
      if (this.entries.size <= MAX_LIVE_VIEWS) break
      this.hibernated.set(id, entry.view.webContents.getURL())
      this.destroy(id, entry)
    }
  }

  closeTab(tabId: string): void {
    const entry = this.entries.get(tabId)
    this.hibernated.delete(tabId)
    if (entry) this.destroy(tabId, entry)
    if (this.activeTabId === tabId) this.activeTabId = null
  }

  private destroy(tabId: string, entry: Entry): void {
    this.findState.delete(tabId)
    this.detach(entry)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    this.entries.delete(tabId)
  }

  destroyAll(): void {
    for (const [id, entry] of [...this.entries]) this.destroy(id, entry)
  }

  // ── navigation ─────────────────────────────────────────────────────────────

  private contents(tabId: string): WebContents | null {
    const entry = this.entries.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed()) return null
    return entry.view.webContents
  }

  navigate(tabId: string, url: string): void {
    const wc = this.contents(tabId)
    if (wc && url) void wc.loadURL(url).catch(() => {})
  }

  goBack(tabId: string): void {
    const wc = this.contents(tabId)
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  goForward(tabId: string): void {
    const wc = this.contents(tabId)
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(tabId: string): void {
    this.contents(tabId)?.reload()
  }

  stop(tabId: string): void {
    this.contents(tabId)?.stop()
  }

  /**
   * Embedded views have no Chrome find bar, so the app supplies one.
   *
   * Chromium does the highlighting and the next/previous stepping, but Electron does not
   * emit `found-in-page` for a `WebContentsView` — verified against Electron 38: the same
   * call on a BrowserWindow's own webContents emits, the view's never does, even though
   * the matches are highlighted. So the match count is computed here instead and the
   * active ordinal is tracked across calls.
   */
  async find(tabId: string, text: string, forward = true, findNext = false): Promise<void> {
    const wc = this.contents(tabId)
    if (!wc) return

    if (!text) {
      wc.stopFindInPage('clearSelection')
      this.findState.delete(tabId)
      this.emit({ type: 'found', tabId, matches: 0, activeMatchOrdinal: 0 })
      return
    }

    wc.findInPage(text, { forward, findNext })

    const previous = this.findState.get(tabId)
    const matches = await this.countMatches(wc, text)
    let ordinal = matches > 0 ? 1 : 0
    if (matches > 0 && findNext && previous?.text === text) {
      ordinal = forward
        ? (previous.ordinal % matches) + 1
        : ((previous.ordinal - 2 + matches) % matches) + 1
    }

    this.findState.set(tabId, { text, ordinal })
    this.emit({ type: 'found', tabId, matches, activeMatchOrdinal: ordinal })
  }

  /** Count visible occurrences the way the find bar reports them. */
  private async countMatches(wc: WebContents, text: string): Promise<number> {
    try {
      return await wc.executeJavaScript(
        `(() => {
           const haystack = (document.body ? document.body.innerText : '').toLowerCase()
           const needle = ${JSON.stringify(text)}.toLowerCase()
           if (!needle) return 0
           let count = 0
           let at = haystack.indexOf(needle)
           while (at !== -1) {
             count++
             at = haystack.indexOf(needle, at + needle.length)
           }
           return count
         })()`,
        true
      )
    } catch {
      return 0
    }
  }

  stopFind(tabId: string): void {
    this.contents(tabId)?.stopFindInPage('clearSelection')
    this.findState.delete(tabId)
  }

  /** Which tab a message came from, resolved by the sending webContents id. */
  tabIdFor(webContentsId: number): string | null {
    for (const [id, entry] of this.entries) {
      if (!entry.view.webContents.isDestroyed() && entry.view.webContents.id === webContentsId) {
        return id
      }
    }
    return null
  }

  /** Current URL of a live view, used by the calibration flow. */
  currentUrl(tabId: string): string {
    return this.contents(tabId)?.getURL() ?? ''
  }

  /** The attached view's own contents, so the smoke run can screenshot the embedded page. */
  attachedContents(): WebContents | null {
    const entry = this.activeTabId ? this.entries.get(this.activeTabId) : undefined
    return entry?.attached ? this.contents(this.activeTabId!) : null
  }

  /** Introspection for the smoke harness: what main believes is on screen. */
  debugState(): {
    activeTabId: string | null
    attached: string[]
    live: string[]
    hibernated: string[]
    bounds: Bounds | null
  } {
    return {
      activeTabId: this.activeTabId,
      attached: [...this.entries].filter(([, e]) => e.attached).map(([id]) => id),
      live: [...this.entries.keys()],
      hibernated: [...this.hibernated.keys()],
      bounds: this.bounds
    }
  }
}
