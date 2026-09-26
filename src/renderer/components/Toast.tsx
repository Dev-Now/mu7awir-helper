import { useEffect, useState } from 'react'
import { useApp } from '../state/store'

const VISIBLE_MS = 3200

/**
 * Bottom-left status strip. Deliberately anchored over the draft pane, which is plain
 * React — a toast over the search pane would be hidden behind the embedded view.
 */
export function Toast(): React.JSX.Element | null {
  const toast = useApp((s) => s.toast)
  const [shown, setShown] = useState(toast)

  useEffect(() => {
    if (!toast) return
    setShown(toast)
    const timer = setTimeout(() => setShown(null), VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [toast])

  if (!shown) return null
  return (
    <div className={`toast toast--${shown.tone}`} data-testid="toast" dir="auto" role="status">
      {shown.text}
    </div>
  )
}
