import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RududIndex, type RududLibrary } from '../src/main/rududIndex'
import { buildLibrary, parseToc } from '../scripts/build-rudud-index.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXPORT = path.join(root, 'doc', 'ChatExport_2026-09-24__JSON', 'result.json')

/** Build straight from the committed export, so the tests exercise the real corpus. */
const exported = JSON.parse(readFileSync(EXPORT, 'utf8'))
const { library, stats } = buildLibrary(exported) as {
  library: RududLibrary
  stats: { messages: number; headers: number; closers: number; skipped: number }
}
const { toc, topics } = library

const topicOf = (id: number) => topics.find((t) => t.parts.some((p) => p.id === id))
const byTag = (tag: string) => topics.find((t) => t.tags.includes(tag))
const listed = new Set(toc.flatMap((c) => c.sections.flatMap((s) => s.topics.map((t) => t.tag))))

describe('build-rudud-index: table of contents', () => {
  it('recovers every category of the pinned index, in the master order', () => {
    expect(toc.map((c) => c.id)).toEqual(Array.from({ length: 11 }, (_, i) => `فهرس_${i + 1}`))
    expect(toc[1].title).toContain('لماذا الإسلام')
  })

  it('files topics under the decorated section headings', () => {
    const women = toc[10].sections.find((s) => s.title === 'المرأة')
    expect(women).toBeDefined()
    expect(women!.topics.map((t) => t.tag)).toContain('#التعدد')
    expect(toc[10].sections[0].title).toBe('شبهات عامة')
  })

  it('keeps the note written after a topic tag', () => {
    const entry = toc
      .flatMap((c) => c.sections.flatMap((s) => s.topics))
      .find((t) => t.tag === '#شبهة_رضاع_الكبير')
    expect(entry?.note).toBe('حديث سالم')
  })

  it('lists a substantial number of topics', () => {
    expect(listed.size).toBeGreaterThan(300)
  })

  it('reads the index without any other message', () => {
    expect(parseToc(exported.messages)).toEqual(toc)
  })
})

