import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

interface ViewSyncOptions {
  /** The element the embedded view should exactly cover. */
  hostRef: React.RefObject<HTMLElement | null>
  tabId: string | null
  /** Only used when the view is first created or woken from hibernation. */
  initialUrl: string
  /** False while an overlay covers the pane, or when a local tool is active. */
  visible: boolean
}

/**
 * Keeps the embedded WebContentsView glued to its host element.
 *
 * The view is an OS-level overlay, not a DOM node, so nothing moves it for us: every
 * layout change — window resize, sidebar collapse, splitter drag — has to be measured
 * here and pushed to main. Sends are throttled to one per animation frame so a drag
 * cannot outpace them.
 */
export function useViewSync({ hostRef, tabId, initialUrl, visible }: ViewSyncOptions): void {
  const frame = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ tabId, initialUrl, visible })
  latest.current = { tabId, initialUrl, visible }

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    if (timer.current !== null) clearTimeout(timer.current)
    frame.current = null
    timer.current = null
  }, [])

  const measure = useCallback(() => {
    if (frame.current !== null || timer.current !== null) return

    const send = (): void => {
      cancel()
      const rect = hostRef.current?.getBoundingClientRect()
      window.api.view.sync({
        ...latest.current,
        bounds: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null
      })
    }

    // rAF keeps drags smooth, but Chromium throttles it to a standstill while the window
    // is hidden or occluded. The timer guarantees the view still gets its geometry.
    frame.current = requestAnimationFrame(send)
    timer.current = setTimeout(send, 32)
  }, [cancel, hostRef])

  // Re-measure after every render: position can change without the element resizing,
  // for example when the sidebar collapses.
  useLayoutEffect(measure)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      cancel()
    }
  }, [cancel, hostRef, measure])
}
