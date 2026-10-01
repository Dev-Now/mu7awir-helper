/**
 * The app's keyboard map.
 *
 * Shortcuts are matched in the main process from `before-input-event`, which is attached
 * to the window *and* to every embedded WebContentsView. A renderer-side listener alone
 * would die the moment focus landed inside a search page — which is most of the time in
 * a browser-shaped app.
 *
 * Two shortcuts are deliberately absent: Ctrl+Shift+C and Ctrl+Enter live in the site
 * preload, because they act on the page's own text selection.
 */
import type { Input } from 'electron'

export interface Shortcut {
  /** Action name sent to the renderer. */
  id: string
  accelerator: string
  description: string
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'discussion.new', accelerator: 'Ctrl+N', description: 'مناقشة جديدة' },
  { id: 'discussion.rename', accelerator: 'Ctrl+Shift+N', description: 'إعادة تسمية المناقشة' },
  { id: 'discussion.next', accelerator: 'Ctrl+Tab', description: 'المناقشة التالية' },
  { id: 'discussion.prev', accelerator: 'Ctrl+Shift+Tab', description: 'المناقشة السابقة' },
  { id: 'discussion.archive', accelerator: 'Ctrl+E', description: 'أرشفة المناقشة' },

  { id: 'tab.rename', accelerator: 'F2', description: 'إعادة تسمية اللسان' },
  { id: 'tab.close', accelerator: 'Ctrl+W', description: 'إغلاق اللسان' },

  { id: 'search.new', accelerator: 'Ctrl+T', description: 'بحث جديد' },
  { id: 'search.next', accelerator: 'Alt+Right', description: 'لسان البحث التالي' },
  { id: 'search.prev', accelerator: 'Alt+Left', description: 'لسان البحث السابق' },
  { id: 'search.first', accelerator: 'Alt+Home', description: 'أول لسان بحث' },
  { id: 'search.last', accelerator: 'Alt+End', description: 'آخر لسان بحث' },
  { id: 'search.find', accelerator: 'Ctrl+F', description: 'بحث في الصفحة' },

  { id: 'draft.new', accelerator: 'Ctrl+D', description: 'رد جديد' },
  { id: 'draft.next', accelerator: 'Ctrl+Alt+Right', description: 'لسان الرد التالي' },
  { id: 'draft.prev', accelerator: 'Ctrl+Alt+Left', description: 'لسان الرد السابق' },
  { id: 'draft.first', accelerator: 'Ctrl+Alt+Home', description: 'أول لسان رد' },
  { id: 'draft.last', accelerator: 'Ctrl+Alt+End', description: 'آخر لسان رد' },
  { id: 'draft.copyAll', accelerator: 'Ctrl+Shift+A', description: 'نسخ الرد كاملاً' },

  { id: 'tool.1', accelerator: 'Ctrl+1', description: 'بحث بالأداة ١' },
  { id: 'tool.2', accelerator: 'Ctrl+2', description: 'بحث بالأداة ٢' },
  { id: 'tool.3', accelerator: 'Ctrl+3', description: 'بحث بالأداة ٣' },
  { id: 'tool.4', accelerator: 'Ctrl+4', description: 'بحث بالأداة ٤' },
  { id: 'tool.5', accelerator: 'Ctrl+5', description: 'بحث بالأداة ٥' },
  { id: 'tool.6', accelerator: 'Ctrl+6', description: 'بحث بالأداة ٦' },
  { id: 'tool.7', accelerator: 'Ctrl+7', description: 'بحث بالأداة ٧' },

  { id: 'settings.open', accelerator: 'Ctrl+,', description: 'الإعدادات' },
  { id: 'sidebar.toggle', accelerator: 'Ctrl+B', description: 'إظهار/إخفاء الشريط الجانبي' }
]

/** Push-to-talk needs both edges, so it is matched separately from the table. */
export const DICTATION_KEY = 'F4'

interface ParsedAccelerator {
  ctrl: boolean
  alt: boolean
  shift: boolean
  key: string
}

/** Accelerator spellings that differ from `KeyboardEvent.key`. */
const KEY_ALIASES: Record<string, string> = {
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  esc: 'escape',
  plus: '+'
}

export function parseAccelerator(accelerator: string): ParsedAccelerator {
  // Split on '+' but keep a trailing literal '+' or ',' as the key.
  const parts = accelerator.split('+')
  const raw = parts.pop() || '+'
  const key = raw.toLowerCase()
  return {
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
    key: KEY_ALIASES[key] ?? key
  }
}

export function matches(input: Input, accelerator: string): boolean {
  const wanted = parseAccelerator(accelerator)
  if (input.control !== wanted.ctrl) return false
  if (input.alt !== wanted.alt) return false
  if (input.shift !== wanted.shift) return false
  if (input.meta) return false
  return input.key.toLowerCase() === wanted.key
}

export type ShortcutHit =
  | { kind: 'action'; id: string }
  | { kind: 'dictation'; edge: 'down' | 'up' }

/**
 * Resolve a raw key event to an action, or null to let it through. Auto-repeat is
 * ignored so holding a key does not fire an action over and over.
 */
export function resolveShortcut(input: Input, shortcuts: Shortcut[] = SHORTCUTS): ShortcutHit | null {
  const bare = !input.control && !input.alt && !input.shift && !input.meta

  if (input.key === DICTATION_KEY && bare) {
    if (input.type === 'keyUp') return { kind: 'dictation', edge: 'up' }
    return input.isAutoRepeat ? null : { kind: 'dictation', edge: 'down' }
  }

  if (input.type !== 'keyDown' || input.isAutoRepeat) return null

  const hit = shortcuts.find((shortcut) => matches(input, shortcut.accelerator))
  return hit ? { kind: 'action', id: hit.id } : null
}
