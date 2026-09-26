import { useRef, useState } from 'react'
import * as W from '@shared/workspace'
import { SearchPane } from './components/SearchPane'
import { Sidebar } from './components/Sidebar'
import { Splitter } from './components/Splitter'
import { TabBar } from './components/TabBar'
import { Toast } from './components/Toast'
import { useCopyEvents } from './hooks/useCopyEvents'
import { useViewEvents } from './hooks/useViewEvents'
import { useApp } from './state/store'

const SPLITTER_PX = 6

/**
 * Shell layout: sidebar on the left, then the two panes stacked vertically —
 * search on top, drafts below, separated by a draggable splitter.
 */
export function App(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const addDraftTab = useApp((s) => s.addDraftTab)
  const updateSettings = useApp((s) => s.updateSettings)

  useViewEvents()
  useCopyEvents()

  const contentRef = useRef<HTMLElement>(null)
  /** Non-null only mid-drag, so the splitter stays smooth without touching the store. */
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)

  const discussion = W.activeDiscussion(workspace)
  const ratio = previewRatio ?? workspace.settings.splitRatio
  const draftTabs = discussion ? W.tabsOfKind(discussion, 'draft') : []
  const activeDraft = discussion ? W.activeTab(discussion, 'draft') : null

  return (
    <div
      className={`shell${workspace.settings.sidebarCollapsed ? ' shell--collapsed' : ''}`}
      data-testid="shell"
    >
      <Sidebar />

      <main
        ref={contentRef}
        className="content"
        style={{ gridTemplateRows: `${ratio}fr ${SPLITTER_PX}px ${1 - ratio}fr` }}
      >
        <SearchPane discussion={discussion} />

        <Splitter
          containerRef={contentRef}
          thickness={SPLITTER_PX}
          onPreview={setPreviewRatio}
          onCommit={(next) => {
            setPreviewRatio(null)
            updateSettings({ splitRatio: next })
          }}
        />

        <section className="pane" data-testid="draft-pane">
          <TabBar
            kind="draft"
            tabs={draftTabs}
            activeId={discussion?.activeDraftTabId ?? null}
            newTitle="رد جديد"
            onNew={discussion ? () => addDraftTab() : undefined}
          />
          <div className="pane__body" data-testid="draft-view">
            <div className="pane__empty" dir="auto">
              {activeDraft ? activeDraft.title : 'لا يوجد رد بعد'}
            </div>
          </div>
        </section>
      </main>

      <Toast />
    </div>
  )
}
