import { describe, expect, it } from 'vitest'
import {
  findMatchRanges,
  mergeRanges,
  normalizeArabic,
  normalizeWithMap,
  tokenize
} from '@shared/arabic'

describe('normalizeArabic', () => {
  it('folds tashkeel away so a bare query matches vocalised text', () => {
    expect(normalizeArabic('الصَّبْرُ')).toBe(normalizeArabic('الصبر'))
  })

  it('folds Quranic marks, the superscript alef and tatweel', () => {
    expect(normalizeArabic('ذَٰلِكَ ٱلْكِتَـٰبُ')).toBe('ذلك الكتب')
  })

  it('folds the hamza carriers to their base letters', () => {
    expect(normalizeArabic('أحمد')).toBe('احمد')
    expect(normalizeArabic('إيمان')).toBe('ايمان')
    expect(normalizeArabic('آمن')).toBe('امن')
    expect(normalizeArabic('مسألة')).toBe('مساله')
    expect(normalizeArabic('مسؤول')).toBe('مسوول')
  })

  it('folds alef maqsura and ta marbuta', () => {
    expect(normalizeArabic('على')).toBe(normalizeArabic('علي'))
    expect(normalizeArabic('رحمة')).toBe(normalizeArabic('رحمه'))
  })

  it('folds tatweel', () => {
    expect(normalizeArabic('الصــــبر')).toBe('الصبر')
  })

  it('folds Arabic-Indic digits to Latin', () => {
    expect(normalizeArabic('سورة ٢')).toBe('سوره 2')
  })

  it('turns punctuation into word separators', () => {
    expect(normalizeArabic('الصبر، والشكر: خير')).toBe('الصبر والشكر خير')
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeArabic('  الصبر \n\n  خير  ')).toBe('الصبر خير')
  })

  it('lowercases Latin text', () => {
    expect(normalizeArabic('Sabr AND Shukr')).toBe('sabr and shukr')
  })

  it('is idempotent', () => {
    const once = normalizeArabic('الصَّبْرُ، مِفْتَاحُ الفَرَجِ')
    expect(normalizeArabic(once)).toBe(once)
  })

  it('returns an empty string for decoration only', () => {
    expect(normalizeArabic('،.:—  ')).toBe('')
  })
})

describe('normalizeWithMap', () => {
  it('maps every normalised character back to its source index', () => {
    const text = 'الصَّبْرُ'
    const { norm, map } = normalizeWithMap(text)
    expect(norm).toBe('الصبر')
    expect(map).toHaveLength(norm.length)
    // Each mapped index must point at the character it came from.
    expect(text[map[0]]).toBe('ا')
    expect(text[map[map.length - 1]]).toBe('ر')
    expect(map.every((m, i) => i === 0 || m >= map[i - 1])).toBe(true)
  })

  it('keeps the map aligned across dropped marks and folded letters', () => {
    const text = 'مسألة كبرى'
    const { norm, map } = normalizeWithMap(text)
    const at = norm.indexOf('كبري')
    expect(text.slice(map[at], map[at + 3] + 1)).toBe('كبرى')
  })
})

describe('tokenize', () => {
  it('splits on whitespace and punctuation after folding', () => {
    expect(tokenize('الصَّبْرُ، والشُّكْرُ')).toEqual(['الصبر', 'والشكر'])
  })

  it('drops empty tokens', () => {
    expect(tokenize('   ،،،  ')).toEqual([])
  })
})

describe('findMatchRanges', () => {
  it('finds a bare query inside vocalised text and reports original offsets', () => {
    const text = 'إن الصَّبْرَ مفتاح الفرج'
    const [range] = findMatchRanges(text, ['الصبر'])
    // The trailing fatha belongs to the matched word, so the highlight covers it.
    expect(text.slice(range.start, range.end)).toBe('الصَّبْرَ')
  })

  it('matches at word starts only', () => {
    // "بر" must not match inside "الصبر".
    expect(findMatchRanges('الصبر', ['بر'])).toEqual([])
    expect(findMatchRanges('بر الوالدين', ['بر'])).toHaveLength(1)
  })

  it('matches prefixes, the way the index searches', () => {
    const text = 'الصابرون'
    const [range] = findMatchRanges(text, ['الصاب'])
    expect(text.slice(range.start, range.end)).toBe('الصاب')
  })

  it('finds every occurrence', () => {
    expect(findMatchRanges('الصبر ثم الصبر ثم الصبر', ['الصبر'])).toHaveLength(3)
  })

  it('returns nothing for a query that is not present', () => {
    expect(findMatchRanges('الصبر', ['الشكر'])).toEqual([])
    expect(findMatchRanges('الصبر', [])).toEqual([])
  })
})

describe('mergeRanges', () => {
  it('merges overlapping and touching ranges', () => {
    expect(mergeRanges([{ start: 0, end: 5 }, { start: 3, end: 8 }])).toEqual([{ start: 0, end: 8 }])
    expect(mergeRanges([{ start: 0, end: 3 }, { start: 3, end: 6 }])).toEqual([{ start: 0, end: 6 }])
  })

  it('leaves disjoint ranges alone and sorts them', () => {
    expect(mergeRanges([{ start: 10, end: 12 }, { start: 0, end: 3 }])).toEqual([
      { start: 0, end: 3 },
      { start: 10, end: 12 }
    ])
  })
})
