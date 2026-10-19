/**
 * Full-text search over مكتبة الردود — the personal reply library built from the
 * Telegram channel export by scripts/build-rudud-index.mjs.
 *
 * The unit is the *topic*, not the Telegram message: a reply the channel posted as
 * several consecutive messages is found, shown and copied as one, with its parts in
 * order. The corpus is a few hundred topics, so the whole thing lives in memory and a
 * query costs well under a millisecond. Arabic folding happens in the tokenizer, which
 * means the index and the query are normalised by exactly the same code.
 */
import { promises as fs } from 'node:fs'
import MiniSearch from 'minisearch'
import { findMatchRanges, normalizeArabic, tokenize } from '@shared/arabic'
import {
  rududTagView,
  rududTopicView,
  tagTitle,
  type RududHit,
  type RududLibrary,
  type RududNavCategory,
  type RududNavItem,
  type RududPlace,
  type RududResult,
  type RududTopic
} from '@shared/rudud'

export type { RududHit, RududLibrary, RududResult, RududTopic } from '@shared/rudud'

const DEFAULT_LIMIT = 40

interface Searchable {
  id: number
  title: string
  tags: string
  text: string
}

/** Tags compare by their folded spelling, so «#الإلحاد» and «#الالحاد» are one topic. */
const tagKey = (tag: string): string => normalizeArabic(tag.replace(/^#/, ''))

export function createIndex(topics: RududTopic[]): MiniSearch<Searchable> {
  const index = new MiniSearch<Searchable>({
    idField: 'id',
    fields: ['title', 'tags', 'text'],
    storeFields: [],
    // Both indexing and querying run through the same Arabic folding.
    tokenize: (text) => tokenize(text),
    processTerm: (term) => term || null
  })
  index.addAll(
    topics.map((topic, id) => ({
      id,
      title: topic.title,
      tags: topic.tags.map(tagTitle).join(' '),
      text: topic.parts.map((p) => p.text).join('\n\n')
    }))
  )
  return index
}

export class RududIndex {
  private topics: RududTopic[] = []
  private toc: RududLibrary['toc'] = []
  private byKey = new Map<string, number>()
  private byTag = new Map<string, number[]>()
  private places = new Map<string, RududPlace>()
  private index: MiniSearch<Searchable> | null = null

  get available(): boolean {
    return this.index !== null
  }

  /** Number of topics. */
  get size(): number {
    return this.topics.length
  }

  /** Build directly from a library, bypassing the generated file. */
  static fromLibrary(library: RududLibrary): RududIndex {
    const instance = new RududIndex()
    instance.use(library)
    return instance
  }

  /** Load the generated library; a missing or outdated file just means an unbuilt one. */
  async load(file: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as RududLibrary
      // The previous format was a bare array of messages; it needs a rebuild.
      if (!parsed || !Array.isArray(parsed.topics) || parsed.topics.length === 0) return false
      this.use(parsed)
      return true
    } catch {
      return false
    }
  }

  private use(library: RududLibrary): void {
    this.topics = library.topics
    this.toc = library.toc ?? []
    this.byKey = new Map(this.topics.map((t, i) => [t.key, i]))
    this.byTag = new Map()
    this.topics.forEach((topic, i) => {
      for (const tag of topic.tags) {
        const key = tagKey(tag)
        const list = this.byTag.get(key) ?? []
        if (!list.includes(i)) list.push(i)
        this.byTag.set(key, list)
      }
    })
    this.places = new Map()
    for (const category of this.toc) {
      for (const section of category.sections) {
        for (const entry of section.topics) {
          const key = tagKey(entry.tag)
          if (!this.places.has(key)) {
            this.places.set(key, { category: category.title, section: section.title })
          }
        }
      }
    }
    this.index = createIndex(this.topics)
  }

  /**
   * The channel's table of contents, each line resolved to the topics it leads to, plus
   * a final «غير مصنّف» category for topics the channel never filed.
   */
  navigation(): RududNavCategory[] {
    if (!this.index) return []
    const reached = new Set<number>()

    const categories: RududNavCategory[] = this.toc.map((category) => ({
      id: category.id,
      title: category.title,
      sections: category.sections.map((section) => ({
        title: section.title,
        items: section.topics.map((entry) => {
          const found = this.byTag.get(tagKey(entry.tag)) ?? []
          found.forEach((i) => reached.add(i))
          return this.navItem(found, rududTagView(entry.tag), tagTitle(entry.tag), entry.note)
        })
      }))
    }))

    const tagged: RududNavItem[] = []
    const untagged: RududNavItem[] = []
    this.topics.forEach((topic, i) => {
      if (reached.has(i)) return
      const item = this.navItem([i], rududTopicView(topic.key), topic.title)
      ;(topic.kind === 'tag' ? tagged : untagged).push(item)
    })
    const sections = [
      { title: 'وسوم خارج الفهرس', items: tagged },
      { title: 'مواضيع بلا وسم', items: untagged }
    ].filter((s) => s.items.length > 0)
    if (sections.length > 0) categories.push({ id: 'other', title: 'غير مصنّف', sections })

    return categories
  }

  private navItem(found: number[], view: string, title: string, note?: string): RududNavItem {
    const topics = found.map((i) => this.topics[i])
    return {
      view,
      keys: topics.map((t) => t.key),
      title,
      ...(note && { note }),
      parts: topics.reduce((n, t) => n + t.parts.length, 0),
      mediaOnly: topics.length > 0 && topics.every((t) => t.mediaOnly)
    }
  }

  /** One topic, whole, with `query` highlighted if given. */
  topic(key: string, query = ''): RududHit | null {
    const i = this.byKey.get(key)
    return i === undefined ? null : this.hit(this.topics[i], tokenize(query))
  }

  /** Every topic filed under a hashtag, in posting order. */
  tag(tag: string, query = ''): RududResult {
    if (!this.index) return { available: false, total: 0, hits: [] }
    const terms = tokenize(query)
    const found = [...(this.byTag.get(tagKey(tag)) ?? [])].sort((a, b) => a - b)
    return { available: true, total: found.length, hits: found.map((i) => this.hit(this.topics[i], terms)) }
  }

  search(query: string, limit = DEFAULT_LIMIT): RududResult {
    if (!this.index) return { available: false, total: 0, hits: [] }

    // A bare hashtag means "everything filed under this topic". Tokenising it would
    // split it into its component words and match them separately, which turns a tag
    // click into a noisy AND search over common words like «على».
    const trimmed = query.trim()
    if (/^#[^\s#]+$/.test(trimmed)) return this.tag(trimmed)

    const terms = tokenize(query)
    // An empty query has no results; the panel shows the table of contents instead.
    if (terms.length === 0) return { available: true, total: 0, hits: [] }

    const found = this.index.search(query, {
      prefix: true,
      fuzzy: 0.2,
      boost: { title: 3, tags: 2 },
      combineWith: 'AND'
    })

    const hits = found.slice(0, limit).map((result) => {
      // Highlight what the user typed, plus whatever the fuzzy pass actually matched.
      const matched = [...new Set([...terms, ...result.terms.map(normalizeArabic)])]
      return this.hit(this.topics[result.id as number], matched)
    })

    return { available: true, total: found.length, hits }
  }

  private hit(topic: RududTopic, terms: string[]): RududHit {
    const place = topic.tags.map((t) => this.places.get(tagKey(t))).find(Boolean) ?? null
    return {
      key: topic.key,
      tags: topic.tags,
      kind: topic.kind,
      title: topic.title,
      titleRanges: findMatchRanges(topic.title, terms),
      mediaOnly: !!topic.mediaOnly,
      firstDate: topic.firstDate,
      lastDate: topic.lastDate,
      place,
      parts: topic.parts.map((part) => ({ ...part, ranges: findMatchRanges(part.text, terms) }))
    }
  }
}
