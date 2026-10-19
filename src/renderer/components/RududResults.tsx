import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeArabic, type Range } from '@shared/arabic'
import {
  parseRududView,
  rududTagView,
  rududTopicView,
  type RududHit,
  type RududHitPart,
  type RududNavCategory,
  type RududNavItem,
  type RududResult
} from '@shared/rudud'
import { makeSource } from '@shared/text'
import type { SearchTab } from '@shared/types'
import { useApp } from '../state/store'

/** Characters of context kept either side of the first match in a collapsed card. */
const SNIPPET_PAD = 180
const HOME_TITLE = 'مكتبة الردود'

interface RududResultsProps {
  tab: SearchTab
}

/**
 * The مكتبة الردود tool: the channel's table of contents on one side, and either search
 * results or one whole topic on the other. Unlike the web tools this renders in React, so
 * the caller hides the embedded WebContentsView while it is on screen.
 *
 * Everything the panel shows lives on the tab — the search in `query`, the open topic in
 * `url` (see `RududView`) — so a restored tab reopens exactly where it was left.
 */
export function RududResults({ tab }: RududResultsProps): React.JSX.Element {
  const setSearchTabLocation = useApp((s) => s.setSearchTabLocation)
  const renameTab = useApp((s) => s.renameTab)

  const [query, setQuery] = useState(tab.query)
  const [nav, setNav] = useState<RududNavCategory[] | null>(null)
  const [result, setResult] = useState<RududResult | null>(null)
  const [opened, setOpened] = useState<RududHit[] | null>(null)
  const [tocOpen, setTocOpen] = useState(true)

  const view = parseRududView(tab.url)

  useEffect(() => {
    void window.api.rududNav().then(setNav)
  }, [])

  // Re-run whenever the tab's stored query changes, including on first open.
  useEffect(() => {
    let cancelled = false
    void window.api.searchRudud(tab.query).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => {
      cancelled = true
    }
  }, [tab.query])

  useEffect(() => {
    setQuery(tab.query)
  }, [tab.query])

  // The open topic is highlighted with the search that led to it, if any.
  useEffect(() => {
    let cancelled = false
    const target = parseRududView(tab.url)
    if (!target) {
      setOpened(null)
      return
    }
    const load =
      target.kind === 'tag'
        ? window.api.rududTag(target.value, tab.query).then((r) => r.hits)
        : window.api.rududTopic(target.value, tab.query).then((hit) => (hit ? [hit] : []))
    void load.then((hits) => {
      if (!cancelled) setOpened(hits)
    })
    return () => {
      cancelled = true
    }
  }, [tab.url, tab.query])

  const run = (next: string): void => {
    setSearchTabLocation(tab.id, '', next)
    renameTab(tab.id, next.trim() || HOME_TITLE)
  }

  const open = (target: string, title: string): void => {
    setSearchTabLocation(tab.id, target)
    renameTab(tab.id, title)
  }

  const back = (): void => {
    setSearchTabLocation(tab.id, '')
    renameTab(tab.id, tab.query.trim() || HOME_TITLE)
  }

  const currentKeys = new Set(opened?.map((h) => h.key) ?? [])
  const available = result?.available ?? true

  return (
    <div className="rudud" data-testid="rudud">
      <div className="rudud__search">
        <button
          type="button"
          className={`icon-btn${tocOpen ? ' icon-btn--on' : ''}`}
          title={tocOpen ? 'إخفاء الفهرس' : 'إظهار الفهرس'}
          data-testid="rudud-toc-toggle"
          onClick={() => setTocOpen((v) => !v)}
        >
          ☰
        </button>
        <input
          className="rudud__input"
          data-testid="rudud-query"
          dir={query ? 'auto' : 'rtl'}
          placeholder="ابحث في مكتبة الردود…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') run(query)
            else if (e.key === 'Escape') setQuery(tab.query)
          }}
        />
        <button type="button" className="btn btn--small" data-testid="rudud-run" onClick={() => run(query)}>
          بحث
        </button>
        <span className="rudud__count" data-testid="rudud-count">
          {result ? (result.available && tab.query.trim() ? `${result.total} موضوع` : '') : '…'}
        </span>
      </div>

      {!available ? (
        <div className="pane__empty" dir="auto">
          لم تُبنَ مكتبة الردود بعد — شغّل <code>npm run build:rudud</code>
        </div>
      ) : (
        <div className={`rudud__body${tocOpen ? ' rudud__body--toc' : ''}`} dir="rtl">
          {tocOpen && (
            <RududToc
              nav={nav}
              current={tab.url}
              currentKeys={currentKeys}
              onOpen={(item) => open(item.view, item.title)}
            />
          )}

          <div className="rudud__main">
            {view ? (
              <TopicView
                hits={opened}
                backLabel={tab.query.trim() ? `→ نتائج «${tab.query.trim()}»` : '→ الفهرس'}
                onBack={back}
                onTag={(tag) => open(rududTagView(tag), tag)}
              />
            ) : tab.query.trim() ? (
              <SearchResults
                result={result}
                query={tab.query}
                onOpen={(hit) => open(rududTopicView(hit.key), hit.title)}
                onTag={(tag) => open(rududTagView(tag), tag)}
              />
            ) : (
              <Welcome nav={nav} onShowToc={() => setTocOpen(true)} tocOpen={tocOpen} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── table of contents ─────────────────────────────────────────────────────────

interface RududTocProps {
  nav: RududNavCategory[] | null
  current: string
  currentKeys: Set<string>
  onOpen: (item: RududNavItem) => void
}

function RududToc({ nav, current, currentKeys, onOpen }: RududTocProps): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const listRef = useRef<HTMLDivElement>(null)

  const isCurrent = (item: RududNavItem): boolean =>
    item.view === current || (current !== '' && item.keys.some((k) => currentKeys.has(k)))

  // Opening a topic from search reveals where it is filed.
  useEffect(() => {
    if (!nav || currentKeys.size === 0) return
    const holding = nav.filter((c) => c.sections.some((s) => s.items.some(isCurrent)))
    if (holding.length === 0) return
    setExpanded((prev) => {
      if (holding.every((c) => prev.has(c.id))) return prev
      return new Set([...prev, ...holding.map((c) => c.id)])
    })
  }, [nav, current, [...currentKeys].join('|')])

  useEffect(() => {
    listRef.current?.querySelector('.rudud-toc__item--current')?.scrollIntoView({ block: 'nearest' })
  }, [expanded, current])

  const wanted = normalizeArabic(filter)
  const shown = useMemo(() => {
    if (!nav || !wanted) return nav
    return nav
      .map((category) => ({
        ...category,
        sections: category.sections
          .map((section) => ({
            ...section,
            items: section.items.filter((item) =>
              normalizeArabic(`${item.title} ${item.note ?? ''}`).includes(wanted)
            )
          }))
          .filter((section) => section.items.length > 0)
      }))
      .filter((category) => category.sections.length > 0)
  }, [nav, wanted])

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <nav className="rudud-toc" data-testid="rudud-toc">
      <input
        className="rudud-toc__filter"
        data-testid="rudud-toc-filter"
        dir="rtl"
        placeholder="تصفية الفهرس…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') setFilter('')
        }}
      />
      <div className="rudud-toc__list" ref={listRef}>
        {!shown && <div className="rudud-toc__empty">…</div>}
        {shown?.length === 0 && <div className="rudud-toc__empty">لا مواضيع تطابق «{filter}»</div>}
        {shown?.map((category) => {
          const open = !!wanted || expanded.has(category.id)
          const count = category.sections.reduce((n, s) => n + s.items.length, 0)
          return (
            <div key={category.id} className="rudud-toc__category" data-testid="rudud-toc-category">
              <button
                type="button"
                className="rudud-toc__category-title"
                aria-expanded={open}
                onClick={() => toggle(category.id)}
              >
                <span className="rudud-toc__chevron">{open ? '▾' : '◂'}</span>
                <span className="rudud-toc__label">{category.title}</span>
                <span className="rudud-toc__count">{count}</span>
              </button>
              {open &&
                category.sections.map((section, s) => (
                  <div key={s} className="rudud-toc__section">
                    {section.title && <div className="rudud-toc__section-title">{section.title}</div>}
                    <ul className="rudud-toc__items">
                      {section.items.map((item, i) => (
                        <li key={i}>
                          <button
                            type="button"
                            className={`rudud-toc__item${isCurrent(item) ? ' rudud-toc__item--current' : ''}`}
                            data-testid="rudud-toc-item"
                            disabled={item.keys.length === 0}
                            title={item.note ?? item.title}
                            onClick={() => onOpen(item)}
                          >
                            <span className="rudud-toc__label">
                              {item.title}
                              {item.note && <span className="rudud-toc__note"> — {item.note}</span>}
                            </span>
                            <span className="rudud-toc__count">
                              {item.mediaOnly ? '▶' : item.parts > 1 ? item.parts : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </nav>
  )
}

// ── main area ─────────────────────────────────────────────────────────────────

function Welcome({
  nav,
  tocOpen,
  onShowToc
}: {
  nav: RududNavCategory[] | null
  tocOpen: boolean
  onShowToc: () => void
}): React.JSX.Element {
  const topics = nav?.reduce((n, c) => n + c.sections.reduce((m, s) => m + s.items.length, 0), 0) ?? 0
  return (
    <div className="pane__empty rudud__welcome" data-testid="rudud-welcome">
      <p>
        {nav ? `الفهرس: ${topics} موضوع في ${nav.length} باب` : '…'} — اختر موضوعًا من الفهرس، أو ابحث بكلمة.
      </p>
      {!tocOpen && (
        <button type="button" className="btn btn--small btn--ghost" onClick={onShowToc}>
          إظهار الفهرس
        </button>
      )}
    </div>
  )
}

interface SearchResultsProps {
  result: RududResult | null
  query: string
  onOpen: (hit: RududHit) => void
  onTag: (tag: string) => void
}

function SearchResults({ result, query, onOpen, onTag }: SearchResultsProps): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => setExpanded(new Set()), [query])

  if (!result) return <div className="pane__empty">…</div>
  if (result.hits.length === 0) {
    return (
      <div className="pane__empty" dir="auto">
        لا نتائج لـ «{query}»
      </div>
    )
  }

  return (
    <ul className="rudud__list" data-testid="rudud-list">
      {result.hits.map((hit) => {
        const open = expanded.has(hit.key)
        // The snippet comes from the first part that matched, so the reason is visible.
        const first = hit.parts.find((p) => p.ranges.length > 0) ?? hit.parts[0]
        return (
          <li key={hit.key} className="rudud__item" data-testid="rudud-hit">
            <TopicHeader hit={hit} onTitle={() => onOpen(hit)} onTag={onTag} />

            {hit.mediaOnly ? (
              <MediaOnly />
            ) : (
              <div
                className={`rudud__text${open ? ' rudud__text--open' : ''}`}
                data-testid="rudud-text"
                title={open ? 'طيّ' : 'عرض الموضوع كاملًا'}
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(hit.key)) next.add(hit.key)
                    return next
                  })
                }
              >
                {open
                  ? hit.parts.map((part, i) => (
                      <div key={part.id} className="rudud__part-inline">
                        {i > 0 && <hr className="rudud__divider" />}
                        {part.heading && <div className="rudud__heading">{part.heading}</div>}
                        {highlight(part.text, part.ranges, 0, part.text.length)}
                      </div>
                    ))
                  : first && renderSnippet(first)}
              </div>
            )}

            <TopicActions hit={hit} />
          </li>
        )
      })}
    </ul>
  )
}

interface TopicViewProps {
  hits: RududHit[] | null
  backLabel: string
  onBack: () => void
  onTag: (tag: string) => void
}

/** One topic — or every topic filed under a tag — shown whole, parts in order. */
function TopicView({ hits, backLabel, onBack, onTag }: TopicViewProps): React.JSX.Element {
  const topRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    topRef.current?.scrollTo({ top: 0 })
  }, [hits])

  return (
    <div className="rudud__topic" ref={topRef} data-testid="rudud-topic">
      <button type="button" className="rudud__back" data-testid="rudud-back" onClick={onBack}>
        {backLabel}
      </button>

      {hits?.length === 0 && <div className="pane__empty">لم يُعثر على هذا الموضوع</div>}

      {hits?.map((hit) => (
        <article key={hit.key} className="rudud__article" data-testid="rudud-article">
          <TopicHeader hit={hit} onTag={onTag} large />
          {hit.mediaOnly && <MediaOnly />}
          {hit.parts.map((part, i) => (
            <section key={part.id} className="rudud__part" data-testid="rudud-part" data-id={part.id}>
              {i > 0 && <hr className="rudud__divider" />}
              {part.heading && <div className="rudud__heading">{part.heading}</div>}
              <div className="rudud__text rudud__text--open rudud__text--selectable" data-testid="rudud-text">
                {highlight(part.text, part.ranges, 0, part.text.length)}
              </div>
              {hit.parts.length > 1 && <PartActions hit={hit} part={part} index={i} />}
            </section>
          ))}
          <TopicActions hit={hit} />
        </article>
      ))}
    </div>
  )
}

function TopicHeader({
  hit,
  onTitle,
  onTag,
  large
}: {
  hit: RududHit
  onTitle?: () => void
  onTag: (tag: string) => void
  large?: boolean
}): React.JSX.Element {
  const dates =
    hit.firstDate.slice(0, 10) === hit.lastDate.slice(0, 10)
      ? hit.firstDate.slice(0, 10)
      : `${hit.firstDate.slice(0, 10)} — ${hit.lastDate.slice(0, 10)}`
  const title = highlight(hit.title, hit.titleRanges, 0, hit.title.length)
  return (
    <header className="rudud__header">
      {hit.place && (
        <div className="rudud__place" data-testid="rudud-place">
          {hit.place.category}
          {hit.place.section && hit.place.section !== hit.place.category && ` › ${hit.place.section}`}
        </div>
      )}
      {onTitle ? (
        <button type="button" className="rudud__title" data-testid="rudud-title" onClick={onTitle}>
          {title}
        </button>
      ) : (
        <h2 className={`rudud__title${large ? ' rudud__title--large' : ''}`} data-testid="rudud-title">
          {title}
        </h2>
      )}
      <div className="rudud__meta">
        {hit.tags.slice(0, 4).map((tag) => (
          <button
            key={tag}
            type="button"
            className="rudud__tag"
            title="كل ما نُشر بهذا الوسم"
            onClick={() => onTag(tag)}
          >
            {tag}
          </button>
        ))}
        {hit.parts.length > 1 && <span className="rudud__parts">{hit.parts.length} أجزاء</span>}
        <span className="rudud__date">{dates}</span>
      </div>
    </header>
  )
}

function MediaOnly(): React.JSX.Element {
  return <div className="rudud__media">نُشر هذا الموضوع في القناة مقطعَ فيديو فقط، بلا نص.</div>
}

const topicText = (hit: RududHit): string => hit.parts.map((p) => p.text).join('\n\n')

function TopicActions({ hit }: { hit: RududHit }): React.JSX.Element | null {
  const appendToActiveDraft = useApp((s) => s.appendToActiveDraft)
  const showToast = useApp((s) => s.showToast)
  if (hit.parts.length === 0) return null

  const text = topicText(hit)
  return (
    <div className="rudud__actions">
      <button
        type="button"
        className="btn btn--small btn--ghost"
        data-testid="rudud-copy"
        onClick={() =>
          void window.api.writeClipboard(text).then(() => showToast('نُسخ الموضوع'))
        }
      >
        {hit.parts.length > 1 ? 'نسخ الموضوع' : 'نسخ'}
      </button>
      <button
        type="button"
        className="btn btn--small"
        data-testid="rudud-to-draft"
        onClick={() => {
          appendToActiveDraft(text, makeSource(text, `${HOME_TITLE} — ${hit.title}`, ''))
          showToast('أُضيف إلى الرد')
        }}
      >
        ← إلى الرد
      </button>
    </div>
  )
}

function PartActions({ hit, part, index }: { hit: RududHit; part: RududHitPart; index: number }): React.JSX.Element {
  const appendToActiveDraft = useApp((s) => s.appendToActiveDraft)
  const showToast = useApp((s) => s.showToast)
  return (
    <div className="rudud__actions rudud__actions--part">
      <span className="rudud__part-label">
        الجزء {index + 1} من {hit.parts.length}
      </span>
      <button
        type="button"
        className="btn btn--small btn--ghost"
        data-testid="rudud-copy-part"
        onClick={() => void window.api.writeClipboard(part.text).then(() => showToast('نُسخ الجزء'))}
      >
        نسخ الجزء
      </button>
      <button
        type="button"
        className="btn btn--small btn--ghost"
        data-testid="rudud-part-to-draft"
        onClick={() => {
          appendToActiveDraft(part.text, makeSource(part.text, `${HOME_TITLE} — ${hit.title}`, ''))
          showToast('أُضيف إلى الرد')
        }}
      >
        ← الجزء إلى الرد
      </button>
    </div>
  )
}

// ── highlighting ──────────────────────────────────────────────────────────────

/**
 * A collapsed card shows a window around the first match rather than the top of the
 * message, so the reason it matched is visible.
 */
function renderSnippet(part: RududHitPart): React.ReactNode {
  const first = part.ranges[0]
  const start = first ? Math.max(0, first.start - SNIPPET_PAD) : 0
  const end = Math.min(part.text.length, start + SNIPPET_PAD * 3)
  return (
    <>
      {start > 0 && '… '}
      {highlight(part.text, part.ranges, start, end)}
      {end < part.text.length && ' …'}
    </>
  )
}

/** `text[start, end)` with the ranges inside it wrapped in `<mark>`. */
function highlight(text: string, ranges: Range[], start: number, end: number): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  let at = start
  ranges.forEach((range, i) => {
    if (range.end <= start || range.start >= end) return
    const from = Math.max(range.start, at)
    if (from > at) parts.push(text.slice(at, from))
    parts.push(<mark key={i}>{text.slice(from, Math.min(range.end, end))}</mark>)
    at = Math.min(range.end, end)
  })
  if (at < end) parts.push(text.slice(at, end))
  return parts
}
