import { useEffect } from 'react'
import { makeSource } from '@shared/text'
import { useApp } from '../state/store'

interface CopyEvent {
  action: 'copy' | 'copy-with-source' | 'to-draft'
  tabId: string | null
  text: string
  pageTitle: string
  url: string
}

/** Short preview of copied text for the toast, so the user sees what landed. */
function preview(text: string, limit = 42): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= limit ? single : `${single.slice(0, limit)}…`
}

/**
 * Handles copy requests raised inside an embedded page. Main has already written the
 * clipboard where relevant; the renderer's job is the draft and the feedback.
 */
export function useCopyEvents(): void {
  useEffect(
    () =>
      window.api.onCopy((raw) => {
        const event = raw as CopyEvent
        const state = useApp.getState()
        if (!event.text) return

        if (event.action === 'to-draft') {
          if (!state.workspace.activeDiscussionId) {
            state.showToast('افتح مناقشة أولاً', 'warn')
            return
          }
          state.appendToActiveDraft(event.text, makeSource(event.text, event.pageTitle, event.url))
          state.showToast(`أُضيف إلى الرد: ${preview(event.text)}`)
          return
        }

        state.showToast(
          event.action === 'copy-with-source'
            ? `نُسخ مع المصدر: ${preview(event.text)}`
            : `نُسخ: ${preview(event.text)}`
        )
      }),
    []
  )
}
