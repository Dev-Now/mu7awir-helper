/**
 * Builds the مكتبة الردود library from the exported Telegram channel.
 *
 * The channel is written as topics: a short hashtag header announcing the topic
 * (`#البلاء 👇`), one or more body messages, and often a closing `… 👆` marker. It also
 * keeps a pinned table of contents — the `#فهرس_N` messages — that files every topic
 * hashtag under a category and a section. Both structures are recovered here, so the app
 * can show whole topics in order instead of loose messages.
 *
 * Output: resources/rudud.json — `{ toc, topics }`. Normalisation happens at index and
 * query time (see src/shared/arabic.ts), so nothing pre-folded is stored and there is
 * only one implementation of the rules.
 *
 * Usage: npm run build:rudud
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(root, 'doc', 'ChatExport_2026-09-24__JSON', 'result.json')
const TARGET = path.join(root, 'resources', 'rudud.json')

/** Below this, a message is a header or a stray emoji, not something worth finding. */
const MIN_BODY_LENGTH = 10
/** A `👆` message shorter than this closes the topic above it rather than adding to it. */
const MAX_CLOSER_LENGTH = 120
/** An untagged `… 👇` message shorter than this is a header for the messages below. */
const MAX_HEADER_LENGTH = 60
/** A pause this long between messages means the topic has ended without a closer. */
const TOPIC_GAP_SECONDS = 12 * 60 * 60
/** Section headings in the table of contents are short, decorated lines. */
const MAX_SECTION_LENGTH = 40

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{FE0F}\u{20E3}\u{2B00}-\u{2BFF}]/gu
const HAS_EMOJI = new RegExp(EMOJI.source, 'u')
const LETTER = /\p{L}/u
const TOC_TAG = /^#فهرس_\d+$/

const entities = (message) => message.text_entities ?? []
const fullText = (message) => entities(message).map((e) => e.text).join('')
const hashtags = (message) =>
  entities(message)
    .filter((e) => e.type === 'hashtag')
    .map((e) => e.text)

