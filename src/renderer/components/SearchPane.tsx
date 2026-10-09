import { useEffect, useRef, useState } from 'react'
import type { Discussion, SearchTab, SearchTool } from '@shared/types'
import * as W from '@shared/workspace'
import { useViewSync } from '../hooks/useViewSync'
import { useApp } from '../state/store'
import { NewSearchPrompt } from './NewSearchPrompt'
import { RududResults } from './RududResults'
import { TabBar } from './TabBar'

interface SearchPaneProps {
  discussion: Discussion | null
}

/**
 * Top pane: search tabs, browser chrome, and the host element that the embedded
 * WebContentsView is positioned over.
 */
export function SearchPane({ discussion }: SearchPaneProps): React.JSX.Element {
  const tools = useApp((s) => s.tools)
  const nav = useApp((s) => s.nav)
  const find = useApp((s) => s.find)
  const loaded = useApp((s) => s.loaded)
  const addSearchTab = useApp((s) => s.addSearchTab)
  const setTools = useApp((s) => s.setTools)
  const setFind = useApp((s) => s.setFind)
  const showToast = useApp((s) => s.showToast)

  const ui = useApp((s) => s.ui)
  const setUi = useApp((s) => s.setUi)
  const hostRef = useRef<HTMLDivElement>(null)
  const [findText, setFindText] = useState('')
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const { promptOpen, findOpen, settingsOpen } = ui

  const tabs = discussion ? W.tabsOfKind(discussion, 'search') : []
  const activeTab = discussion ? W.activeTab(discussion, 'search') : null
  const tool = tools.find((t) => t.id === activeTab?.toolId)
  const isLocal = tool?.type === 'local'
  const live = activeTab ? nav[activeTab.id] : undefined
  const currentUrl = live?.url ?? activeTab?.url ?? ''

  // The view must be hidden whenever something else needs to be seen in this rectangle.
  useViewSync({
    hostRef,
    tabId: activeTab?.id ?? null,
    toolId: activeTab?.toolId ?? null,
    initialUrl: activeTab?.url ?? '',
    // Any renderer overlay must hide the view: it is an OS-level layer that would
    // otherwise be painted straight over the top.
    visible: !!activeTab && !isLocal && !promptOpen && !settingsOpen
  })

  // Closing the find bar clears the page's highlights.
  useEffect(() => {
    if (findOpen || !activeTab) return
    window.api.view.stopFind(activeTab.id)
    setFind(null)
  }, [findOpen, activeTab, setFind])

  const openSearch = async (picked: SearchTool, query: string): Promise<void> => {
    const url = await window.api.buildSearchUrl(picked.id, query)
    addSearchTab({
      toolId: picked.id,
      title: query.trim() || picked.label,
      query: query.trim(),
      url
    })
    setUi({ promptOpen: false })
  }

  const calibrate = async (): Promise<void> => {
    if (!activeTab || !tool) return
    const template = await window.api.calibrateTool(tool.id, activeTab.id, activeTab.query)
    if (template) {
      setTools(await window.api.listTools())
      showToast(`حُفظ نمط البحث لـ ${tool.label}`)
    } else {
      showToast('لم يظهر نص البحث في الرابط — ابحث في الموقع ثم أعد المحاولة', 'warn')
    }
  }

  const runFind = (text: string, findNext = false, forward = true): void => {
    if (!activeTab) return
    window.api.view.find(activeTab.id, text, forward, findNext)
    if (!text) setFind(null)
  }

  return (
    <section
      className="pane"
      data-testid="search-pane"
      onPointerDownCapture={() => setUi({ focusedPane: 'search' })}
    >
      <TabBar
        kind="search"
        tabs={tabs}
        activeId={discussion?.activeSearchTabId ?? null}
        newTitle="بحث جديد"
        onNew={discussion ? () => setUi({ promptOpen: true, promptToolId: null, promptQuery: '' }) : undefined}
      />

      {activeTab && !isLocal && (
        <div className="navbar" data-testid="navbar">
          <button
            type="button"
            className="icon-btn"
            title="رجوع"
            data-testid="nav-back"
            disabled={!live?.canGoBack}
            onClick={() => window.api.view.back(activeTab.id)}
          >
            ←
          </button>
          <button
            type="button"
            className="icon-btn"
            title="تقدم"
            data-testid="nav-forward"
            disabled={!live?.canGoForward}
            onClick={() => window.api.view.forward(activeTab.id)}
          >
            →
          </button>
          <button
            type="button"
            className="icon-btn"
            title={live?.loading ? 'إيقاف' : 'تحديث'}
            data-testid="nav-reload"
            onClick={() =>
              live?.loading ? window.api.view.stop(activeTab.id) : window.api.view.reload(activeTab.id)
            }
          >
            {live?.loading ? '✕' : '⟳'}
          </button>

          <input
            className="navbar__url"
            data-testid="nav-url"
            spellCheck={false}
            value={urlDraft ?? currentUrl}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => setUrlDraft(null)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && urlDraft) {
                window.api.view.navigate(activeTab.id, urlDraft)
                setUrlDraft(null)
              } else if (e.key === 'Escape') {
                setUrlDraft(null)
                e.currentTarget.blur()
              }
            }}
          />

          {/* Embedded views have no Chrome find bar, so the app supplies one. */}
          {findOpen ? (
            <span className="findbar" data-testid="findbar">
              <input
                className="findbar__input"
                data-testid="find-input"
                autoFocus
                dir={findText ? 'auto' : 'rtl'}
                placeholder="بحث في الصفحة"
                value={findText}
                onChange={(e) => {
                  setFindText(e.target.value)
                  runFind(e.target.value)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') runFind(findText, true, !e.shiftKey)
                  else if (e.key === 'Escape') setUi({ findOpen: false })
                }}
              />
              <span className="findbar__count" data-testid="find-count">
                {find && findText ? `${find.activeMatchOrdinal}/${find.matches}` : ''}
              </span>
              <button type="button" className="icon-btn" title="إغلاق" onClick={() => setUi({ findOpen: false })}>
                ✕
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="icon-btn"
              title="بحث في الصفحة (Ctrl+F)"
              data-testid="find-toggle"
              onClick={() => setUi({ findOpen: true })}
            >
              🔍
            </button>
          )}

          {activeTab.query && (
            <button
              type="button"
              className={`icon-btn${tool?.searchUrl ? '' : ' icon-btn--hint'}`}
              title={
                tool?.searchUrl
                  ? 'إعادة ضبط نمط البحث من هذا الرابط'
                  : 'تعلَّم نمط البحث من هذا الرابط'
              }
              data-testid="calibrate"
              onClick={() => void calibrate()}
            >
              ⚙
            </button>
          )}
        </div>
      )}

      <div className="pane__body" ref={hostRef} data-testid="search-view">
        {promptOpen && (
          <NewSearchPrompt
            tools={tools}
            initialToolId={ui.promptToolId}
            initialQuery={ui.promptQuery}
            onSubmit={(picked, query) => void openSearch(picked, query)}
            onCancel={() => setUi({ promptOpen: false })}
          />
        )}

        {!promptOpen && !activeTab && (
          <Placeholder
            text={!loaded ? '…' : discussion ? 'لا يوجد بحث بعد — اضغط +' : 'أنشئ مناقشة للبدء'}
          />
        )}

        {!promptOpen && activeTab && isLocal && <RududResults tab={activeTab} />}
      </div>
    </section>
  )
}

function Placeholder({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="pane__empty" dir="auto">
      {text}
    </div>
  )
}

export type { SearchTab }
