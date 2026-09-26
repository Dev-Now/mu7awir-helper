import { useEffect, useRef, useState } from 'react'
import type { SearchTool } from '@shared/types'

interface NewSearchPromptProps {
  tools: SearchTool[]
  onSubmit: (tool: SearchTool, query: string) => void
  onCancel: () => void
}

/**
 * Overlay for starting a search: pick a tool, type a query.
 *
 * It covers the pane, so the caller hides the embedded view while it is open — a
 * WebContentsView is an OS overlay and would otherwise be painted on top of this.
 */
export function NewSearchPrompt({
  tools,
  onSubmit,
  onCancel
}: NewSearchPromptProps): React.JSX.Element {
  const usable = tools.filter((t) => t.enabled)
  const [toolId, setToolId] = useState(usable[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const tool = usable.find((t) => t.id === toolId)

  const submit = (): void => {
    if (tool) onSubmit(tool, query)
  }

  return (
    <div className="prompt" data-testid="new-search-prompt">
      <div className="prompt__card">
        <div className="prompt__tools">
          {usable.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`prompt__tool${t.id === toolId ? ' prompt__tool--active' : ''}`}
              data-testid="prompt-tool"
              data-tool={t.id}
              data-active={t.id === toolId || undefined}
              onClick={() => {
                setToolId(t.id)
                inputRef.current?.focus()
              }}
            >
              <span className="prompt__tool-label" dir="auto">
                {t.label}
              </span>
              <span className="prompt__tool-key">{t.shortcut.replace('Ctrl+', '^')}</span>
            </button>
          ))}
        </div>

        <input
          ref={inputRef}
          className="prompt__input"
          data-testid="prompt-query"
          dir="auto"
          placeholder={tool?.searchUrl ? 'اكتب كلمات البحث…' : 'سيُفتح الموقع لتبحث فيه مباشرة'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') onCancel()
          }}
        />

        <div className="prompt__actions">
          <button type="button" className="btn" data-testid="prompt-submit" onClick={submit}>
            فتح
          </button>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            إلغاء
          </button>
        </div>
      </div>
    </div>
  )
}
