import { useEffect, useRef, useState } from 'react'

interface InlineEditProps {
  value: string
  /** Controlled by the parent so renames can also be triggered from a shortcut. */
  editing: boolean
  onCommit: (value: string) => void
  onCancel: () => void
  className?: string
  title?: string
  onDoubleClick?: () => void
}

/**
 * Text that turns into an input in place. Enter or blur commits, Escape reverts.
 * Used for renaming discussions and tabs.
 */
export function InlineEdit({
  value,
  editing,
  onCommit,
  onCancel,
  className,
  title,
  onDoubleClick
}: InlineEditProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  // Guards against blur firing a second commit after Enter or Escape.
  const settled = useRef(false)

  useEffect(() => {
    if (!editing) return
    settled.current = false
    setDraft(value)
    const input = inputRef.current
    if (input) {
      input.focus()
      input.select()
    }
  }, [editing, value])

  if (!editing) {
    return (
      <span className={className} title={title ?? value} dir="auto" onDoubleClick={onDoubleClick}>
        {value}
      </span>
    )
  }

  const commit = (): void => {
    if (settled.current) return
    settled.current = true
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) onCommit(trimmed)
    else onCancel()
  }

  const cancel = (): void => {
    if (settled.current) return
    settled.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      className={`inline-edit${className ? ` ${className}` : ''}`}
      dir="auto"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') cancel()
      }}
    />
  )
}
