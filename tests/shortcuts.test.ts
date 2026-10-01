import type { Input } from 'electron'
import { describe, expect, it } from 'vitest'
import { SHORTCUTS, matches, parseAccelerator, resolveShortcut } from '../src/main/shortcuts'

/** A `before-input-event` payload with sensible defaults. */
function input(patch: Partial<Input> & { key: string }): Input {
  return {
    type: 'keyDown',
    code: '',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...patch
  } as Input
}

describe('parseAccelerator', () => {
  it('splits modifiers from the key', () => {
    expect(parseAccelerator('Ctrl+Shift+N')).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      key: 'n'
    })
  })

  it('maps arrow spellings onto KeyboardEvent.key', () => {
    expect(parseAccelerator('Alt+Right').key).toBe('arrowright')
    expect(parseAccelerator('Ctrl+Alt+Left').key).toBe('arrowleft')
  })

  it('handles a comma as the key', () => {
    expect(parseAccelerator('Ctrl+,')).toEqual({ ctrl: true, alt: false, shift: false, key: ',' })
  })

  it('handles a bare function key', () => {
    expect(parseAccelerator('F2')).toEqual({ ctrl: false, alt: false, shift: false, key: 'f2' })
  })
})

describe('matches', () => {
  it('requires every modifier to line up exactly', () => {
    expect(matches(input({ key: 'n', control: true }), 'Ctrl+N')).toBe(true)
    expect(matches(input({ key: 'n' }), 'Ctrl+N')).toBe(false)
    // Ctrl+Shift+N must not fire the plain Ctrl+N binding.
    expect(matches(input({ key: 'N', control: true, shift: true }), 'Ctrl+N')).toBe(false)
    expect(matches(input({ key: 'N', control: true, shift: true }), 'Ctrl+Shift+N')).toBe(true)
  })

  it('ignores letter case, which shift changes', () => {
    expect(matches(input({ key: 'A', control: true, shift: true }), 'Ctrl+Shift+A')).toBe(true)
  })

  it('never matches when the platform meta key is held', () => {
    expect(matches(input({ key: 'n', control: true, meta: true }), 'Ctrl+N')).toBe(false)
  })

  it('distinguishes the arrow bindings', () => {
    expect(matches(input({ key: 'ArrowRight', alt: true }), 'Alt+Right')).toBe(true)
    expect(matches(input({ key: 'ArrowRight', alt: true, control: true }), 'Alt+Right')).toBe(false)
    expect(matches(input({ key: 'ArrowRight', alt: true, control: true }), 'Ctrl+Alt+Right')).toBe(
      true
    )
  })
})

describe('resolveShortcut', () => {
  it('resolves the documented bindings', () => {
    const cases: Array<[Partial<Input> & { key: string }, string]> = [
      [{ key: 'n', control: true }, 'discussion.new'],
      [{ key: 'N', control: true, shift: true }, 'discussion.rename'],
      [{ key: 'Tab', control: true }, 'discussion.next'],
      [{ key: 'Tab', control: true, shift: true }, 'discussion.prev'],
      [{ key: 'F2' }, 'tab.rename'],
      [{ key: 'w', control: true }, 'tab.close'],
      [{ key: 'd', control: true }, 'draft.new'],
      [{ key: 'ArrowRight', alt: true }, 'search.next'],
      [{ key: 'ArrowLeft', alt: true }, 'search.prev'],
      [{ key: 'Home', alt: true }, 'search.first'],
      [{ key: 'End', alt: true }, 'search.last'],
      [{ key: 'ArrowRight', alt: true, control: true }, 'draft.next'],
      [{ key: 'Home', alt: true, control: true }, 'draft.first'],
      [{ key: 'f', control: true }, 'search.find'],
      [{ key: 'A', control: true, shift: true }, 'draft.copyAll'],
      [{ key: '1', control: true }, 'tool.1'],
      [{ key: '7', control: true }, 'tool.7'],
      [{ key: ',', control: true }, 'settings.open'],
      [{ key: 'b', control: true }, 'sidebar.toggle']
    ]
    for (const [raw, expected] of cases) {
      expect(resolveShortcut(input(raw)), `${expected} binding`).toEqual({
        kind: 'action',
        id: expected
      })
    }
  })

  it('lets ordinary typing and text editing through', () => {
    for (const raw of [
      { key: 'a' },
      { key: 'ا' },
      { key: ' ' },
      { key: 'Enter' },
      { key: 'Backspace' },
      { key: 'c', control: true }, // copy
      { key: 'v', control: true }, // paste
      { key: 'z', control: true }, // undo
      { key: 'a', control: true } // select all
    ]) {
      expect(resolveShortcut(input(raw)), `${JSON.stringify(raw)} must pass through`).toBeNull()
    }
  })

  it('reports both edges of the dictation key', () => {
    expect(resolveShortcut(input({ key: 'F4' }))).toEqual({ kind: 'dictation', edge: 'down' })
    expect(resolveShortcut(input({ key: 'F4', type: 'keyUp' }))).toEqual({
      kind: 'dictation',
      edge: 'up'
    })
  })

  it('ignores auto-repeat so holding a key fires once', () => {
    expect(resolveShortcut(input({ key: 'F4', isAutoRepeat: true }))).toBeNull()
    expect(resolveShortcut(input({ key: 'n', control: true, isAutoRepeat: true }))).toBeNull()
    // The release still has to come through, or dictation would never stop.
    expect(resolveShortcut(input({ key: 'F4', type: 'keyUp', isAutoRepeat: true }))).toEqual({
      kind: 'dictation',
      edge: 'up'
    })
  })

  it('only acts on key-down for ordinary actions', () => {
    expect(resolveShortcut(input({ key: 'n', control: true, type: 'keyUp' }))).toBeNull()
  })

  it('ignores F4 when it carries a modifier, leaving Alt+F4 to the OS', () => {
    expect(resolveShortcut(input({ key: 'F4', alt: true }))).toBeNull()
  })
})

describe('the shortcut table', () => {
  it('has no duplicate ids or accelerators', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length)
    expect(new Set(SHORTCUTS.map((s) => s.accelerator)).size).toBe(SHORTCUTS.length)
  })

  it('describes every binding, for the settings panel', () => {
    expect(SHORTCUTS.every((s) => s.description.trim().length > 0)).toBe(true)
  })

  it('covers Ctrl+1 through Ctrl+7 for the seven tools', () => {
    const tools = SHORTCUTS.filter((s) => s.id.startsWith('tool.'))
    expect(tools.map((s) => s.accelerator)).toEqual([
      'Ctrl+1',
      'Ctrl+2',
      'Ctrl+3',
      'Ctrl+4',
      'Ctrl+5',
      'Ctrl+6',
      'Ctrl+7'
    ])
  })

  it('leaves the selection shortcuts to the site preload', () => {
    // Ctrl+Shift+C and Ctrl+Enter need the page's own selection.
    expect(SHORTCUTS.some((s) => s.accelerator === 'Ctrl+Shift+C')).toBe(false)
    expect(SHORTCUTS.some((s) => s.accelerator === 'Ctrl+Enter')).toBe(false)
  })
})
