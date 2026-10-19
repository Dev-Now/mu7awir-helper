/**
 * The مكتبة الردود data model, shared by the index in main and the panel in the renderer.
 *
 * The library is a set of *topics*: what the channel posts as a hashtag header followed
 * by one or more messages. The channel's own `#فهرس_N` table of contents files those
 * topics under categories and sections. Both are produced by scripts/build-rudud-index.mjs.
 */
import type { Range } from './arabic'

// ── the generated file (resources/rudud.json) ─────────────────────────────────

/** One message of a topic, in posting order. */
export interface RududPart {
  id: number
  date: string
  text: string
  /** The note written on the header that introduced this part, e.g. «وسوء الظن بالله». */
  heading?: string
}

export interface RududTopic {
  /** The primary hashtag, or `msg-<id>` for a topic introduced without one. */
  key: string
  /** Every hashtag that introduced this topic, primary first. */
  tags: string[]
  kind: 'tag' | 'header' | 'untitled'
  title: string
  /** The channel posted only a video for this topic, so there is no text to show. */
  mediaOnly?: boolean
  firstDate: string
  lastDate: string
  parts: RududPart[]
}

export interface RududTocEntry {
  tag: string
  note?: string
}

export interface RududTocSection {
  title: string
  topics: RududTocEntry[]
}

export interface RududTocCategory {
  id: string
  title: string
  sections: RududTocSection[]
}

export interface RududLibrary {
  toc: RududTocCategory[]
  topics: RududTopic[]
}

// ── what the index serves ─────────────────────────────────────────────────────

/** A table-of-contents line, resolved against the topics that actually exist. */
export interface RududNavItem {
  /** What clicking this line opens; see `RududView`. */
  view: RududView
  /** The topics it leads to — usually one; a series posted under one tag can be several. */
  keys: string[]
  title: string
  note?: string
  /** Total messages across the topics this line leads to. */
  parts: number
  mediaOnly: boolean
}

export interface RududNavSection {
  title: string
  items: RududNavItem[]
}

export interface RududNavCategory {
  id: string
  title: string
  sections: RududNavSection[]
}

/** Where a topic sits in the table of contents. */
export interface RududPlace {
  category: string
  section: string
}

export interface RududHitPart extends RududPart {
  /** Where the query matched, as offsets into the original (un-normalised) text. */
  ranges: Range[]
}

export interface RududHit {
  key: string
  tags: string[]
  kind: RududTopic['kind']
  title: string
  titleRanges: Range[]
  mediaOnly: boolean
  firstDate: string
  lastDate: string
  place: RududPlace | null
  parts: RududHitPart[]
}

export interface RududResult {
  /** False when the library has not been built yet. */
  available: boolean
  total: number
  hits: RududHit[]
}

/**
 * What the panel shows, kept in the search tab's `url` so it survives a restart:
 * `''` for search results, `rudud:tag:#…` for everything filed under a hashtag, or
 * `rudud:topic:<key>` for one topic.
 */
export type RududView = string

export const rududTagView = (tag: string): RududView => `rudud:tag:${tag}`
export const rududTopicView = (key: string): RududView => `rudud:topic:${key}`

export function parseRududView(view: string): { kind: 'tag' | 'topic'; value: string } | null {
  const match = /^rudud:(tag|topic):(.+)$/.exec(view)
  return match ? { kind: match[1] as 'tag' | 'topic', value: match[2] } : null
}

/** `#شبهة_الرق` → «شبهة الرق». */
export const tagTitle = (tag: string): string => tag.replace(/^#/, '').replace(/_+/g, ' ').trim()
