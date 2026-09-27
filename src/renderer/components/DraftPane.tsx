import { useEffect, useRef, useState } from 'react'
import type { Discussion, DraftTab } from '@shared/types'
import { composeDraft } from '@shared/text'
import * as W from '@shared/workspace'
import { useApp } from '../state/store'
import { TabBar } from './TabBar'

/** Writes are held back this long while the user is still typing. */
const COMMIT_DELAY_MS = 300

interface DraftPaneProps {
  discussion: Discussion | null
}

/** Bottom pane: draft tabs, a toolbar, and the RTL editor. */
export function DraftPane({ discussion }: DraftPaneProps): React.JSX.Element {
  const addDraftTab = useApp((s) => s.addDraftTab)
  const appendSources = useApp((s) => s.workspace.settings.appendSources)
  const updateSettings = useApp((s) => s.updateSettings)
  const showToast = useApp((s) => s.showToast)

  const tabs = discussion ? W.tabsOfKind(discussion, 'draft') : []
  const draft = discussion ? W.activeTab(discussion, 'draft') : null

  const copyAll = async (): Promise<void> => {
    if (!draft) return
    const text = composeDraft(draft.content, draft.sources, appendSources)
    if (!text) {
      showToast('الرد فارغ', 'warn')
      return
    }
    await window.api.writeClipboard(text)
    showToast(`نُسخ الرد كاملاً (${text.length} حرفًا)`)
  }

  // Ctrl+Shift+A copies the whole draft from anywhere in the app chrome.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'A' || event.key === 'a')) {
        event.preventDefault()
        void copyAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <section className="pane" data-testid="draft-pane">
      <TabBar
        kind="draft"
        tabs={tabs}
        activeId={discussion?.activeDraftTabId ?? null}
        newTitle="رد جديد"
        onNew={discussion ? () => addDraftTab() : undefined}
      />

      {draft && (
        <div className="draftbar" data-testid="draftbar">
          <button
            type="button"
            className="btn btn--small"
            data-testid="copy-draft"
            title="نسخ الرد كاملاً (Ctrl+Shift+A)"
            onClick={() => void copyAll()}
          >
            نسخ الرد
          </button>

          <label className="draftbar__toggle" title="إلحاق قائمة المصادر عند النسخ">
            <input
              type="checkbox"
              data-testid="append-sources"
              checked={appendSources}
              onChange={(e) => updateSettings({ appendSources: e.target.checked })}
            />
            المصادر ({draft.sources.length})
          </label>

          <span className="draftbar__count" data-testid="draft-count">
            {draft.content.length} حرفًا
          </span>
        </div>
      )}

      <div className="pane__body" data-testid="draft-view">
        {draft ? (
          // Keyed so switching tabs remounts with that draft's text.
          <DraftEditor key={draft.id} draft={draft} />
        ) : (
          <div className="pane__empty" dir="auto">
            {discussion ? 'لا يوجد رد بعد — اضغط +' : 'أنشئ مناقشة للبدء'}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * A plain textarea rather than a rich-text editor: the output is pasted into social
 * media as plain text anyway, and a textarea gives native undo, IME and selection for
 * free. Typing is committed to the store on a short debounce so long drafts do not
 * serialize the whole workspace on every keystroke.
 */
function DraftEditor({ draft }: { draft: DraftTab }): React.JSX.Element {
  const setDraftContent = useApp((s) => s.setDraftContent)
  const setDraftInsert = useApp((s) => s.setDraftInsert)
  const area = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(draft.content)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What we last handed to the store, used to tell our echoes from outside edits. */
  const committed = useRef(draft.content)
  const pending = useRef(draft.content)

  const commit = (next: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (next === committed.current) return
    committed.current = next
    setDraftContent(draft.id, next)
  }

  // Adopt edits made elsewhere, such as Ctrl+Enter from a search view.
  useEffect(() => {
    if (draft.content === committed.current) return
    committed.current = draft.content
    pending.current = draft.content
    setValue(draft.content)
  }, [draft.content])

  // Never lose the tail of a sentence when the pane unmounts or the tab changes.
  useEffect(() => () => commit(pending.current), [])

  // Let dictation drop its text at the caret rather than at the end.
  useEffect(() => {
    setDraftInsert((text) => {
      const el = area.current
      if (!el) return false
      const at = el.selectionStart ?? pending.current.length
      const end = el.selectionEnd ?? at
      const before = pending.current.slice(0, at)
      const spacer = before && !/\s$/.test(before) ? ' ' : ''
      const next = before + spacer + text + pending.current.slice(end)
      onChange(next)
      const caret = at + spacer.length + text.length
      requestAnimationFrame(() => el.setSelectionRange(caret, caret))
      return true
    })
    return () => setDraftInsert(null)
  })

  const onChange = (next: string): void => {
    pending.current = next
    setValue(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(next), COMMIT_DELAY_MS)
  }

  return (
    <textarea
      ref={area}
      className="draft-editor"
      data-testid="draft-editor"
      dir="rtl"
      lang="ar"
      spellCheck={false}
      placeholder="اكتب ردك هنا، أو الصق من نتائج البحث بالأعلى…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => commit(pending.current)}
      onKeyDown={(e) => {
        // Let the editor own its keys, except the app-level copy shortcut.
        if (!(e.ctrlKey && e.shiftKey)) e.stopPropagation()
      }}
      onPaste={(e) => {
        // Force plain text; execCommand keeps the textarea's native undo stack intact.
        const text = e.clipboardData.getData('text/plain')
        if (!text) return
        e.preventDefault()
        if (!document.execCommand('insertText', false, text)) {
          const el = e.currentTarget
          const next = value.slice(0, el.selectionStart) + text + value.slice(el.selectionEnd)
          onChange(next)
        }
      }}
    />
  )
}
