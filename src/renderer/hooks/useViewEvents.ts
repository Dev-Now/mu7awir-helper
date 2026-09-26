import { useEffect } from 'react'
import * as W from '@shared/workspace'
import { useApp } from '../state/store'

type ViewEvent =
  | {
      type: 'nav'
      tabId: string
      url: string
      title: string
      canGoBack: boolean
      canGoForward: boolean
      loading: boolean
    }
  | { type: 'found'; tabId: string; matches: number; activeMatchOrdinal: number }
  | { type: 'popup'; tabId: string; url: string }

/** Mirrors navigation, find results and blocked popups from the embedded views into the store. */
export function useViewEvents(): void {
  useEffect(
    () =>
      window.api.view.onEvent((raw) => {
        const event = raw as ViewEvent
        const state = useApp.getState()

        if (event.type === 'nav') {
          state.setNav(event.tabId, {
            url: event.url,
            title: event.title,
            canGoBack: event.canGoBack,
            canGoForward: event.canGoForward,
            loading: event.loading
          })
          // Persist where the tab ended up, so reopening it restores the same page.
          const discussion = W.activeDiscussion(state.workspace)
          const tab = discussion?.tabs.find((t) => t.id === event.tabId)
          if (tab?.kind === 'search' && event.url && tab.url !== event.url) {
            state.setSearchTabLocation(event.tabId, event.url)
          }
          return
        }

        if (event.type === 'found') {
          state.setFind({ matches: event.matches, activeMatchOrdinal: event.activeMatchOrdinal })
          return
        }

        // A popup the page tried to open in a new window becomes a new search tab.
        const discussion = W.activeDiscussion(state.workspace)
        const origin = discussion?.tabs.find((t) => t.id === event.tabId)
        if (origin?.kind === 'search') {
          state.addSearchTab({ toolId: origin.toolId, title: origin.title, url: event.url })
        }
      }),
    []
  )
}
