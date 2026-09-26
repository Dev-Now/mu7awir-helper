import { describe, expect, it } from 'vitest'
import { cleanCopiedText, composeDraft, formatSourceLine, makeSource, withSource } from '@shared/text'
import * as W from '@shared/workspace'
import type { DraftTab } from '@shared/types'

describe('cleanCopiedText', () => {
  it('keeps Arabic diacritics intact', () => {
    const vocalised = 'الصَّبْرُ عِنْدَ الصَّدْمَةِ الأُولى'
    expect(cleanCopiedText(vocalised)).toBe(vocalised)
  })

  it('keeps the superscript alef and other Quranic marks', () => {
    const verse = 'ذَٰلِكَ ٱلْكِتَـٰبُ لَا رَيْبَ ۛ فِيهِ'
    expect(cleanCopiedText(verse)).toBe(verse)
  })

  it('strips zero-width and bidi control characters', () => {
    expect(cleanCopiedText('ا​ل‎ص﻿بر')).toBe('الصبر')
  })

  it('collapses runs of spaces and tabs without touching newlines', () => {
    expect(cleanCopiedText('a   \t b\n\nc')).toBe('a b\n\nc')
  })

  it('keeps paragraph breaks but drops longer runs', () => {
    expect(cleanCopiedText('a\n\n\n\n\nb')).toBe('a\n\nb')
  })

  it('trims surrounding whitespace on each line and overall', () => {
    expect(cleanCopiedText('  \n  الصبر   \n  مفتاح الفرج  \n ')).toBe('الصبر\nمفتاح الفرج')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(cleanCopiedText('  ​ \n ')).toBe('')
  })
})

describe('withSource', () => {
  it('appends the title and URL after a blank line', () => {
    expect(withSource('نص', 'الباحث الحديثي', 'https://sunnah.one/')).toBe(
      'نص\n\n— الباحث الحديثي\nhttps://sunnah.one/'
    )
  })

  it('falls back to just the URL when the page has no title', () => {
    expect(withSource('نص', '  ', 'https://sunnah.one/')).toBe('نص\n\n— https://sunnah.one/')
  })

  it('omits the attribution entirely when there is nothing to attribute', () => {
    expect(withSource('نص', '', '')).toBe('نص')
  })

  it('cleans the body on the way through', () => {
    expect(withSource('  a   b  ', 'ع', 'u')).toBe('a b\n\n— ع\nu')
  })
})

describe('formatSourceLine', () => {
  it('uses whichever of title and URL is present', () => {
    expect(formatSourceLine('عنوان', '')).toBe('— عنوان')
    expect(formatSourceLine('', 'https://x')).toBe('— https://x')
  })
})

describe('makeSource', () => {
  it('records cleaned text with a timestamp', () => {
    const source = makeSource('  الصبر  ', ' الباحث ', 'https://x')
    expect(source.text).toBe('الصبر')
    expect(source.pageTitle).toBe('الباحث')
    expect(Number.isNaN(Date.parse(source.at))).toBe(false)
  })
})

describe('appendToActiveDraft', () => {
  const draftOf = (ws: ReturnType<typeof W.defaultWorkspace>, id: string): DraftTab =>
    W.activeTab(W.findDiscussion(ws, id)!, 'draft')!

  it('opens a draft when the discussion has none', () => {
    const base = W.createDiscussion(W.defaultWorkspace(), 'حوار')
    const id = base.activeDiscussionId!
    const next = W.appendToActiveDraft(base, id, 'أول اقتباس')

    expect(W.tabsOfKind(W.findDiscussion(next, id)!, 'draft')).toHaveLength(1)
    expect(draftOf(next, id).content).toBe('أول اقتباس')
  })

  it('appends to the focused draft rather than opening another', () => {
    let ws = W.createDiscussion(W.defaultWorkspace(), 'حوار')
    const id = ws.activeDiscussionId!
    ws = W.appendToActiveDraft(ws, id, 'أول')
    ws = W.appendToActiveDraft(ws, id, 'ثانٍ')

    expect(W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft')).toHaveLength(1)
    expect(draftOf(ws, id).content).toBe('أول\n\nثانٍ')
  })

  it('records each source it is given', () => {
    let ws = W.createDiscussion(W.defaultWorkspace(), 'حوار')
    const id = ws.activeDiscussionId!
    ws = W.appendToActiveDraft(ws, id, 'نص', makeSource('نص', 'ع', 'https://a'))
    ws = W.appendToActiveDraft(ws, id, 'نص٢', makeSource('نص٢', 'ع', 'https://b'))

    expect(draftOf(ws, id).sources.map((s) => s.url)).toEqual(['https://a', 'https://b'])
  })

  it('targets the draft that is selected, not the newest', () => {
    let ws = W.createDiscussion(W.defaultWorkspace(), 'حوار')
    const id = ws.activeDiscussionId!
    ws = W.addDraftTab(ws, id)
    ws = W.addDraftTab(ws, id)
    const first = W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft')[0]
    ws = W.selectTab(ws, id, first.id)
    ws = W.appendToActiveDraft(ws, id, 'إلى الأول')

    expect((W.findTab(ws, id, first.id) as DraftTab).content).toBe('إلى الأول')
  })

  it('ignores empty additions', () => {
    const base = W.createDiscussion(W.defaultWorkspace(), 'حوار')
    const id = base.activeDiscussionId!
    expect(W.appendToActiveDraft(base, id, '   ')).toBe(base)
  })
})

describe('composeDraft', () => {
  const source = (url: string, pageTitle = 'الباحث الحديثي') => ({
    text: 'نص',
    pageTitle,
    url,
    at: '2026-09-26T00:00:00.000Z'
  })

  it('returns the trimmed body when sources are switched off', () => {
    expect(composeDraft('  الرد  ', [source('https://a')], false)).toBe('الرد')
  })

  it('returns the body alone when there are no sources', () => {
    expect(composeDraft('الرد', [], true)).toBe('الرد')
  })

  it('appends a numbered source list', () => {
    expect(composeDraft('الرد', [source('https://a'), source('https://b', 'بصائر')], true)).toBe(
      'الرد\n\n———\nالمصادر:\n1. الباحث الحديثي\n   https://a\n2. بصائر\n   https://b'
    )
  })

  it('cites a page once even when quoted repeatedly', () => {
    const composed = composeDraft('الرد', [source('https://a'), source('https://a')], true)
    expect(composed.match(/https:\/\/a/g)).toHaveLength(1)
  })

  it('falls back to the title when a source has no URL', () => {
    expect(composeDraft('الرد', [source('', 'مصدر ورقي')], true)).toContain('1. مصدر ورقي')
  })

  it('keeps diacritics in the body', () => {
    expect(composeDraft('الصَّبْرُ', [], true)).toBe('الصَّبْرُ')
  })
})
