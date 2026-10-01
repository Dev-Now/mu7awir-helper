import { useRef, useState } from 'react'
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '@shared/workspace'

/** Neither pane may be dragged smaller than this, whatever the window height. */
const MIN_PANE_PX = 120

interface SplitterProps {
  /** The grid that both panes live in; drag positions are measured against it. */
  containerRef: React.RefObject<HTMLElement | null>
  thickness: number
  /** Live ratio while dragging — cheap, local, no persistence. */
  onPreview: (ratio: number) => void
  /** Final ratio on release — this is the one that gets saved. */
  onCommit: (ratio: number) => void
}

export function Splitter({
  containerRef,
  thickness,
  onPreview,
  onCommit
}: SplitterProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const latest = useRef<number | null>(null)

  const ratioAt = (clientY: number): number | null => {
    const el = containerRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const usable = rect.height - thickness
    if (usable <= 0) return null

    // Honour the pixel floor first, then the proportional bounds.
    const floor = usable >= MIN_PANE_PX * 2 ? MIN_PANE_PX / usable : 0.5
    const min = Math.max(MIN_SPLIT_RATIO, floor)
    const max = Math.min(MAX_SPLIT_RATIO, 1 - floor)
    const raw = (clientY - rect.top) / usable
    return Math.min(Math.max(raw, Math.min(min, max)), Math.max(min, max))
  }

  return (
    <div
      className={`splitter${dragging ? ' splitter--dragging' : ''}`}
      data-testid="splitter"
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={(e) => {
        e.preventDefault()
        // Capture keeps the drag alive over the embedded search view. It throws when the
        // pointer is no longer active, which is not worth aborting the drag for.
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* no active pointer to capture */
        }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        const ratio = ratioAt(e.clientY)
        if (ratio === null) return
        latest.current = ratio
        onPreview(ratio)
      }}
      onPointerUp={(e) => {
        if (!dragging) return
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* capture was never taken */
        }
        setDragging(false)
        // Persist once, on release, rather than on every frame of the drag.
        if (latest.current !== null) onCommit(latest.current)
        latest.current = null
      }}
      onDoubleClick={() => onCommit(2 / 3)}
    />
  )
}
