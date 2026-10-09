/**
 * The search tool registry.
 *
 * Defaults ship in `resources/tools.default.json` and are copied to the user-data
 * directory on first run, so the user can edit their own copy (or have the app write to
 * it via the calibration flow) without the next release overwriting it.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { SearchTool } from '@shared/types'

export const TOOLS_FILE = 'tools.json'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function sanitizeTool(raw: unknown): SearchTool | null {
  if (!isObject(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!id) return null
  return {
    id,
    label: typeof raw.label === 'string' ? raw.label : id,
    shortcut: typeof raw.shortcut === 'string' ? raw.shortcut : '',
    type: raw.type === 'local' ? 'local' : 'web',
    homeUrl: typeof raw.homeUrl === 'string' ? raw.homeUrl : '',
    searchUrl: typeof raw.searchUrl === 'string' && raw.searchUrl ? raw.searchUrl : null,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    copyOverlay: typeof raw.copyOverlay === 'boolean' ? raw.copyOverlay : true
  }
}

export function sanitizeTools(raw: unknown): SearchTool[] | null {
  if (!Array.isArray(raw)) return null
  const tools = raw.map(sanitizeTool).filter((t): t is SearchTool => t !== null)
  return tools.length > 0 ? tools : null
}

/** Substitute the query into a tool's template, falling back to its home page. */
export function buildSearchUrl(tool: SearchTool, query: string): string {
  const trimmed = query.trim()
  if (!trimmed || !tool.searchUrl) return tool.homeUrl
  return tool.searchUrl.replace('{q}', encodeURIComponent(trimmed))
}

/**
 * Turn "the page I am looking at" into a reusable template by finding the query inside
 * the URL and swapping it for `{q}`. This is what lets the user teach the app a site's
 * search pattern without touching code. Returns null when the query is not in the URL.
 */
export function deriveSearchUrl(currentUrl: string, query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed || !currentUrl) return null

  const encoded = encodeURIComponent(trimmed)
  const candidates = [
    encoded,
    encoded.replace(/%20/g, '+'),
    encoded.toLowerCase(),
    trimmed,
    trimmed.replace(/ /g, '+')
  ]

  for (const candidate of candidates) {
    const at = currentUrl.indexOf(candidate)
    if (at !== -1) {
      return currentUrl.slice(0, at) + '{q}' + currentUrl.slice(at + candidate.length)
    }
  }
  return null
}

export class ToolRegistry {
  private readonly file: string
  private readonly defaultsFile: string
  private tools: SearchTool[] = []

  constructor(userDataDir: string, defaultsFile: string) {
    this.file = path.join(userDataDir, TOOLS_FILE)
    this.defaultsFile = defaultsFile
  }

  /** Read the user's copy, seeding it from the shipped defaults on first run. */
  async load(): Promise<SearchTool[]> {
    const defaults = sanitizeTools(await this.read(this.defaultsFile)) ?? []
    const rawUser = await this.read(this.file)
    const fromUser = sanitizeTools(rawUser)
    if (fromUser) {
      // A user copy seeded by an older release predates some settings. Take those from the
      // shipped defaults rather than the generic fallback, so per-site choices still arrive.
      const missing = new Set(
        (rawUser as unknown[])
          .filter((t) => isObject(t) && typeof t.copyOverlay !== 'boolean')
          .map((t) => (t as Record<string, unknown>).id)
      )
      this.tools = fromUser.map((t) => {
        const shipped = defaults.find((d) => d.id === t.id)
        return missing.has(t.id) && shipped ? { ...t, copyOverlay: shipped.copyOverlay } : t
      })
      if (missing.size > 0) await this.persist().catch(() => {})
      return this.tools
    }
    this.tools = defaults
    await this.persist().catch(() => {})
    return this.tools
  }

  private async read(file: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      return null
    }
  }

  list(): SearchTool[] {
    return this.tools
  }

  get(id: string): SearchTool | undefined {
    return this.tools.find((t) => t.id === id)
  }

  /** Save a search template learned from the calibration flow. */
  async setSearchUrl(id: string, searchUrl: string | null): Promise<SearchTool[]> {
    this.tools = this.tools.map((t) => (t.id === id ? { ...t, searchUrl } : t))
    await this.persist()
    return this.tools
  }

  /** Turn the hover copy button on or off for one tool. */
  async setCopyOverlay(id: string, copyOverlay: boolean): Promise<SearchTool[]> {
    this.tools = this.tools.map((t) => (t.id === id ? { ...t, copyOverlay } : t))
    await this.persist()
    return this.tools
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, JSON.stringify(this.tools, null, 2), 'utf8')
  }
}
