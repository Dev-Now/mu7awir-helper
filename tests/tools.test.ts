import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchTool } from '@shared/types'
import { ToolRegistry, buildSearchUrl, deriveSearchUrl, sanitizeTools } from '../src/main/tools'

const DEFAULTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../resources/tools.default.json'
)

const tool = (patch: Partial<SearchTool> = {}): SearchTool => ({
  id: 'quran',
  label: 'الباحث القرآني',
  shortcut: 'Ctrl+1',
  type: 'web',
  homeUrl: 'https://tafsir.app/',
  searchUrl: 'https://tafsir.app/search?q={q}',
  enabled: true,
  ...patch
})

describe('buildSearchUrl', () => {
  it('substitutes and percent-encodes the query', () => {
    expect(buildSearchUrl(tool(), 'الصبر')).toBe(
      'https://tafsir.app/search?q=%D8%A7%D9%84%D8%B5%D8%A8%D8%B1'
    )
  })

  it('trims the query before substituting', () => {
    expect(buildSearchUrl(tool({ searchUrl: 'https://x/?q={q}' }), '  a b  ')).toBe(
      'https://x/?q=a%20b'
    )
  })

  it('falls back to the home page for an empty query', () => {
    expect(buildSearchUrl(tool(), '   ')).toBe('https://tafsir.app/')
  })

  it('falls back to the home page when the site has no known pattern', () => {
    expect(buildSearchUrl(tool({ searchUrl: null }), 'الصبر')).toBe('https://tafsir.app/')
  })
})

describe('deriveSearchUrl', () => {
  it('learns a template from a percent-encoded Arabic query', () => {
    expect(
      deriveSearchUrl('https://sunnah.one/?s=%D8%A7%D9%84%D8%B5%D8%A8%D8%B1', 'الصبر')
    ).toBe('https://sunnah.one/?s={q}')
  })

  it('learns a template from a literal query in the URL', () => {
    expect(deriveSearchUrl('https://example.org/find/sabr?page=2', 'sabr')).toBe(
      'https://example.org/find/{q}?page=2'
    )
  })

  it('handles plus-encoded spaces', () => {
    expect(deriveSearchUrl('https://example.org/?q=two+words&x=1', 'two words')).toBe(
      'https://example.org/?q={q}&x=1'
    )
  })

  it('preserves the rest of the query string', () => {
    expect(deriveSearchUrl('https://example.org/s?lang=ar&q=abc&sort=new', 'abc')).toBe(
      'https://example.org/s?lang=ar&q={q}&sort=new'
    )
  })

  it('returns null when the query is not in the URL', () => {
    expect(deriveSearchUrl('https://example.org/home', 'الصبر')).toBeNull()
    expect(deriveSearchUrl('', 'الصبر')).toBeNull()
    expect(deriveSearchUrl('https://example.org/?q=x', '  ')).toBeNull()
  })

  it('round-trips: a derived template rebuilds the original URL', () => {
    const original = 'https://sunnah.one/?s=%D8%A7%D9%84%D8%B5%D8%A8%D8%B1'
    const template = deriveSearchUrl(original, 'الصبر')
    expect(buildSearchUrl(tool({ searchUrl: template }), 'الصبر')).toBe(original)
  })
})

describe('sanitizeTools', () => {
  it('rejects anything that is not a non-empty array of tools', () => {
    expect(sanitizeTools(null)).toBeNull()
    expect(sanitizeTools({})).toBeNull()
    expect(sanitizeTools([])).toBeNull()
    expect(sanitizeTools([{ label: 'no id' }])).toBeNull()
  })

  it('fills in defaults for missing fields and normalises the type', () => {
    const [only] = sanitizeTools([{ id: 'x', type: 'weird', searchUrl: '' }])!
    expect(only).toEqual({
      id: 'x',
      label: 'x',
      shortcut: '',
      type: 'web',
      homeUrl: '',
      searchUrl: null,
      enabled: true
    })
  })
})

describe('shipped defaults', () => {
  it('parse and cover the tools the MVP promises', async () => {
    const tools = sanitizeTools(JSON.parse(await fs.readFile(DEFAULTS, 'utf8')))
    expect(tools).not.toBeNull()
    expect(tools!.map((t) => t.id)).toEqual([
      'quran',
      'hadith',
      'fatwa',
      'shamela',
      'basaer',
      'fiqh',
      'rudud'
    ])
    // Shortcut order must match the Ctrl+1..7 promised in doc/MVP.md.
    expect(tools!.map((t) => t.shortcut)).toEqual([
      'Ctrl+1',
      'Ctrl+2',
      'Ctrl+3',
      'Ctrl+4',
      'Ctrl+5',
      'Ctrl+6',
      'Ctrl+7'
    ])
    // basaer is the one web tool still awaiting calibration.
    expect(tools!.filter((t) => t.type === 'web' && t.enabled && !t.searchUrl).map((t) => t.id)).toEqual([
      'basaer'
    ])
  })
})

describe('ToolRegistry', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mu7awir-tools-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('seeds the user copy from the shipped defaults on first run', async () => {
    const registry = new ToolRegistry(dir, DEFAULTS)
    const tools = await registry.load()
    expect(tools).toHaveLength(7)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'tools.json'), 'utf8'))).toHaveLength(7)
  })

  it('prefers the user copy over the defaults once it exists', async () => {
    await fs.writeFile(
      path.join(dir, 'tools.json'),
      JSON.stringify([{ id: 'mine', label: 'خاص', homeUrl: 'https://example.org' }]),
      'utf8'
    )
    expect((await new ToolRegistry(dir, DEFAULTS).load()).map((t) => t.id)).toEqual(['mine'])
  })

  it('persists a calibrated search template', async () => {
    const registry = new ToolRegistry(dir, DEFAULTS)
    await registry.load()
    await registry.setSearchUrl('basaer', 'https://basaer.shuounislamiya.org/?s={q}')

    const reloaded = await new ToolRegistry(dir, DEFAULTS).load()
    expect(reloaded.find((t) => t.id === 'basaer')?.searchUrl).toBe(
      'https://basaer.shuounislamiya.org/?s={q}'
    )
  })

  it('falls back to the defaults when the user copy is corrupt', async () => {
    await fs.writeFile(path.join(dir, 'tools.json'), 'not json', 'utf8')
    expect(await new ToolRegistry(dir, DEFAULTS).load()).toHaveLength(7)
  })
})
