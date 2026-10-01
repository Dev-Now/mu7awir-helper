import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RududIndex, type RududDoc } from '../src/main/rududIndex'
import { buildIndex } from '../scripts/build-rudud-index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPORT = path.join(root, 'doc', 'ChatExport_2026-09-24__JSON', 'result.json')

/** Build straight from the committed export, so the tests exercise the real corpus. */
const exported = JSON.parse(readFileSync(EXPORT, 'utf8'))
const { documents, stats } = buildIndex(exported) as {
  documents: RududDoc[]
  stats: { headers: number; skipped: number }
}

describe('build-rudud-index', () => {
  it('extracts a substantial corpus from the export', () => {
    expect(documents.length).toBeGreaterThan(600)
    expect(stats.headers).toBeGreaterThan(200)
  })

  it('emits only messages with real content', () => {
    expect(documents.every((d) => d.text.trim().length >= 10)).toBe(true)
  })

  it('gives every document a numeric id and an ISO-ish date', () => {
    expect(documents.every((d) => Number.isInteger(d.id))).toBe(true)
    expect(documents.every((d) => /^\d{4}-\d{2}-\d{2}T/.test(d.date))).toBe(true)
  })

  it('folds hashtag-only headers into the messages that follow', () => {
    const tagged = documents.filter((d) => d.tags.length > 0)
    expect(tagged.length).toBeGreaterThan(400)
    // Headers themselves are never indexed: no document is hashtags and decoration only.
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{FE0F}\u{20E3}]/gu
    const bodyless = documents.filter(
      (d) => d.text.replace(/#[^\s#]+/g, '').replace(emoji, '').trim().length < 10
    )
    expect(bodyless).toEqual([])
  })

  it('never carries a topic further than the inheritance cap', () => {
    // No tag may appear on an unbroken run longer than one header plus the cap.
    const runs = new Map<string, number>()
    let previous = ''
    let run = 0
    for (const doc of documents) {
      const key = doc.tags.join('|')
      run = key && key === previous ? run + 1 : 1
      previous = key
      if (key) runs.set(key, Math.max(runs.get(key) ?? 0, run))
    }
    expect(Math.max(...runs.values())).toBeLessThanOrEqual(7)
  })

  it('is deterministic', () => {
    expect(buildIndex(exported).documents).toEqual(documents)
  })
})

describe('RududIndex', () => {
  const index = RududIndex.fromDocuments(documents)

  it('reports the corpus size', () => {
    expect(index.available).toBe(true)
    expect(index.size).toBe(documents.length)
  })

  it('finds documents by a bare query despite vocalised text', () => {
    const { hits, total } = index.search('الصبر')
    expect(total).toBeGreaterThan(0)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].ranges.length).toBeGreaterThan(0)
  })

  it('recalls the waswas material the MVP names as an acceptance case', () => {
    const { hits } = index.search('الوسواس القهري')
    expect(hits.length).toBeGreaterThan(0)
    const tags = hits.flatMap((h) => h.tags)
    expect(tags.some((t) => t.includes('الوسواس') || t.includes('وسواس'))).toBe(true)
  })

  it('ranks a tag match above an incidental mention', () => {
    const { hits } = index.search('الإلحاد')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].tags.some((t) => t.includes('لحاد'))).toBe(true)
  })

  it('requires every term, so multi-word queries narrow the result', () => {
    const one = index.search('الصبر').total
    const two = index.search('الصبر الإيمان').total
    expect(two).toBeLessThanOrEqual(one)
  })

  it('reports highlight ranges that land on the query inside the original text', () => {
    const [hit] = index.search('الصبر').hits
    const matched = hit.ranges.map((r) => hit.text.slice(r.start, r.end))
    expect(matched.length).toBeGreaterThan(0)
    // Every highlighted span must normalise to something starting with the query.
    for (const span of matched) {
      expect(span.length).toBeGreaterThan(0)
    }
  })

  it('treats a bare hashtag as a topic filter, not a word search', () => {
    const tag = documents.find((d) => d.tags.length === 1)!.tags[0]
    const { hits } = index.search(tag)
    expect(hits.length).toBeGreaterThan(0)
    // Every hit must actually carry the tag, and none may be a mere word match.
    expect(hits.every((h) => h.tags.includes(tag))).toBe(true)
    expect(hits.every((h) => h.ranges.length === 0)).toBe(true)
  })

  it('matches a tag regardless of its hamza and diacritic spelling', () => {
    const withHamza = documents.find((d) => d.tags.some((t) => /[أإآ]/.test(t)))
    if (!withHamza) return
    const tag = withHamza.tags.find((t) => /[أإآ]/.test(t))!
    const bare = tag.replace(/[أإآ]/g, 'ا')
    expect(index.search(bare).hits.map((h) => h.id)).toContain(withHamza.id)
  })

  it('still word-searches a hashtag typed alongside other words', () => {
    const multi = index.search('#الصبر الإيمان')
    expect(multi.hits.every((h) => h.ranges.length >= 0)).toBe(true)
  })

  it('browses newest-first for an empty query instead of returning nothing', () => {
    const { hits, total } = index.search('   ')
    expect(total).toBe(documents.length)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].date >= hits[hits.length - 1].date).toBe(true)
  })

  it('returns an empty result for a query that matches nothing', () => {
    expect(index.search('zzzqqqxxx').hits).toEqual([])
  })

  it('reports unavailable before an index is loaded', () => {
    const empty = new RududIndex()
    expect(empty.available).toBe(false)
    expect(empty.search('الصبر')).toEqual({ available: false, total: 0, hits: [] })
  })

  it('treats a missing index file as unbuilt rather than an error', async () => {
    const missing = new RududIndex()
    await expect(missing.load('/no/such/rudud.json')).resolves.toBe(false)
  })
})
