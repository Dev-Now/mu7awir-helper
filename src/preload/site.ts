/**
 * Preload injected into every embedded search page (sandboxed).
 *
 * M3 turns this into the copy pipeline — a hover-follow copy button in a shadow-root
 * overlay plus selection capture. For now it only proves the injection point works.
 */
export {}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ipcRenderer } = require('electron') as typeof import('electron')

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('site:ready', { url: location.href, title: document.title })
})
