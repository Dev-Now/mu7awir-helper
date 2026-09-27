import { useEffect } from 'react'
import * as W from '@shared/workspace'
import { useApp } from '../state/store'

export interface ShortcutMessage {
  id: string
  /** Text selected in the embedded page when the key was pressed, if any. */
  selection?: string
}

/**
 * Turns shortcut actions from main into store changes.
 *
 * Main owns matching so that keys work wherever focus sits, including inside an embedded
 * page; the renderer only decides what each action means.
 */
export function useShortcuts(): void {
  useEffect(
    () =>
      window.api.onShortcut((raw) => {
        const { id, selection } = raw as ShortcutMessage
        const state = useApp.getState()
        const { workspace, ui } = state
        const discussion = W.activeDiscussion(workspace)
        const pane = ui.focusedPane

        // Tool shortcuts open the search prompt with that tool chosen, prefilled with
        // whatever was selected in the page the user was reading.
        const tool = /^tool\.(\d)$/.exec(id)
        if (tool) {
          const picked = state.tools.filter((t) => t.enabled)[Number(tool[1]) - 1]
          if (!discussion) {
            state.showToast('افتح مناقشة أولاً', 'warn')
          } else if (picked) {
            state.setUi({
              promptOpen: true,
              promptToolId: picked.id,
              promptQuery: (selection ?? '').trim().slice(0, 200)
            })
          }
          return
        }

        switch (id) {
          case 'discussion.new':
            state.createDiscussion('')
            state.setUi({
              renaming: { kind: 'discussion', id: useApp.getState().workspace.activeDiscussionId! }
            })
            return
          case 'discussion.rename':
            if (discussion) state.setUi({ renaming: { kind: 'discussion', id: discussion.id } })
            return
          case 'discussion.next':
            state.cycleDiscussion(1)
            return
          case 'discussion.prev':
            state.cycleDiscussion(-1)
            return
          case 'discussion.archive':
            if (discussion) state.setDiscussionArchived(discussion.id, !discussion.archived)
            return

          case 'tab.rename': {
            const active = discussion && W.activeTab(discussion, pane)
            if (active) state.setUi({ renaming: { kind: 'tab', id: active.id } })
            return
          }
          case 'tab.close': {
            const active = discussion && W.activeTab(discussion, pane)
            if (active) state.closeTab(active.id)
            return
          }

          case 'search.new':
            if (discussion) state.setUi({ promptOpen: true, promptToolId: null, promptQuery: '' })
            else state.showToast('افتح مناقشة أولاً', 'warn')
            return
          case 'search.next':
            state.cycleTab('search', 1)
            return
          case 'search.prev':
            state.cycleTab('search', -1)
            return
          case 'search.first':
            state.jumpTab('search', 'first')
            return
          case 'search.last':
            state.jumpTab('search', 'last')
            return
          case 'search.find':
            if (discussion && W.activeTab(discussion, 'search')) state.setUi({ findOpen: true })
            return

          case 'draft.new':
            if (discussion) state.addDraftTab()
            return
          case 'draft.next':
            state.cycleTab('draft', 1)
            return
          case 'draft.prev':
            state.cycleTab('draft', -1)
            return
          case 'draft.first':
            state.jumpTab('draft', 'first')
            return
          case 'draft.last':
            state.jumpTab('draft', 'last')
            return
          case 'draft.copyAll':
            // Handled by the draft pane, which knows the sources and the toggle.
            window.dispatchEvent(new CustomEvent('mu7:copy-draft'))
            return

          case 'settings.open':
            state.setUi({ settingsOpen: !ui.settingsOpen })
            return
          case 'sidebar.toggle':
            state.updateSettings({ sidebarCollapsed: !workspace.settings.sidebarCollapsed })
            return
          default:
            return
        }
      }),
    []
  )
}
