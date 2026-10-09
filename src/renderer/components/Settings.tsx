import { useEffect, useState } from 'react'
import type { SearchTool } from '@shared/types'
import { useApp } from '../state/store'

interface Shortcut {
  id: string
  accelerator: string
  description: string
}

interface DictationStatus {
  ready: boolean
  binaryPath: string | null
  modelPath: string | null
  progress: { what: string; received: number; total: number } | null
  error: string | null
  errorDetail: string | null
  gpu: string | null
  cudaInstalled: boolean
  backend: 'cuda' | 'cpu' | null
  backendDetail: string | null
}

const BACKEND_LABEL = { cuda: 'GPU (CUDA)', cpu: 'المعالج' } as const

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} م.ب`

/**
 * Settings overlay. It covers the search pane, so `SearchPane` hides the embedded
 * WebContentsView while it is open — otherwise the page would be drawn over it.
 */
export function Settings(): React.JSX.Element | null {
  const open = useApp((s) => s.ui.settingsOpen)
  const setUi = useApp((s) => s.setUi)
  const tools = useApp((s) => s.tools)
  const setTools = useApp((s) => s.setTools)
  const settings = useApp((s) => s.workspace.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const showToast = useApp((s) => s.showToast)

  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [dictation, setDictation] = useState<DictationStatus | null>(null)

  useEffect(() => {
    if (!open) return
    void window.api.listShortcuts().then(setShortcuts)
    void window.api.dictationStatus().then(setDictation)
  }, [open])

  // Progress arrives while a download runs.
  useEffect(() => window.api.onDictationStatus(setDictation), [])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setUi({ settingsOpen: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUi])

  if (!open) return null

  const editTool = async (tool: SearchTool, searchUrl: string | null): Promise<void> => {
    setTools(await window.api.setToolSearchUrl(tool.id, searchUrl))
    showToast(searchUrl ? `حُفظ نمط البحث لـ ${tool.label}` : `أُزيل نمط البحث لـ ${tool.label}`)
  }

  const toggleOverlay = async (tool: SearchTool, copyOverlay: boolean): Promise<void> => {
    setTools(await window.api.setToolCopyOverlay(tool.id, copyOverlay))
    showToast(
      copyOverlay
        ? `يظهر زر النسخ في ${tool.label}`
        : `يُعرض ${tool.label} كما هو، بأزرار نسخه الخاصة`
    )
  }

  return (
    <div className="settings" data-testid="settings" dir="rtl">
      <div className="settings__panel">
        <header className="settings__header">
          <h2>الإعدادات</h2>
          <button
            type="button"
            className="icon-btn"
            title="إغلاق"
            data-testid="close-settings"
            onClick={() => setUi({ settingsOpen: false })}
          >
            ✕
          </button>
        </header>

        <div className="settings__body">
          <section className="settings__section">
            <h3>عام</h3>
            <label className="settings__row">
              <input
                type="checkbox"
                checked={settings.appendSources}
                onChange={(e) => updateSettings({ appendSources: e.target.checked })}
              />
              إلحاق قائمة المصادر عند نسخ الرد
            </label>
            <label className="settings__row">
              <input
                type="checkbox"
                checked={settings.showArchived}
                onChange={(e) => updateSettings({ showArchived: e.target.checked })}
              />
              عرض المناقشات المؤرشفة
            </label>
          </section>

          <section className="settings__section">
            <h3>الإملاء الصوتي</h3>
            {dictation?.ready ? (
              <p className="settings__note" data-testid="dictation-ready">
                جاهز — اضغط مطوّلاً على <kbd>F4</kbd> للإملاء، أو انقره مرة للإملاء المستمر
                ومرة أخرى للإيقاف. يظهر النص في الرد بعد كل وقفة.
                <br />
                <span className="settings__path">{dictation.modelPath}</span>
              </p>
            ) : (
              <>
                <p className="settings__note">
                  إملاء عربي محلي عبر whisper.cpp — بلا اتصال وبلا تكلفة. يلزم تنزيل
                  البرنامج والنموذج مرة واحدة (نحو ٦٠٠ م.ب).
                </p>
                <button
                  type="button"
                  className="btn"
                  data-testid="install-dictation"
                  disabled={Boolean(dictation?.progress)}
                  onClick={() => void window.api.installDictation().then(setDictation)}
                >
                  {dictation?.progress ? 'جارٍ التنزيل…' : 'تنزيل وتهيئة'}
                </button>
              </>
            )}
            {dictation?.gpu && (
              <div className="settings__note" data-testid="dictation-gpu">
                تسريع GPU: <span className="settings__path">{dictation.gpu}</span>
                {dictation.backend && <> — يعمل الآن على {BACKEND_LABEL[dictation.backend]}</>}
                {dictation.ready && !dictation.cudaInstalled && (
                  <>
                    <br />
                    الإملاء أسرع بكثير على بطاقة الرسوم.{' '}
                    <button
                      type="button"
                      className="btn"
                      data-testid="install-cuda"
                      disabled={Boolean(dictation.progress)}
                      onClick={() => void window.api.installDictation().then(setDictation)}
                    >
                      {dictation.progress ? 'جارٍ التنزيل…' : 'تنزيل تسريع GPU (~٤٤٣ م.ب)'}
                    </button>
                  </>
                )}
                {dictation.backend === 'cpu' && dictation.cudaInstalled && dictation.backendDetail && (
                  <>
                    <br />
                    تعذّر تشغيل نسخة GPU، فيعمل الإملاء على المعالج:{' '}
                    <span className="settings__path">{dictation.backendDetail}</span>
                  </>
                )}
              </div>
            )}
            {dictation?.progress && (
              <p className="settings__note" data-testid="dictation-progress">
                {dictation.progress.what}: {mb(dictation.progress.received)}
                {dictation.progress.total > 0 && ` / ${mb(dictation.progress.total)}`}
              </p>
            )}
            {dictation?.error && (
              <p className="settings__error">
                {dictation.error}
                {dictation.errorDetail && (
                  <>
                    <br />
                    <span className="settings__path">{dictation.errorDetail}</span>
                  </>
                )}
              </p>
            )}
          </section>

          <section className="settings__section">
            <h3>أدوات البحث</h3>
            <table className="settings__tools">
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.id} data-testid="settings-tool">
                    <td className="settings__tool-label">
                      {tool.label}
                      <span className="settings__key">{tool.shortcut}</span>
                    </td>
                    <td>
                      {tool.type === 'local' ? (
                        <span className="settings__note">مكتبة محلية</span>
                      ) : (
                        <input
                          className="settings__url"
                          defaultValue={tool.searchUrl ?? ''}
                          placeholder="لم يُضبط بعد — استخدم ⚙ في شريط البحث"
                          spellCheck={false}
                          onBlur={(e) => {
                            const next = e.target.value.trim() || null
                            if (next !== tool.searchUrl) void editTool(tool, next)
                          }}
                        />
                      )}
                    </td>
                    <td>
                      {tool.type === 'web' && (
                        <label
                          className="settings__row settings__overlay"
                          title="أطفئه للمواقع التي تكفيها أزرار النسخ الخاصة بها"
                        >
                          <input
                            type="checkbox"
                            data-testid="tool-copy-overlay"
                            checked={tool.copyOverlay}
                            onChange={(e) => void toggleOverlay(tool, e.target.checked)}
                          />
                          زر النسخ
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="settings__section">
            <h3>الاختصارات</h3>
            <ul className="settings__shortcuts" data-testid="settings-shortcuts">
              {shortcuts.map((shortcut) => (
                <li key={shortcut.id}>
                  <span>{shortcut.description}</span>
                  <kbd>{shortcut.accelerator}</kbd>
                </li>
              ))}
              <li>
                <span>نسخ التحديد مع المصدر</span>
                <kbd>Ctrl+Shift+C</kbd>
              </li>
              <li>
                <span>إرسال التحديد إلى الرد</span>
                <kbd>Ctrl+Enter</kbd>
              </li>
              <li>
                <span>الإملاء الصوتي (مطوّلاً، أو نقرة للإملاء المستمر)</span>
                <kbd>F4</kbd>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
