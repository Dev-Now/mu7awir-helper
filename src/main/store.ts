/**
 * Workspace persistence.
 *
 * The renderer owns the authoritative state and pushes the whole workspace on every change;
 * this module debounces those pushes and writes them atomically. The file is small (a few
 * dozen discussions of plain text), so whole-document saves stay cheap and the result is a
 * human-readable file the user can back up or inspect.
 *
 * Deliberately free of Electron imports so it can be unit-tested against a temp directory.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WORKSPACE_VERSION, type Discussion, type Settings, type Source, type Tab, type Workspace } from '@shared/types'
import { clampSplitRatio, defaultSettings, defaultWorkspace } from '@shared/workspace'

export const WORKSPACE_FILE = 'workspace.json'
const TEMP_FILE = 'workspace.tmp'
const BACKUP_COUNT = 5
const DEFAULT_DEBOUNCE_MS = 500
/** Backups capture recovery points, not every keystroke, so they rotate on a timer. */
const DEFAULT_BACKUP_INTERVAL_MS = 5 * 60 * 1000

export interface StoreOptions {
  debounceMs?: number
  backupIntervalMs?: number
  /** Surfaced so a failing disk does not die silently inside the debounce timer. */
  onError?: (err: unknown) => void
}

// ── validation ───────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

function sanitizeSource(raw: unknown): Source | null {
  if (!isObject(raw)) return null
  const text = str(raw.text)
  if (!text) return null
  return { text, pageTitle: str(raw.pageTitle), url: str(raw.url), at: str(raw.at) }
}

function sanitizeTab(raw: unknown): Tab | null {
  if (!isObject(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const createdAt = str(raw.createdAt)
  if (raw.kind === 'search') {
    const toolId = str(raw.toolId)
    if (!toolId) return null
    return {
      id,
      kind: 'search',
      title: str(raw.title, toolId),
      toolId,
      query: str(raw.query),
      url: str(raw.url),
      createdAt
    }
  }
  if (raw.kind === 'draft') {
    return {
      id,
      kind: 'draft',
      title: str(raw.title, 'رد'),
      content: str(raw.content),
      sources: Array.isArray(raw.sources)
        ? raw.sources.map(sanitizeSource).filter((s): s is Source => s !== null)
        : [],
      createdAt,
      updatedAt: str(raw.updatedAt, createdAt)
    }
  }
  return null
}

function sanitizeDiscussion(raw: unknown): Discussion | null {
  if (!isObject(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs.map(sanitizeTab).filter((t): t is Tab => t !== null)
    : []
  const has = (tabId: string | null, kind: Tab['kind']): string | null =>
    tabs.some((t) => t.id === tabId && t.kind === kind) ? tabId : null
  const createdAt = str(raw.createdAt)
  return {
    id,
    title: str(raw.title, 'مناقشة'),
    createdAt,
    updatedAt: str(raw.updatedAt, createdAt),
    archived: bool(raw.archived, false),
    tabs,
    activeSearchTabId: has(str(raw.activeSearchTabId) || null, 'search'),
    activeDraftTabId: has(str(raw.activeDraftTabId) || null, 'draft')
  }
}

function sanitizeSettings(raw: unknown): Settings {
  const base = defaultSettings()
  if (!isObject(raw)) return base
  return {
    splitRatio:
      typeof raw.splitRatio === 'number' ? clampSplitRatio(raw.splitRatio) : base.splitRatio,
    sidebarCollapsed: bool(raw.sidebarCollapsed, base.sidebarCollapsed),
    appendSources: bool(raw.appendSources, base.appendSources),
    showArchived: bool(raw.showArchived, base.showArchived)
  }
}

/**
 * Coerce untrusted JSON into a valid workspace, or return null if it is not one at all.
 * Returning null is what makes the caller fall through to a backup.
 */
export function sanitizeWorkspace(raw: unknown): Workspace | null {
  if (!isObject(raw)) return null
  if (raw.version !== WORKSPACE_VERSION) return null
  if (!Array.isArray(raw.discussions)) return null
  const discussions = raw.discussions
    .map(sanitizeDiscussion)
    .filter((d): d is Discussion => d !== null)
  const activeId = str(raw.activeDiscussionId) || null
  return {
    version: WORKSPACE_VERSION,
    discussions,
    activeDiscussionId: discussions.some((d) => d.id === activeId) ? activeId : null,
    settings: sanitizeSettings(raw.settings)
  }
}

// ── store ────────────────────────────────────────────────────────────────────

export class WorkspaceStore {
  private readonly dir: string
  private readonly debounceMs: number
  private readonly backupIntervalMs: number
  private readonly onError: (err: unknown) => void

  private timer: NodeJS.Timeout | null = null
  private pending: Workspace | null = null
  /** Serializes writes so a debounce firing mid-write cannot interleave. */
  private writing: Promise<void> = Promise.resolve()
  private lastBackupAt = 0

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.backupIntervalMs = options.backupIntervalMs ?? DEFAULT_BACKUP_INTERVAL_MS
    this.onError = options.onError ?? ((err) => console.error('[store]', err))
  }

  get file(): string {
    return path.join(this.dir, WORKSPACE_FILE)
  }

  private backupFile(n: number): string {
    return path.join(this.dir, `workspace.bak.${n}.json`)
  }

  /** Read the workspace, falling back through the backups when the main file is unusable. */
  async load(): Promise<Workspace> {
    const candidates = [this.file, ...Array.from({ length: BACKUP_COUNT }, (_, i) => this.backupFile(i + 1))]
    for (const candidate of candidates) {
      let text: string
      try {
        text = await fs.readFile(candidate, 'utf8')
      } catch {
        continue // missing file: try the next candidate
      }
      try {
        const parsed = sanitizeWorkspace(JSON.parse(text))
        if (parsed) {
          if (candidate !== this.file) {
            console.warn(`[store] recovered workspace from ${path.basename(candidate)}`)
          }
          return parsed
        }
      } catch {
        // corrupt JSON: fall through to the next candidate
      }
      console.warn(`[store] ignoring unreadable ${path.basename(candidate)}`)
    }
    return defaultWorkspace()
  }

  /** Schedule a save. Repeated calls inside the debounce window collapse into one write. */
  queue(ws: Workspace): void {
    this.pending = ws
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.writePending()
    }, this.debounceMs)
  }

  /** Write any pending state immediately and wait for it to hit disk. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.writePending()
  }

  private writePending(): Promise<void> {
    const ws = this.pending
    this.pending = null
    if (!ws) return this.writing
    this.writing = this.writing.then(() => this.write(ws)).catch((err) => this.onError(err))
    return this.writing
  }

  private async write(ws: Workspace): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await this.rotateBackups()
    // Write-then-rename: a crash mid-write leaves the previous file intact.
    const tmp = path.join(this.dir, TEMP_FILE)
    await fs.writeFile(tmp, JSON.stringify(ws, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }

  private async rotateBackups(): Promise<void> {
    const now = Date.now()
    if (now - this.lastBackupAt < this.backupIntervalMs) return
    try {
      await fs.access(this.file)
    } catch {
      this.lastBackupAt = now // nothing to back up yet
      return
    }
    for (let n = BACKUP_COUNT - 1; n >= 1; n--) {
      await fs.rename(this.backupFile(n), this.backupFile(n + 1)).catch(() => {})
    }
    await fs.copyFile(this.file, this.backupFile(1)).catch(() => {})
    this.lastBackupAt = now
  }
}
