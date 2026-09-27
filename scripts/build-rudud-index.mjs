/**
 * Builds the مكتبة الردود search index from the exported Telegram channel.
 *
 * The channel's convention is a short hashtag-only message announcing a topic, followed
 * by the body message(s). Those headers carry the only topic labels the corpus has, so
 * they are folded into the messages that follow rather than indexed as documents.
 *
 * Output: resources/rudud.json — `[{ id, date, tags, text }]`. Normalisation happens at
 * index and query time (see src/shared/arabic.ts), so nothing pre-folded is stored and
 * there is only one implementation of the rules.
 *
 * Usage: npm run build:rudud
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(root, 'doc', 'ChatExport_2026-09-24__JSON', 'result.json')
const TARGET = path.join(root, 'resources', 'rudud.json')

/** A header's topic is carried this far. Runs longer than this are the topic having
 *  lapsed without a new header — median run length in this export is 1. */
const MAX_INHERIT = 6
/** Below this, a message is a header or a stray emoji, not something worth finding. */
const MIN_BODY_LENGTH = 10

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{FE0F}\u{20E3}\u{2B00}-\u{2BFF}]/gu

const entities = (message) => message.text_entities ?? []
const fullText = (message) => entities(message).map((e) => e.text).join('')
const hashtags = (message) =>
  entities(message)
    .filter((e) => e.type === 'hashtag')
    .map((e) => e.text)

/** What is left once hashtags and decoration are removed — the actual content. */
const bodyOnly = (message) =>
  entities(message)
    .filter((e) => e.type !== 'hashtag')
    .map((e) => e.text)
    .join('')
    .replace(EMOJI, '')
    .trim()

export function buildIndex(exported) {
  const documents = []
  let inherited = []
  let inheritedFor = 0
  let headers = 0
  let skipped = 0

  for (const message of exported.messages ?? []) {
    if (message.type !== 'message') continue

    const text = fullText(message).trim()
    if (!text) {
      skipped++ // stickers, photos and other media carry no searchable text
      continue
    }

    const own = hashtags(message)
    const body = bodyOnly(message)

    if (own.length > 0 && body.length < MIN_BODY_LENGTH) {
      inherited = own
      inheritedFor = 0
      headers++
      continue
    }

    if (body.length < MIN_BODY_LENGTH) {
      skipped++
      continue
    }

    let tags
    if (own.length > 0) {
      // A message that labels itself starts its own topic.
      tags = own
      inherited = []
      inheritedFor = 0
    } else if (inheritedFor < MAX_INHERIT) {
      tags = inherited
      inheritedFor++
    } else {
      tags = []
    }

    documents.push({
      id: message.id,
      date: message.date,
      tags: [...new Set(tags)],
      text
    })
  }

  return { documents, stats: { headers, skipped } }
}

/** Run the build only when invoked as a script, so tests can import `buildIndex`. */
function main() {
  const exported = JSON.parse(readFileSync(SOURCE, 'utf8'))
  const { documents, stats } = buildIndex(exported)

  mkdirSync(path.dirname(TARGET), { recursive: true })
  writeFileSync(TARGET, JSON.stringify(documents), 'utf8')

  const tagged = documents.filter((d) => d.tags.length > 0).length
  const distinct = new Set(documents.flatMap((d) => d.tags)).size
  console.log(
    `rudud: ${documents.length} documents from "${exported.name}" ` +
      `(${stats.headers} headers folded in, ${stats.skipped} untexted messages skipped)`
  )
  console.log(`rudud: ${tagged} tagged, ${distinct} distinct topics → ${path.relative(root, TARGET)}`)

  if (documents.length < 500) {
    console.error('rudud: suspiciously few documents — check the export path')
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
