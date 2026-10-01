import type { Tab, TabKind } from '@shared/types'
import { useApp } from '../state/store'
import { InlineEdit } from './InlineEdit'

interface TabBarProps {
  kind: TabKind
  tabs: Tab[]
  activeId: string | null
  /** Omitted when there is no discussion to add a tab to. */
  onNew?: () => void
  newTitle: string
}

/** One row of tabs for a single kind — search tabs on top, draft tabs below. */
export function TabBar({ kind, tabs, activeId, onNew, newTitle }: TabBarProps): React.JSX.Element {
  const selectTab = useApp((s) => s.selectTab)
  const closeTab = useApp((s) => s.closeTab)
  const renameTab = useApp((s) => s.renameTab)
  const renaming = useApp((s) => s.ui.renaming)
  const setUi = useApp((s) => s.setUi)
  const renamingId = renaming?.kind === 'tab' ? renaming.id : null
  const setRenamingId = (id: string | null): void =>
    setUi({ renaming: id ? { kind: 'tab', id } : null })

  return (
    <div className="tabbar" data-testid={`${kind}-tabbar`}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab${tab.id === activeId ? ' tab--active' : ''}`}
          data-testid={`${kind}-tab`}
          data-active={tab.id === activeId || undefined}
          onClick={() => selectTab(tab.id)}
          onAuxClick={(e) => {
            if (e.button === 1) closeTab(tab.id) // middle-click closes, as in a browser
          }}
        >
          <InlineEdit
            className="tab__title"
            value={tab.title}
            editing={renamingId === tab.id}
            onDoubleClick={() => setRenamingId(tab.id)}
            onCommit={(title) => {
              renameTab(tab.id, title)
              setRenamingId(null)
            }}
            onCancel={() => setRenamingId(null)}
          />
          <button
            type="button"
            className="tab__close"
            title="إغلاق"
            data-testid={`${kind}-tab-close`}
            onClick={(e) => {
              e.stopPropagation()
              closeTab(tab.id)
            }}
          >
            ✕
          </button>
        </div>
      ))}

      {onNew && (
        <button
          type="button"
          className="icon-btn tabbar__new"
          title={newTitle}
          data-testid={`new-${kind}-tab`}
          onClick={onNew}
        >
          +
        </button>
      )}
    </div>
  )
}