describe('build-rudud-index: topics', () => {
  it('groups the corpus into whole topics', () => {
    expect(topics.length).toBeGreaterThan(300)
    expect(topics.length).toBeLessThan(stats.messages)
    expect(topics.filter((t) => t.kind === 'untitled').length).toBeLessThan(25)
  })

  it('finds content for every topic the index lists', () => {
    const present = new Set(topics.flatMap((t) => t.tags))
    expect([...listed].filter((tag) => !present.has(tag))).toEqual([])
  })

  it('keeps a topic going after a header that also carries text', () => {
    // #25 opens «#السعادة_ليست_في_المال، …»; #26 and #27 continue it untagged.
    const topic = byTag('#السعادة_ليست_في_المال')!
    expect(topic.parts.map((p) => p.id)).toEqual([25, 26, 27])
  })

  it('treats an untagged «… 👇» line as a header of its own', () => {
    // «الدعاء والقدر👇» must not inherit the topic before it.
    expect(topicOf(11)?.title).toBe('الدعاء والقدر')
    expect(byTag('#شروط_استجابة_الدعاء')!.parts.map((p) => p.id)).toEqual([9])
  })

  it('keeps parts in posting order', () => {
    const topic = byTag('#القضية_الفلسطينية_وحقيقة_اليهود')!
    const ids = topic.parts.map((p) => p.id)
    expect(ids.length).toBeGreaterThanOrEqual(5)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    for (const t of topics) {
      const order = t.parts.map((p) => p.id)
      expect(order).toEqual([...order].sort((a, b) => a - b))
    }
  })

  it('never indexes the table of contents or the 👆 closers as content', () => {
    const parts = topics.flatMap((t) => t.parts)
    expect(parts.some((p) => /#فهرس_\d/.test(p.text))).toBe(false)
    expect(parts.some((p) => p.text.includes('👆') && p.text.length < 120)).toBe(false)
  })

  it('places each message in at most one topic', () => {
    const ids = topics.flatMap((t) => t.parts.map((p) => p.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not let an inline hashtag hijack a topic', () => {
    // #415 opens with «#فتدبر #غُلِبَتِ…», but belongs to the header above it.
    expect(topicOf(415)?.key).toBe('#الإعجاز_في_بداية_سورة_الروم')
  })

  it('files a multi-tag header under its most specific listed tag, reachable by all', () => {
    const topic = byTag('#عمر_أخزيا')!
    expect(topic.key).toBe('#عمر_أخزيا')
    expect(topic.tags).toContain('#تناقضات_الأناجيل')
  })

  it('merges a topic posted again under the same tag, keeping each header note', () => {
    const topic = byTag('#اسم_الله_الوكيل')!
    expect(topic.parts.length).toBeGreaterThan(3)
    expect(topic.parts.some((p) => p.heading === 'وسوء الظن بالله')).toBe(true)
  })

  it('waits for the body of a header however late it arrives', () => {
    expect(byTag('#شبهة_زواج_الرجل_ابنته_من_الزنا')!.parts.length).toBeGreaterThan(0)
  })

  it('keeps a video-only topic, marked as such', () => {
    const topic = byTag('#فيديو_عن_الصلاة')!
    expect(topic.mediaOnly).toBe(true)
    expect(topic.parts).toEqual([])
  })

  it('is deterministic', () => {
    expect(buildLibrary(exported).library).toEqual(library)
  })
})

describe('RududIndex', () => {
  const index = RududIndex.fromLibrary(library)

  it('reports the number of topics', () => {
    expect(index.available).toBe(true)
    expect(index.size).toBe(topics.length)
  })

  it('finds topics by a bare query despite vocalised text', () => {
    const { hits, total } = index.search('الصبر')
    expect(total).toBeGreaterThan(0)
    expect(hits[0].parts.some((p) => p.ranges.length > 0) || hits[0].titleRanges.length > 0).toBe(true)
  })

  it('returns each topic once, whole and in order', () => {
    const { hits } = index.search('الوسواس')
    const keys = hits.map((h) => h.key)
    expect(new Set(keys).size).toBe(keys.length)
    const palestine = index.search('مذبحة كفر').hits.find((h) => h.key === '#القضية_الفلسطينية_وحقيقة_اليهود')
    expect(palestine).toBeDefined()
    expect(palestine!.parts.length).toBe(byTag('#القضية_الفلسطينية_وحقيقة_اليهود')!.parts.length)
  })

  it('recalls the waswas material the MVP names as an acceptance case', () => {
    const { hits } = index.search('الوسواس القهري')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.slice(0, 5).some((h) => h.tags.some((t) => t.includes('وسواس')))).toBe(true)
  })

  it('ranks a title match above an incidental mention', () => {
    const { hits } = index.search('الإلحاد')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].title.includes('لحاد') || hits[0].tags.some((t) => t.includes('لحاد'))).toBe(true)
  })

  it('requires every term, so multi-word queries narrow the result', () => {
    const one = index.search('الصبر').total
    const two = index.search('الصبر الإيمان').total
    expect(two).toBeLessThanOrEqual(one)
  })

  it('reports highlight ranges that land on the query inside the original text', () => {
    const [hit] = index.search('الصبر').hits
    const spans = hit.parts.flatMap((p) => p.ranges.map((r) => p.text.slice(r.start, r.end)))
    expect(spans.length).toBeGreaterThan(0)
    for (const span of spans) expect(span.length).toBeGreaterThan(0)
  })

  it('places a hit in the table of contents', () => {
    const hit = index.topic('#التعدد')!
    expect(hit.place).toEqual({ category: toc[10].title, section: 'المرأة' })
  })

  it('treats a bare hashtag as a topic filter, not a word search', () => {
    const { hits } = index.search('#اسم_الله_الوكيل')
    expect(hits.map((h) => h.key)).toEqual(['#اسم_الله_الوكيل'])
    expect(hits[0].parts.every((p) => p.ranges.length === 0)).toBe(true)
  })

  it('opens every topic filed under a tag, in posting order', () => {
    const { hits } = index.tag('#تناقضات_الأناجيل')
    expect(hits.map((h) => h.key)).toEqual(['#تناقضات_الأناجيل', '#عمر_أخزيا'])
  })

  it('matches a tag regardless of its hamza spelling', () => {
    const tag = topics.flatMap((t) => t.tags).find((t) => /[أإآ]/.test(t))!
    const bare = tag.replace(/[أإآ]/g, 'ا')
    expect(index.tag(bare).total).toBeGreaterThan(0)
  })

  it('highlights the search inside an opened topic', () => {
    const hit = index.topic('#البلاء', 'الدنيا')!
    expect(hit.parts.some((p) => p.ranges.length > 0)).toBe(true)
    expect(index.topic('#البلاء')!.parts.every((p) => p.ranges.length === 0)).toBe(true)
  })

  it('returns no results for an empty query; the panel shows the index instead', () => {
    expect(index.search('   ')).toEqual({ available: true, total: 0, hits: [] })
  })

  it('serves the table of contents resolved to topics', () => {
    const nav = index.navigation()
    expect(nav.slice(0, 11).map((c) => c.id)).toEqual(toc.map((c) => c.id))
    const items = nav.flatMap((c) => c.sections.flatMap((s) => s.items))
    expect(items.every((i) => i.keys.length > 0)).toBe(true)
    // Every topic is reachable from the navigation.
    const reachable = new Set(items.flatMap((i) => i.keys))
    expect(topics.every((t) => reachable.has(t.key))).toBe(true)
  })

  it('files unlisted topics under «غير مصنّف»', () => {
    const other = index.navigation().find((c) => c.id === 'other')
    expect(other?.title).toBe('غير مصنّف')
    expect(other!.sections.flatMap((s) => s.items).some((i) => i.view.startsWith('rudud:topic:msg-'))).toBe(true)
  })

  it('returns an empty result for a query that matches nothing', () => {
    expect(index.search('zzzqqqxxx').hits).toEqual([])
    expect(index.topic('#no_such_topic')).toBeNull()
  })

  it('reports unavailable before a library is loaded', () => {
    const empty = new RududIndex()
    expect(empty.available).toBe(false)
    expect(empty.search('الصبر')).toEqual({ available: false, total: 0, hits: [] })
    expect(empty.navigation()).toEqual([])
  })

  it('treats a missing library file as unbuilt rather than an error', async () => {
    const missing = new RududIndex()
    await expect(missing.load('/no/such/rudud.json')).resolves.toBe(false)
  })
})
