import { useApp } from './state/store'

/**
 * Shell layout: sidebar on the left, then the two panes stacked vertically —
 * search on top, drafts below, with a draggable splitter between them (M1).
 */
export function App(): React.JSX.Element {
  const loaded = useApp((s) => s.loaded)
  const splitRatio = useApp((s) => s.workspace.settings.splitRatio)
  const sidebarCollapsed = useApp((s) => s.workspace.settings.sidebarCollapsed)
  const discussions = useApp((s) => s.workspace.discussions)

  return (
    <div className={`shell${sidebarCollapsed ? ' shell--collapsed' : ''}`} data-testid="shell">
      <aside className="sidebar" data-testid="sidebar">
        <div className="sidebar__header">المناقشات</div>
        <ul className="sidebar__list">
          {discussions.map((d) => (
            <li key={d.id} className="discussion" dir="auto">
              {d.title}
            </li>
          ))}
        </ul>
      </aside>

      <main
        className="content"
        style={{ gridTemplateRows: `${splitRatio}fr var(--splitter) ${1 - splitRatio}fr` }}
      >
        <section className="pane" data-testid="search-pane">
          <div className="tabbar" data-testid="search-tabbar" />
          <div className="pane__body pane__body--empty">
            {loaded ? 'لا يوجد بحث بعد' : '…'}
          </div>
        </section>

        <div className="splitter" data-testid="splitter" role="separator" aria-orientation="horizontal" />

        <section className="pane" data-testid="draft-pane">
          <div className="tabbar" data-testid="draft-tabbar" />
          <div className="pane__body pane__body--empty">لا يوجد رد بعد</div>
        </section>
      </main>
    </div>
  )
}
