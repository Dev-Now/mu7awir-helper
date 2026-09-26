import { useRef, useState } from 'react'
import * as W from '@shared/workspace'
import { Sidebar } from './components/Sidebar'
import { Splitter } from './components/Splitter'
import { TabBar } from './components/TabBar'
import { useApp } from './state/store'

const SPLITTER_PX = 6

/**
 * Shell layout: sidebar on the left, then the two panes stacked vertically —
 * search on top, drafts below, separated by a draggable splitter.
 */
export function App(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const loaded = useApp((s) => s.loaded)
  const addSearchTab = useApp((s) => s.addSearchTab)
  const addDraftTab = useApp((s) => s.addDraftTab)
  const updateSettings = useApp((s) => s.updateSettings)

  const contentRef = useRef<HTMLElement>(null)
  /** Non-null only mid-drag, so the splitter stays smooth without touching the store. */
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)

  const discussion = W.activeDiscussion(workspace)
  const ratio = previewRatio ?? workspace.settings.splitRatio
  const searchTabs = discussion ? W.tabsOfKind(discussion, 'search') : []
  const draftTabs = discussion ? W.tabsOfKind(discussion, 'draft') : []
  const activeSearch = discussion ? W.activeTab(discussion, 'search') : null
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
        <section className="pane" data-testid="search-pane">
          <TabBar
            kind="search"
            tabs={searchTabs}
            activeId={discussion?.activeSearchTabId ?? null}
            newTitle="بحث جديد"
            onNew={
              discussion
                ? () =>
                    addSearchTab({
                      toolId: 'quran',
                      title: `بحث ${searchTabs.length + 1}`
                    })
                : undefined
            }
          />
          <div className="pane__body" data-testid="search-view">
            {!loaded ? (
              <Placeholder text="…" />
            ) : !discussion ? (
              <Placeholder text="أنشئ مناقشة للبدء" />
            ) : activeSearch ? (
              <Placeholder text={activeSearch.title} />
            ) : (
              <Placeholder text="لا يوجد بحث بعد" />
            )}
          </div>
        </section>

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
            {activeDraft ? (
              <Placeholder text={activeDraft.title} />
            ) : (
              <Placeholder text="لا يوجد رد بعد" />
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function Placeholder({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="pane__empty" dir="auto">
      {text}
    </div>
  )
}
