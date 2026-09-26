import { describe, expect, it } from 'vitest'
import type { DraftTab, SearchTab, Workspace } from '@shared/types'
import * as W from '@shared/workspace'

/** A workspace with one discussion holding the given number of search and draft tabs. */
function seeded(searchCount = 0, draftCount = 0): { ws: Workspace; id: string } {
  let ws = W.createDiscussion(W.defaultWorkspace(), 'حوار')
  const id = ws.activeDiscussionId!
  for (let i = 0; i < searchCount; i++) {
    ws = W.addSearchTab(ws, id, { toolId: 'quran', title: `بحث ${i + 1}` })
  }
  for (let i = 0; i < draftCount; i++) {
    ws = W.addDraftTab(ws, id)
  }
  return { ws, id }
}

const searchIds = (ws: Workspace, id: string): string[] =>
  W.tabsOfKind(W.findDiscussion(ws, id)!, 'search').map((t) => t.id)

describe('discussions', () => {
  it('creates a discussion and selects it', () => {
    const ws = W.createDiscussion(W.defaultWorkspace(), '  حوار الإلحاد  ')
    expect(ws.discussions).toHaveLength(1)
    expect(ws.discussions[0].title).toBe('حوار الإلحاد')
    expect(ws.activeDiscussionId).toBe(ws.discussions[0].id)
  })

  it('falls back to a default title when given only whitespace', () => {
    const ws = W.createDiscussion(W.defaultWorkspace(), '   ')
    expect(ws.discussions[0].title).toBe('مناقشة جديدة')
  })

  it('ignores a rename to an empty title', () => {
    const { ws, id } = seeded()
    expect(W.renameDiscussion(ws, id, '  ')).toBe(ws)
  })

  it('cycles across discussions and wraps at both ends', () => {
    let ws = W.createDiscussion(W.defaultWorkspace(), 'أ')
    ws = W.createDiscussion(ws, 'ب')
    ws = W.createDiscussion(ws, 'ج')
    const [a, b, c] = ws.discussions.map((d) => d.id)

    expect(ws.activeDiscussionId).toBe(c)
    expect(W.cycleDiscussion(ws, 1).activeDiscussionId).toBe(a) // wraps forward
    ws = W.selectDiscussion(ws, a)
    expect(W.cycleDiscussion(ws, -1).activeDiscussionId).toBe(c) // wraps backward
    expect(W.cycleDiscussion(ws, 1).activeDiscussionId).toBe(b)
  })

  it('skips archived discussions when cycling and reselects on archive', () => {
    let ws = W.createDiscussion(W.defaultWorkspace(), 'أ')
    const a = ws.activeDiscussionId!
    ws = W.createDiscussion(ws, 'ب')
    const b = ws.activeDiscussionId!

    ws = W.setDiscussionArchived(ws, b, true)
    expect(ws.activeDiscussionId).toBe(a)
    expect(W.visibleDiscussions(ws).map((d) => d.id)).toEqual([a])
    expect(W.cycleDiscussion(ws, 1).activeDiscussionId).toBe(a)
  })

  it('selects a neighbour when the active discussion is deleted', () => {
    let ws = W.createDiscussion(W.defaultWorkspace(), 'أ')
    ws = W.createDiscussion(ws, 'ب')
    ws = W.createDiscussion(ws, 'ج')
    const [, b, c] = ws.discussions.map((d) => d.id)

    ws = W.deleteDiscussion(W.selectDiscussion(ws, b), b)
    expect(ws.activeDiscussionId).toBe(c) // the one that shifted into b's slot
    expect(ws.discussions).toHaveLength(2)
  })

  it('leaves the workspace untouched for unknown ids', () => {
    const { ws } = seeded()
    expect(W.deleteDiscussion(ws, 'nope')).toBe(ws)
    expect(W.selectDiscussion(ws, 'nope')).toBe(ws)
    expect(W.renameDiscussion(ws, 'nope', 'x')).toBe(ws)
  })
})

