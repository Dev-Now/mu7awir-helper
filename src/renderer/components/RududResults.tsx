import { useEffect, useRef, useState } from 'react'
import type { Range } from '@shared/arabic'
import { makeSource } from '@shared/text'
import type { SearchTab } from '@shared/types'
import { useApp } from '../state/store'

interface RududHit {
  id: number
  date: string
  tags: string[]
  text: string
  ranges: Range[]
}

interface RududResult {
  available: boolean
  total: number
  hits: RududHit[]
}

/** Characters of context kept either side of the first match in a collapsed card. */
const SNIPPET_PAD = 180

interface RududResultsProps {
  tab: SearchTab
}

/**
 * The مكتبة الردود tool. Unlike the web tools this renders in React, so the caller
 * hides the embedded WebContentsView while it is on screen.
 */
export function RududResults({ tab }: RududResultsProps): React.JSX.Element {
  const setSearchTabLocation = useApp((s) => s.setSearchTabLocation)
  const renameTab = useApp((s) => s.renameTab)
  const appendToActiveDraft = useApp((s) => s.appendToActiveDraft)
  const showToast = useApp((s) => s.showToast)

  const [query, setQuery] = useState(tab.query)
  const [result, setResult] = useState<RududResult | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)

  // Re-run whenever the tab's stored query changes, including on first open.
  useEffect(() => {
    let cancelled = false
    void window.api.searchRudud(tab.query).then((r) => {
      if (!cancelled) setResult(r as RududResult)
    })
    return () => {
      cancelled = true
    }
  }, [tab.query])

  useEffect(() => {
    setQuery(tab.query)
  }, [tab.query])

  const run = (next: string): void => {
    setExpanded(new Set())
    setSearchTabLocation(tab.id, '', next)
    renameTab(tab.id, next.trim() || 'مكتبة الردود')
  }

  const copy = async (hit: RududHit): Promise<void> => {
    await window.api.writeClipboard(hit.text)
    showToast('نُسخ الرد')
  }

  const toDraft = (hit: RududHit): void => {
    appendToActiveDraft(hit.text, makeSource(hit.text, `مكتبة الردود #${hit.id}`, ''))
    showToast('أُضيف إلى الرد')
  }

  return (
    <div className="rudud" data-testid="rudud">
      <div className="rudud__search">
        <input
          ref={inputRef}
          className="rudud__input"
          data-testid="rudud-query"
          dir="auto"
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
          {result ? (result.available ? `${result.total} نتيجة` : '') : '…'}
        </span>
      </div>

      {result && !result.available && (
        <div className="pane__empty" dir="auto">
          لم تُبنَ مكتبة الردود بعد — شغّل <code>npm run build:rudud</code>
        </div>
      )}

      {result?.available && result.hits.length === 0 && (
        <div className="pane__empty" dir="auto">
          لا نتائج لـ «{tab.query}»
        </div>
      )}

      <ul className="rudud__list" data-testid="rudud-list">
        {result?.hits.map((hit) => {
          const open = expanded.has(hit.id)
          return (
            <li key={hit.id} className="rudud__item" data-testid="rudud-hit" dir="rtl">
              <div className="rudud__meta">
                {hit.tags.slice(0, 4).map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="rudud__tag"
                    title="ابحث بهذا الوسم"
                    onClick={() => {
                      setQuery(tag)
                      run(tag)
                    }}
                  >
                    {tag}
                  </button>
                ))}
                <span className="rudud__date">{hit.date.slice(0, 10)}</span>
              </div>

              <div
                className={`rudud__text${open ? ' rudud__text--open' : ''}`}
                data-testid="rudud-text"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(hit.id)) next.add(hit.id)
                    return next
                  })
                }
              >
                {renderHighlighted(hit, open)}
              </div>

              <div className="rudud__actions">
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  data-testid="rudud-copy"
                  onClick={() => void copy(hit)}
                >
                  نسخ
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  data-testid="rudud-to-draft"
                  onClick={() => toDraft(hit)}
                >
                  ← إلى الرد
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Render the hit with its matches marked. Collapsed cards show a window around the
 * first match rather than the top of the message, so the reason it matched is visible.
 */
function renderHighlighted(hit: RududHit, open: boolean): React.ReactNode {
  const first = hit.ranges[0]
  const windowStart = open || !first ? 0 : Math.max(0, first.start - SNIPPET_PAD)
  const windowEnd = open ? hit.text.length : Math.min(hit.text.length, windowStart + SNIPPET_PAD * 3)

  const parts: React.ReactNode[] = []
  let at = windowStart
  hit.ranges.forEach((range, i) => {
    if (range.end <= windowStart || range.start >= windowEnd) return
    if (range.start > at) parts.push(hit.text.slice(at, range.start))
    parts.push(<mark key={i}>{hit.text.slice(range.start, range.end)}</mark>)
    at = range.end
  })
  if (at < windowEnd) parts.push(hit.text.slice(at, windowEnd))

  return (
    <>
      {windowStart > 0 && '… '}
      {parts}
      {windowEnd < hit.text.length && ' …'}
    </>
  )
}
