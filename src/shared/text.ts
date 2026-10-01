/**
 * Text handling for the copy pipeline, shared by the site preload and the renderer.
 *
 * The one rule that matters: Arabic diacritics are never stripped. Tashkeel is part of
 * the quotation for Quran and hadith, so cleaning is limited to invisible characters and
 * whitespace that web pages add for layout.
 */
import type { Source } from './types'

/** Zero-width and bidi-control characters that web pages sprinkle through text. */
const INVISIBLE = /[​-‏‪-‮⁠﻿]/g

export function cleanCopiedText(raw: string): string {
  return raw
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ') // runs of spaces and tabs, but not newlines
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n') // keep paragraph breaks, drop the rest
    .trim()
}

/** The attribution line appended to copied excerpts. */
export function formatSourceLine(pageTitle: string, url: string): string {
  const title = pageTitle.trim()
  if (title && url) return `— ${title}\n${url}`
  return `— ${title || url}`
}

export function withSource(text: string, pageTitle: string, url: string): string {
  const body = cleanCopiedText(text)
  const line = formatSourceLine(pageTitle, url)
  return line.trim() === '—' ? body : `${body}\n\n${line}`
}

/**
 * A draft as it goes to the clipboard: the body, optionally followed by the sources
 * gathered while writing it. Sources are de-duplicated by URL, since quoting a page
 * twice should not cite it twice.
 */
export function composeDraft(content: string, sources: Source[], appendSources: boolean): string {
  const body = content.trim()
  if (!appendSources) return body

  const seen = new Set<string>()
  const unique = sources.filter((s) => {
    const key = s.url || s.pageTitle
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length === 0) return body

  const list = unique
    .map((s, i) => (s.url ? `${i + 1}. ${s.pageTitle || s.url}\n   ${s.url}` : `${i + 1}. ${s.pageTitle}`))
    .join('\n')
  return `${body}\n\n———\nالمصادر:\n${list}`
}

export function makeSource(text: string, pageTitle: string, url: string): Source {
  return {
    text: cleanCopiedText(text),
    pageTitle: pageTitle.trim(),
    url,
    at: new Date().toISOString()
  }
}