/** Text with decoration and filler punctuation removed, for titles and comparisons. */
const clean = (text) =>
  text
    .replace(EMOJI, '')
    .replace(/[_*•|.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** What is left once hashtags and decoration are removed — the actual content. */
const bodyOnly = (message) =>
  entities(message)
    .filter((e) => e.type !== 'hashtag')
    .map((e) => e.text)
    .join('')
    .replace(EMOJI, '')
    .trim()

/** The hashtags a message opens with, ignoring decoration between them. */
function leadingHashtags(message) {
  const run = []
  for (const entity of entities(message)) {
    if (entity.type === 'hashtag') run.push(entity.text)
    else if (entity.text.replace(EMOJI, '').trim()) break
  }
  return run
}

const isTocMessage = (message) => hashtags(message).some((t) => TOC_TAG.test(t))

/** `#شبهة_الرق` → «شبهة الرق». */
export const tagTitle = (tag) => tag.replace(/^#/, '').replace(/_+/g, ' ').trim()

/**
 * Split a message into lines of entities, so a hashtag and the note written after it on
 * the same line stay together.
 */
function lines(message) {
  const out = [[]]
  for (const entity of entities(message)) {
    if (entity.type === 'hashtag') {
      out[out.length - 1].push({ tag: entity.text })
      continue
    }
    entity.text.split('\n').forEach((piece, i) => {
      if (i > 0) out.push([])
      if (piece) out[out.length - 1].push({ text: piece })
    })
  }
  return out.filter((line) => line.length > 0)
}

/**
 * Recover the channel's table of contents.
 *
 * The master message lists every `#فهرس_N` with a short title; each category message
 * then lists its topics, grouped under decorated section headings like «🍀 المرأة🍀».
 */
export function parseToc(messages) {
  const tocMessages = messages.filter((m) => m.type === 'message' && isTocMessage(m))

  // The master is the one naming several categories and nothing else.
  const master = tocMessages.find((m) => hashtags(m).filter((t) => TOC_TAG.test(t)).length > 1)
  const titles = new Map()
  const order = []
  if (master) {
    let current = null
    for (const line of lines(master)) {
      for (const part of line) {
        if (part.tag && TOC_TAG.test(part.tag)) {
          current = part.tag
          order.push(current)
          titles.set(current, [])
        } else if (part.text && current) {
          const text = clean(part.text)
          if (LETTER.test(text)) titles.get(current).push(text)
        }
      }
    }
  }

  const categories = new Map()
  for (const message of tocMessages) {
    if (message === master) continue
    const own = hashtags(message).filter((t) => TOC_TAG.test(t))
    if (own.length !== 1) continue
    const id = own[0]

    const sections = [{ title: '', topics: [] }]
    const seen = new Set()
    for (const line of lines(message)) {
      const tags = line.filter((p) => p.tag && !TOC_TAG.test(p.tag))
      if (tags.length === 0) {
        if (line.some((p) => p.tag)) continue // the category's own heading
        const raw = line.map((p) => p.text).join('')
        const text = clean(raw)
        if (HAS_EMOJI.test(raw) && LETTER.test(text) && text.length <= MAX_SECTION_LENGTH) {
          sections.push({ title: text, topics: [] })
          seen.clear()
        }
        continue
      }

      const section = sections[sections.length - 1]
      line.forEach((part, i) => {
        if (!part.tag || TOC_TAG.test(part.tag) || seen.has(part.tag)) return
        seen.add(part.tag)
        // The note is whatever follows the tag on its line, up to the next tag.
        const after = []
        for (const next of line.slice(i + 1)) {
          if (next.tag) break
          after.push(next.text)
        }
        const note = clean(after.join(''))
        section.topics.push(LETTER.test(note) ? { tag: part.tag, note } : { tag: part.tag })
      })
    }

    categories.set(id, {
      id: id.slice(1),
      title: (titles.get(id) ?? []).join(' · ') || sections.find((s) => s.title)?.title || tagTitle(id),
      sections: sections.filter((s) => s.topics.length > 0)
    })
  }

  // Master order first; any category the master forgot to list goes last.
  const ids = [...order.filter((id) => categories.has(id)), ...[...categories.keys()].filter((id) => !order.includes(id))]
  return ids.map((id) => categories.get(id))
}

/**
 * Group the channel's messages into topics.
 *
 * A topic starts at a hashtag header (or an untagged `… 👇` header), runs through the
 * messages that follow, and ends at a `👆` closer, the next header, or a long pause.
 * Topics posted more than once under the same hashtag are merged, parts in posting order.
 */
export function buildLibrary(exported) {
  const messages = (exported.messages ?? []).filter((m) => m.type === 'message')
  const toc = parseToc(messages)
  const listed = new Set(toc.flatMap((c) => c.sections.flatMap((s) => s.topics.map((t) => t.tag))))

  const byKey = new Map()
  const topics = []
  let current = null
  let lastAt = 0
  const stats = { messages: 0, headers: 0, closers: 0, skipped: 0 }

  const open = (key, init, date) => {
    let topic = byKey.get(key)
    if (!topic) {
      topic = { key, ...init, date, tags: [], parts: [] }
      byKey.set(key, topic)
      topics.push(topic)
    }
    topic.heading = null
    topic.fed = false
    return topic
  }

  const append = (topic, message, text) => {
    const part = { id: message.id, date: message.date, text }
    if (topic.heading) part.heading = topic.heading
    topic.heading = null
    topic.parts.push(part)
    stats.messages++
  }

  for (const message of messages) {
    if (isTocMessage(message)) continue

    const at = Number(message.date_unixtime) || Date.parse(message.date) / 1000
    // A header waits for its body however long it takes; once fed, a pause ends it.
    if (current && (current.parts.length > 0 || current.fed) && at - lastAt > TOPIC_GAP_SECONDS) {
      current = null
    }

    const text = fullText(message).trim()
    if (!text) {
      // Stickers, photos and videos carry no searchable text, but a video can be the
      // whole answer to the header above it.
      if (current && message.media_type && message.media_type !== 'sticker') {
        current.fed = current.media = true
        lastAt = at
      }
      stats.skipped++
      continue
    }

    const body = bodyOnly(message)
    const tags = hashtags(message)

    if (text.includes('👆') && text.length < MAX_CLOSER_LENGTH) {
      stats.closers++
      current = null
      continue
    }

    // A header is a short tagged line, or a message opening with a listed topic tag. A
    // body message that merely starts with an inline tag («#فتدبر …») is not a header.
    const lead = leadingHashtags(message)
    const short = body.length < MAX_HEADER_LENGTH
    const headerTags = tags.length > 0 && short ? tags : lead.some((t) => listed.has(t)) ? lead : []
    if (headerTags.length > 0) {
      stats.headers++
      // The last listed tag is the most specific: «#تناقضات_الأناجيل #عمر_أخزيا».
      const primary = [...headerTags].reverse().find((t) => listed.has(t)) ?? headerTags[0]
      // A header followed straight by another header is its parent: «#البشارة… 👇» then
      // «#في_اليهودية_المسيحية 👇». The parent's tags lead to the child's content.
      const parent = current && current.kind === 'tag' && current.parts.length === 0 && !current.fed ? current : null
      current = open(primary, { tag: primary, kind: 'tag', title: tagTitle(primary) }, message.date)
      for (const tag of [primary, ...headerTags, ...(parent && parent !== current ? parent.tags : [])]) {
        if (!current.tags.includes(tag)) current.tags.push(tag)
      }
      lastAt = at
      // A short header is usually just a label, unless it carries the link that is the answer.
      if (!short || /https?:\/\//.test(body)) append(current, message, text)
      else if (LETTER.test(clean(body))) current.heading = clean(body)
      continue
    }

    if (body.length < MIN_BODY_LENGTH) {
      stats.skipped++ // separators and stray punctuation
      continue
    }

    if (tags.length === 0 && /👇\s*$/.test(text) && short) {
      stats.headers++
      current = open(`msg-${message.id}`, { tag: null, kind: 'header', title: clean(text) }, message.date)
      lastAt = at
      continue
    }

    if (!current) {
      const title = clean(text.split('\n').find((l) => LETTER.test(l)) ?? text)
      current = open(`msg-${message.id}`, {
        tag: null,
        kind: 'untitled',
        title: title.length > 60 ? `${title.slice(0, 60).trim()}…` : title
      })
    }
    append(current, message, text)
    lastAt = at
  }

  // A topic whose only content was a video is kept, so the index can say so rather than
  // silently listing nothing.
  const kept = topics
    .filter((t) => t.parts.length > 0 || t.media)
    .map((t) => ({
      key: t.key,
      tags: t.tags,
      kind: t.kind,
      title: t.title,
      ...(t.parts.length === 0 && { mediaOnly: true }),
      firstDate: t.parts[0]?.date ?? t.date,
      lastDate: t.parts[t.parts.length - 1]?.date ?? t.date,
      parts: t.parts
    }))

  return { library: { toc, topics: kept }, stats }
}

/** Run the build only when invoked as a script, so tests can import `buildLibrary`. */
function main() {
  const exported = JSON.parse(readFileSync(SOURCE, 'utf8'))
  const { library, stats } = buildLibrary(exported)
  const { toc, topics } = library

  mkdirSync(path.dirname(TARGET), { recursive: true })
  writeFileSync(TARGET, JSON.stringify(library), 'utf8')

  const listed = new Set(toc.flatMap((c) => c.sections.flatMap((s) => s.topics.map((t) => t.tag))))
  const present = new Set(topics.flatMap((t) => t.tags))
  const empty = [...listed].filter((tag) => !present.has(tag))
  const untitled = topics.filter((t) => t.kind === 'untitled').length
  const outside = topics.filter((t) => t.tags.length > 0 && !t.tags.some((tag) => listed.has(tag))).length

  console.log(
    `rudud: ${topics.length} topics (${stats.messages} messages) from "${exported.name}" — ` +
      `${stats.headers} headers, ${stats.closers} closers, ${stats.skipped} skipped`
  )
  console.log(
    `rudud: ${toc.length} categories, ${listed.size - empty.length}/${listed.size} listed topics have content; ` +
      `${outside} tagged topics outside the index, ${untitled} untitled → ${path.relative(root, TARGET)}`
  )
  if (empty.length > 0) console.log(`rudud: listed without content: ${empty.join(' ')}`)

  if (topics.length < 300 || toc.length === 0) {
    console.error('rudud: suspiciously few topics — check the export path')
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
