import { useRef, useState } from 'react'
import * as W from '@shared/workspace'
import { DictationHud } from './components/DictationHud'
import { DraftPane } from './components/DraftPane'
import { SearchPane } from './components/SearchPane'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { Splitter } from './components/Splitter'
import { Toast } from './components/Toast'
import { useCopyEvents } from './hooks/useCopyEvents'
import { useDictation } from './hooks/useDictation'
import { useShortcuts } from './hooks/useShortcuts'
import { useViewEvents } from './hooks/useViewEvents'
import { useApp } from './state/store'

const SPLITTER_PX = 6

/**
 * Shell layout: sidebar on the left, then the two panes stacked vertically —
 * search on top, drafts below, separated by a draggable splitter.
 */
export function App(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const updateSettings = useApp((s) => s.updateSettings)

  useViewEvents()
  useCopyEvents()
  const dictation = useDictation()
  useShortcuts()

  const contentRef = useRef<HTMLElement>(null)
  /** Non-null only mid-drag, so the splitter stays smooth without touching the store. */
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)

  const discussion = W.activeDiscussion(workspace)
  const ratio = previewRatio ?? workspace.settings.splitRatio

  return (
    <div
      className={`shell${workspace.settings.sidebarCollapsed ? ' shell--collapsed' : ''}`}
      data-testid="shell"
    >
      {workspace.settings.sidebarCollapsed ? (
        <button
          type="button"
          className="sidebar-peek"
          data-testid="sidebar-peek"
          title="إظهار الشريط الجانبي (Ctrl+B)"
          onClick={() => updateSettings({ sidebarCollapsed: false })}
        >
          ›
        </button>
      ) : (
        <Sidebar />
      )}

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

        <DraftPane discussion={discussion} />
      </main>

      <Settings />
      <DictationHud {...dictation} />
      <Toast />
    </div>
  )
}