describe('tabs', () => {
  it('keeps search and draft selection independent', () => {
    const { ws, id } = seeded(2, 2)
    const d = W.findDiscussion(ws, id)!
    const search = W.tabsOfKind(d, 'search')
    const drafts = W.tabsOfKind(d, 'draft')

    expect(d.activeSearchTabId).toBe(search[1].id)
    expect(d.activeDraftTabId).toBe(drafts[1].id)

    const next = W.selectTab(ws, id, search[0].id)
    const nd = W.findDiscussion(next, id)!
    expect(nd.activeSearchTabId).toBe(search[0].id)
    expect(nd.activeDraftTabId).toBe(drafts[1].id) // untouched
  })

  it('numbers new drafts sequentially', () => {
    const { ws, id } = seeded(0, 2)
    expect(W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft').map((t) => t.title)).toEqual([
      'رد 1',
      'رد 2'
    ])
  })

  it('cycles tabs within one kind only, wrapping', () => {
    const { ws, id } = seeded(3, 1)
    const ids = searchIds(ws, id)

    let next = W.cycleTab(ws, id, 'search', 1) // from the last → wraps to the first
    expect(W.findDiscussion(next, id)!.activeSearchTabId).toBe(ids[0])
    next = W.cycleTab(next, id, 'search', -1)
    expect(W.findDiscussion(next, id)!.activeSearchTabId).toBe(ids[2])
  })

  it('jumps to the first and last tab of a kind', () => {
    const { ws, id } = seeded(3, 0)
    const ids = searchIds(ws, id)
    expect(W.findDiscussion(W.jumpTab(ws, id, 'search', 'first'), id)!.activeSearchTabId).toBe(ids[0])
    expect(W.findDiscussion(W.jumpTab(ws, id, 'search', 'last'), id)!.activeSearchTabId).toBe(ids[2])
  })

  it('is a no-op when cycling a kind with no tabs', () => {
    const { ws, id } = seeded(0, 0)
    expect(W.findDiscussion(W.cycleTab(ws, id, 'search', 1), id)!.activeSearchTabId).toBeNull()
  })

  it('moves focus to a neighbour when the active tab closes', () => {
    const { ws, id } = seeded(3, 0)
    const ids = searchIds(ws, id)

    // Closing the middle tab while it is active selects the one after it.
    let next = W.selectTab(ws, id, ids[1])
    next = W.closeTab(next, id, ids[1])
    expect(W.findDiscussion(next, id)!.activeSearchTabId).toBe(ids[2])

    // Closing the last tab while it is active falls back to the previous one.
    next = W.closeTab(next, id, ids[2])
    expect(W.findDiscussion(next, id)!.activeSearchTabId).toBe(ids[0])

    next = W.closeTab(next, id, ids[0])
    expect(W.findDiscussion(next, id)!.activeSearchTabId).toBeNull()
  })

  it('leaves selection alone when closing an inactive tab', () => {
    const { ws, id } = seeded(3, 0)
    const ids = searchIds(ws, id)
    const next = W.closeTab(ws, id, ids[0]) // active is ids[2]
    expect(W.findDiscussion(next, id)!.activeSearchTabId).toBe(ids[2])
  })
})

describe('tab contents', () => {
  it('records where a search tab navigated', () => {
    const { ws, id } = seeded(1, 0)
    const tabId = searchIds(ws, id)[0]
    const next = W.setSearchTabLocation(ws, id, tabId, 'https://tafsir.app/search?q=x', 'الصبر')
    const tab = W.findTab(next, id, tabId) as SearchTab
    expect(tab.url).toBe('https://tafsir.app/search?q=x')
    expect(tab.query).toBe('الصبر')
  })

  it('appends to a draft with a blank line and records the source', () => {
    const { ws, id } = seeded(0, 1)
    const tabId = W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft')[0].id
    const source = { text: 'نص', pageTitle: 'صفحة', url: 'https://x', at: '2026-01-01' }

    let next = W.appendToDraft(ws, id, tabId, 'الفقرة الأولى')
    next = W.appendToDraft(next, id, tabId, '  الفقرة الثانية  ', source)

    const draft = W.findTab(next, id, tabId) as DraftTab
    expect(draft.content).toBe('الفقرة الأولى\n\nالفقرة الثانية')
    expect(draft.sources).toEqual([source])
  })

  it('ignores an append of only whitespace', () => {
    const { ws, id } = seeded(0, 1)
    const tabId = W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft')[0].id
    expect(W.appendToDraft(ws, id, tabId, '   \n ')).toBe(ws)
  })

  it('does not touch the workspace when draft content is unchanged', () => {
    const { ws, id } = seeded(0, 1)
    const tabId = W.tabsOfKind(W.findDiscussion(ws, id)!, 'draft')[0].id
    const typed = W.setDraftContent(ws, id, tabId, 'نص')
    const again = W.setDraftContent(typed, id, tabId, 'نص')
    expect((W.findTab(again, id, tabId) as DraftTab).updatedAt).toBe(
      (W.findTab(typed, id, tabId) as DraftTab).updatedAt
    )
  })
})

describe('settings', () => {
  it('clamps the split ratio into the usable range', () => {
    expect(W.clampSplitRatio(0.001)).toBe(W.MIN_SPLIT_RATIO)
    expect(W.clampSplitRatio(0.99)).toBe(W.MAX_SPLIT_RATIO)
    expect(W.clampSplitRatio(0.5)).toBe(0.5)
    expect(W.clampSplitRatio(Number.NaN)).toBe(W.defaultSettings().splitRatio)
  })

  it('clamps through updateSettings', () => {
    const ws = W.updateSettings(W.defaultWorkspace(), { splitRatio: 5 })
    expect(ws.settings.splitRatio).toBe(W.MAX_SPLIT_RATIO)
  })
})
