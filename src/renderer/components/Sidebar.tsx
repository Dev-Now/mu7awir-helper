import { useState } from 'react'
import * as W from '@shared/workspace'
import { useApp } from '../state/store'
import { InlineEdit } from './InlineEdit'

/** Left rail: the list of discussions, with rename, archive and delete. */
export function Sidebar(): React.JSX.Element {
  const workspace = useApp((s) => s.workspace)
  const createDiscussion = useApp((s) => s.createDiscussion)
  const renameDiscussion = useApp((s) => s.renameDiscussion)
  const selectDiscussion = useApp((s) => s.selectDiscussion)
  const setArchived = useApp((s) => s.setDiscussionArchived)
  const deleteDiscussion = useApp((s) => s.deleteDiscussion)
  const updateSettings = useApp((s) => s.updateSettings)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  // Delete is confirmed inline rather than with a modal, which would be painted
  // over by the search view's WebContentsView overlay.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const discussions = W.visibleDiscussions(workspace)
  const archivedCount = workspace.discussions.filter((d) => d.archived).length

  const handleNew = (): void => {
    createDiscussion('')
    // Creating selects the new discussion, so rename it straight away.
    setRenamingId(useApp.getState().workspace.activeDiscussionId)
  }

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar__header">
        <span>المناقشات</span>
        <button
          type="button"
          className="icon-btn"
          title="مناقشة جديدة"
          data-testid="new-discussion"
          onClick={handleNew}
        >
          +
        </button>
      </div>

      <ul className="sidebar__list" data-testid="discussion-list">
        {discussions.map((d) => {
          const active = d.id === workspace.activeDiscussionId
          const confirming = confirmingId === d.id
          return (
            <li
              key={d.id}
              className={`discussion${active ? ' discussion--active' : ''}${d.archived ? ' discussion--archived' : ''}`}
              data-testid="discussion"
              data-active={active || undefined}
              onClick={() => selectDiscussion(d.id)}
            >
              <InlineEdit
                className="discussion__title"
                value={d.title}
                editing={renamingId === d.id}
                onDoubleClick={() => setRenamingId(d.id)}
                onCommit={(title) => {
                  renameDiscussion(d.id, title)
                  setRenamingId(null)
                }}
                onCancel={() => setRenamingId(null)}
              />

              {confirming ? (
                <span className="discussion__actions">
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    title="تأكيد الحذف"
                    data-testid="confirm-delete"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteDiscussion(d.id)
                      setConfirmingId(null)
                    }}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="إلغاء"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmingId(null)
                    }}
                  >
                    ✕
                  </button>
                </span>
              ) : (
                <span className="discussion__actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={d.archived ? 'إلغاء الأرشفة' : 'أرشفة'}
                    data-testid="archive-discussion"
                    onClick={(e) => {
                      e.stopPropagation()
                      setArchived(d.id, !d.archived)
                    }}
                  >
                    {d.archived ? '⊙' : '⊘'}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="حذف"
                    data-testid="delete-discussion"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmingId(d.id)
                    }}
                  >
                    🗑
                  </button>
                </span>
              )}
            </li>
          )
        })}

        {discussions.length === 0 && (
          <li className="sidebar__empty">لا توجد مناقشات — اضغط + للبدء</li>
        )}
      </ul>

      {archivedCount > 0 && (
        <button
          type="button"
          className="sidebar__footer"
          data-testid="toggle-archived"
          onClick={() => updateSettings({ showArchived: !workspace.settings.showArchived })}
        >
          {workspace.settings.showArchived
            ? 'إخفاء المؤرشفة'
            : `عرض المؤرشفة (${archivedCount})`}
        </button>
      )}
    </aside>
  )
}
