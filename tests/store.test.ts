import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WORKSPACE_VERSION } from '@shared/types'
import * as W from '@shared/workspace'
import { WorkspaceStore, sanitizeWorkspace } from '../src/main/store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mu7awir-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A workspace with a discussion, a search tab and a draft carrying a source. */
function populated() {
  let ws = W.createDiscussion(W.defaultWorkspace(), 'حوار الإلحاد')
  const id = ws.activeDiscussionId!
  ws = W.addSearchTab(ws, id, {
    toolId: 'quran',
    title: 'الصبر',
    query: 'الصبر',
    url: 'https://tafsir.app/search?q=%D8%A7%D9%84%D8%B5%D8%A8%D8%B1'
  })
  ws = W.addDraftTab(ws, id)
  const draftId = W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft')[0].id
  ws = W.appendToDraft(ws, id, draftId, 'نص الرد', {
    text: 'نص',
    pageTitle: 'الباحث القرآني',
    url: 'https://tafsir.app/',
    at: '2026-09-26T00:00:00.000Z'
  })
  return ws
}

describe('round trip', () => {
  it('writes and reads back an identical workspace', async () => {
    const store = new WorkspaceStore(dir, { debounceMs: 1 })
    const ws = populated()
    store.queue(ws)
    await store.flush()

    const reloaded = await new WorkspaceStore(dir).load()
    expect(reloaded).toEqual(ws)
  })

  it('returns a default workspace when nothing has been saved', async () => {
    expect(await new WorkspaceStore(dir).load()).toEqual(W.defaultWorkspace())
  })

  it('collapses rapid saves into a single write', async () => {
    const store = new WorkspaceStore(dir, { debounceMs: 20 })
    let ws = W.defaultWorkspace()
    for (let i = 0; i < 25; i++) {
      ws = W.createDiscussion(ws, `حوار ${i}`)
      store.queue(ws)
    }
    await store.flush()
    expect((await new WorkspaceStore(dir).load()).discussions).toHaveLength(25)
  })

  it('leaves no temp file behind', async () => {
    const store = new WorkspaceStore(dir, { debounceMs: 1 })
    store.queue(populated())
    await store.flush()
    expect(await fs.readdir(dir)).not.toContain('workspace.tmp')
  })
})

describe('recovery', () => {
  it('falls back to a backup when the main file is corrupt', async () => {
    const store = new WorkspaceStore(dir, { debounceMs: 1, backupIntervalMs: 0 })
    const good = populated()

    store.queue(good)
    await store.flush()
    // A second save rotates the good file into workspace.bak.1.json.
    store.queue(W.createDiscussion(good, 'لاحق'))
    await store.flush()

    await fs.writeFile(path.join(dir, 'workspace.json'), '{ this is not json', 'utf8')

    const recovered = await new WorkspaceStore(dir).load()
    expect(recovered.discussions.map((d) => d.title)).toEqual(['حوار الإلحاد'])
  })

  it('falls back when the file is valid JSON but the wrong shape', async () => {
    await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ version: 99 }), 'utf8')
    expect(await new WorkspaceStore(dir).load()).toEqual(W.defaultWorkspace())
  })

  it('does not rotate a backup again inside the interval', async () => {
    const store = new WorkspaceStore(dir, { debounceMs: 1, backupIntervalMs: 60_000 })
    for (let i = 0; i < 4; i++) {
      store.queue(W.createDiscussion(W.defaultWorkspace(), `حوار ${i}`))
      await store.flush()
    }
    const backups = (await fs.readdir(dir)).filter((f) => f.startsWith('workspace.bak.'))
    expect(backups).toHaveLength(0) // first write had nothing to back up; the rest are inside the window
  })
})

describe('sanitizeWorkspace', () => {
  it('rejects non-objects and unknown versions', () => {
    expect(sanitizeWorkspace(null)).toBeNull()
    expect(sanitizeWorkspace([])).toBeNull()
    expect(sanitizeWorkspace({ version: 2, discussions: [] })).toBeNull()
    expect(sanitizeWorkspace({ version: WORKSPACE_VERSION })).toBeNull()
  })

  it('drops malformed tabs but keeps the rest of the discussion', () => {
    const result = sanitizeWorkspace({
      version: WORKSPACE_VERSION,
      discussions: [
        {
          id: 'd1',
          title: 'حوار',
          tabs: [
            { id: 's1', kind: 'search', toolId: 'quran', title: 'بحث' },
            { id: 'bad', kind: 'search' }, // no toolId
            { kind: 'draft', title: 'رد' }, // no id
            { id: 'x1', kind: 'mystery' },
            { id: 'dr1', kind: 'draft', title: 'رد', content: 'نص' }
          ]
        }
      ],
      activeDiscussionId: 'd1'
    })
    expect(result?.discussions[0].tabs.map((t) => t.id)).toEqual(['s1', 'dr1'])
  })

  it('clears a stale active id that no longer resolves', () => {
    const result = sanitizeWorkspace({
      version: WORKSPACE_VERSION,
      discussions: [{ id: 'd1', title: 'حوار', tabs: [], activeSearchTabId: 'gone' }],
      activeDiscussionId: 'also-gone'
    })
    expect(result?.activeDiscussionId).toBeNull()
    expect(result?.discussions[0].activeSearchTabId).toBeNull()
  })

  it('restores defaults for missing or out-of-range settings', () => {
    const result = sanitizeWorkspace({
      version: WORKSPACE_VERSION,
      discussions: [],
      settings: { splitRatio: 42, sidebarCollapsed: 'yes' }
    })
    expect(result?.settings.splitRatio).toBe(W.MAX_SPLIT_RATIO)
    expect(result?.settings.sidebarCollapsed).toBe(false)
  })
})
