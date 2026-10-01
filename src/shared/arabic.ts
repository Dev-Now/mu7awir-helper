/**
 * Arabic text normalisation for search.
 *
 * Searching «الصبر» must find «الصَّبْرُ», and «مسالة» must find «مسألة». That means
 * folding away the marks and spelling variants that carry no distinction for a reader
 * looking something up. This is used for *matching only* — the text shown and copied is
 * always the original, diacritics included.
 */

/** Tashkeel, Quranic marks and tatweel: dropped outright. */
const DROPPED = /[ؐ-ًؚ-ْٓ-ٖٗ-ٰٟۖ-ۭـ]/

/** Letters and digits folded to one representative form. */
const FOLDED: Record<string, string> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ٲ: 'ا',
  ٳ: 'ا',
  ى: 'ي',
  ئ: 'ي',
  ؤ: 'و',
  ة: 'ه',
  ك: 'ك',
  ﻻ: 'لا',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9'
}

const WORD_CHAR = /[\p{L}\p{N}]/u

export interface NormalizedText {
  norm: string
  /** `map[i]` is the index in the original string that produced `norm[i]`. */
  map: number[]
}

/**
 * Normalise while remembering where each character came from, so matches found in the
 * normalised text can be highlighted in the original.
 */
export function normalizeWithMap(text: string): NormalizedText {
  const out: string[] = []
  const map: number[] = []
  let pendingSpace = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (DROPPED.test(ch)) continue

    const folded = FOLDED[ch] ?? ch
    if (!WORD_CHAR.test(folded[0])) {
      // Punctuation and whitespace alike become a single separating space.
      if (pendingSpace === -1 && out.length > 0) pendingSpace = i
      continue
    }

    if (pendingSpace !== -1) {
      out.push(' ')
      map.push(pendingSpace)
      pendingSpace = -1
    }
    for (const c of folded.toLowerCase()) {
      out.push(c)
      map.push(i)
    }
  }

  return { norm: out.join(''), map }
}

export function normalizeArabic(text: string): string {
  return normalizeWithMap(text).norm
}

/** Split normalised text into search terms. */
export function tokenize(text: string): string[] {
  return normalizeArabic(text).split(' ').filter(Boolean)
}

export interface Range {
  start: number
  end: number
}

/**
 * Locate `terms` inside `text`, returning ranges as offsets into the *original* string.
 * Terms are matched as prefixes, mirroring how the index searches.
 */
export function findMatchRanges(text: string, terms: string[]): Range[] {
  const { norm, map } = normalizeWithMap(text)
  const wanted = terms.map((t) => normalizeArabic(t)).filter(Boolean)
  if (wanted.length === 0 || !norm) return []

  const ranges: Range[] = []
  for (const term of wanted) {
    let at = norm.indexOf(term)
    while (at !== -1) {
      // Only count matches that start a word, the way a reader would expect.
      if (at === 0 || norm[at - 1] === ' ') {
        // Extend over the marks sitting on the last matched letter, so a highlight
        // never clips the fatha off the end of a vocalised word.
        let end = map[at + term.length - 1] + 1
        while (end < text.length && DROPPED.test(text[end])) end++
        ranges.push({ start: map[at], end })
      }
      at = norm.indexOf(term, at + 1)
    }
  }
  return mergeRanges(ranges)
}

export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Range[] = [sorted[0]]
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}
