/**
 * Preload injected into every embedded search page (sandboxed).
 *
 * Provides the copy pipeline:
 *   • a hover-following copy button, drawn in a shadow root so no site's layout is
 *     touched and no per-paragraph DOM is inserted — this survives sites that re-render
 *     and sites whose own scripts fight injected nodes;
 *   • Ctrl+Shift+C to copy the selection together with its source;
 *   • Ctrl+Enter to send the selection straight into the active draft.
 *
 * The hover button can be switched off per tool, for sites whose own copy buttons are
 * good enough; the page is then left exactly as the site draws it. The shortcuts stay.
 *
 * Text never goes to the clipboard from here: it is handed to main, which owns the
 * Electron clipboard and knows which tab the page belongs to.
 */
import { ipcRenderer } from 'electron'
import { cleanCopiedText } from '@shared/text'

type CopyAction = 'copy' | 'copy-with-source' | 'to-draft'

/** Blocks worth offering a copy button on. */
const BLOCK_SELECTOR = 'p, li, blockquote, dd, td, h1, h2, h3, h4, figcaption, pre'
/** Short fragments are navigation and chrome, not quotable material. */
const MIN_BLOCK_LENGTH = 40

function send(action: CopyAction, text: string): void {
  const cleaned = cleanCopiedText(text)
  if (!cleaned) return
  ipcRenderer.send('site:copy', {
    action,
    text: cleaned,
    pageTitle: document.title,
    url: location.href
  })
}

interface SiteConfig {
  copyOverlay: boolean
}

/** Main knows which tool this page was opened with; unknown pages get the overlay. */
function readConfig(): SiteConfig {
  try {
    const config = ipcRenderer.sendSync('site:config') as Partial<SiteConfig> | null
    return { copyOverlay: config?.copyOverlay !== false }
  } catch {
    return { copyOverlay: true }
  }
}

function selectionText(): string {
  return window.getSelection()?.toString() ?? ''
}

function install(): void {
  // `open` so the smoke run can drive the button; the page could read this text anyway.
  const host = document.createElement('div')
  host.setAttribute('data-mu7', 'copy-overlay')
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  const root = host.attachShadow({ mode: 'open' })

  root.innerHTML = `
    <style>
      .outline {
        position: fixed;
        display: none;
        border: 1px solid rgba(75, 141, 230, 0.55);
        border-radius: 3px;
        background: rgba(75, 141, 230, 0.06);
        pointer-events: none;
      }
      .btn {
        position: fixed;
        display: none;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border: 1px solid #2f5f9e;
        border-radius: 4px;
        background: #12141a;
        color: #e6e8ef;
        cursor: pointer;
        font: 12px/1.6 'Segoe UI', system-ui, sans-serif;
        pointer-events: auto;
      }
      .btn:hover { background: #2f5f9e; }
    </style>
    <div class="outline" part="outline"></div>
    <button class="btn" type="button" data-mu7-copy>نسخ 📋</button>
  `

  const outline = root.querySelector('.outline') as HTMLElement
  const button = root.querySelector('.btn') as HTMLElement
  let block: HTMLElement | null = null
  let overlayOn = readConfig().copyOverlay

  const hide = (): void => {
    block = null
    button.style.display = 'none'
    outline.style.display = 'none'
  }

  const place = (): void => {
    if (!block) return
    const rect = block.getBoundingClientRect()
    const offscreen =
      rect.bottom < 0 || rect.top > window.innerHeight || rect.width === 0 || rect.height === 0
    if (offscreen) {
      hide()
      return
    }
    outline.style.display = 'block'
    outline.style.left = `${rect.left - 2}px`
    outline.style.top = `${rect.top - 2}px`
    outline.style.width = `${rect.width + 4}px`
    outline.style.height = `${rect.height + 4}px`

    // `flex`, not `inline-flex`: a fixed-position box blockifies either way.
    button.style.display = 'flex'
    button.style.left = `${Math.max(2, rect.left)}px`
    button.style.top = `${Math.max(2, rect.top - 22)}px`
  }

  /** Nearest ancestor that is a block with enough text to be worth quoting. */
  const blockFor = (node: EventTarget | null): HTMLElement | null => {
    let el = node instanceof Element ? node : null
    while (el && el !== document.body) {
      if (el.matches(BLOCK_SELECTOR)) {
        const text = (el as HTMLElement).innerText ?? el.textContent ?? ''
        if (cleanCopiedText(text).length >= MIN_BLOCK_LENGTH) return el as HTMLElement
      }
      el = el.parentElement
    }
    return null
  }

  // Throttled with a timer rather than requestAnimationFrame: Chromium throttles rAF
  // to a standstill whenever the window is unfocused or occluded, which would freeze
  // the button mid-page. Hover only needs debouncing, not frame sync.
  let scheduled: ReturnType<typeof setTimeout> | null = null
  const onPointerMove = (event: MouseEvent): void => {
    if (scheduled) return
    scheduled = setTimeout(() => {
      scheduled = null
      if (!overlayOn) return
      const next = blockFor(event.target)
      if (next === block) return
      block = next
      if (!block) hide()
      else place()
    }, 16)
  }

  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (block) send('copy', block.innerText ?? block.textContent ?? '')
  })

  document.addEventListener('mousemove', onPointerMove, true)
  document.addEventListener('mouseleave', hide)
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)

  // Settings changed while the page was open.
  ipcRenderer.on('site:config', (_event, config: SiteConfig) => {
    overlayOn = config.copyOverlay
    if (!overlayOn) hide()
  })

  document.addEventListener(
    'keydown',
    (event) => {
      if (!event.ctrlKey) return
      if (event.shiftKey && (event.key === 'C' || event.key === 'c')) {
        const text = selectionText()
        if (text.trim()) {
          event.preventDefault()
          send('copy-with-source', text)
        }
      } else if (event.key === 'Enter') {
        const text = selectionText()
        if (text.trim()) {
          event.preventDefault()
          send('to-draft', text)
        }
      }
    },
    true
  )

  document.documentElement.appendChild(host)
  ipcRenderer.send('site:ready', { url: location.href, title: document.title })
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install, { once: true })
} else {
  install()
}
