/**
 * Full-text search over مكتبة الردود — the personal reply library built from the
 * Telegram channel export by scripts/build-rudud-index.mjs.
 *
 * The corpus is under a thousand short documents, so the whole thing lives in memory and
 * a query costs well under a millisecond. Arabic folding happens in the tokenizer, which
 * means the index and the query are normalised by exactly the same code.
 */
import { promises as fs } from 'node:fs'
import MiniSearch from 'minisearch'
import { findMatchRanges, normalizeArabic, tokenize, type Range } from '@shared/arabic'

export interface RududDoc {
  id: number
  date: string
  tags: string[]
  text: string
}

export interface RududHit extends RududDoc {
  /** Where the query matched, as offsets into the original (un-normalised) text. */
  ranges: Range[]
}

export interface RududResult {
  /** False when the index has not been built yet. */
  available: boolean
  total: number
  hits: RududHit[]
}

const DEFAULT_LIMIT = 40

export function createIndex(documents: RududDoc[]): MiniSearch<RududDoc> {
  const index = new MiniSearch<RududDoc>({
    idField: 'id',
    fields: ['text', 'tags'],
    storeFields: [],
    // Both indexing and querying run through the same Arabic folding.
    tokenize: (text) => tokenize(text),
    processTerm: (term) => term || null
  })
  index.addAll(documents)
  return index
}

export class RududIndex {
  private documents = new Map<number, RududDoc>()
  private index: MiniSearch<RududDoc> | null = null

  get available(): boolean {
    return this.index !== null
  }

  get size(): number {
    return this.documents.size
  }

  /** Build directly from documents, bypassing the generated file. */
  static fromDocuments(documents: RududDoc[]): RududIndex {
    const instance = new RududIndex()
    instance.documents = new Map(documents.map((d) => [d.id, d]))
    instance.index = createIndex(documents)
    return instance
  }

  /** Load the generated index; a missing file is not an error, just an unbuilt library. */
  async load(file: string): Promise<boolean> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as RududDoc[]
      if (!Array.isArray(parsed) || parsed.length === 0) return false
      this.documents = new Map(parsed.map((d) => [d.id, d]))
      this.index = createIndex(parsed)
      return true
    } catch {
      return false
    }
  }

  search(query: string, limit = DEFAULT_LIMIT): RududResult {
    if (!this.index) return { available: false, total: 0, hits: [] }

    // A bare hashtag means "everything filed under this topic". Tokenising it would
    // split it into its component words and match them separately, which turns a tag
    // click into a noisy AND search over common words like «على».
    const tag = query.trim()
    if (/^#[^\s#]+$/.test(tag)) {
      const wanted = normalizeArabic(tag.slice(1))
      const matching = [...this.documents.values()]
        .filter((d) => d.tags.some((t) => normalizeArabic(t.replace(/^#/, '')) === wanted))
        .sort((a, b) => b.date.localeCompare(a.date))
      return {
        available: true,
        total: matching.length,
        hits: matching.slice(0, limit).map((d) => ({ ...d, ranges: [] }))
      }
    }

    const terms = tokenize(query)
    if (terms.length === 0) {
      // An empty query browses the library newest-first rather than showing nothing.
      const recent = [...this.documents.values()]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, limit)
      return { available: true, total: this.documents.size, hits: recent.map((d) => ({ ...d, ranges: [] })) }
    }

    const found = this.index.search(query, {
      prefix: true,
      fuzzy: 0.2,
      boost: { tags: 3 },
      combineWith: 'AND'
    })

    const hits = found.slice(0, limit).flatMap<RududHit>((result) => {
      const doc = this.documents.get(result.id as number)
      if (!doc) return []
      // Highlight what the user typed, plus whatever the fuzzy pass actually matched.
      const matched = [...new Set([...terms, ...result.terms.map(normalizeArabic)])]
      return [{ ...doc, ranges: findMatchRanges(doc.text, matched) }]
    })

    return { available: true, total: found.length, hits }
  }
}
