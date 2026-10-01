import type { DictationState } from '../hooks/useDictation'

const BARS = 14

/** Keep the preview to one line: the newest words are the ones worth seeing. */
const PREVIEW_CHARS = 70

const tail = (text: string): string =>
  text.length > PREVIEW_CHARS ? `…${text.slice(-PREVIEW_CHARS)}` : text

/** Overlay shown while dictation is active. */
export function DictationHud({
  phase,
  mode,
  level,
  preview,
  pending
}: DictationState): React.JSX.Element | null {
  if (phase === 'idle') return null

  const lit = Math.round(level * BARS)
  return (
    <div
      className={`hud hud--${phase}`}
      data-testid="dictation-hud"
      data-phase={phase}
      data-mode={mode}
      dir="rtl"
    >
      {phase === 'recording' ? (
        <>
          <span className="hud__dot" />
          <span className="hud__label">
            {mode === 'handsfree' ? 'إملاء مستمر… اضغط F4 للإيقاف' : 'جارٍ التسجيل… أفلت F4 للإنهاء'}
          </span>
          <span className="hud__meter" aria-hidden>
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} className={i < lit ? 'hud__bar hud__bar--lit' : 'hud__bar'} />
            ))}
          </span>
          {pending > 0 && (
            <span className="hud__pending" title="مقاطع قيد التفريغ" data-testid="dictation-pending">
              {pending}
            </span>
          )}
          {preview && (
            <span className="hud__preview" data-testid="dictation-preview">
              {tail(preview)}
            </span>
          )}
        </>
      ) : (
        <>
          <span className="hud__spinner" />
          <span className="hud__label">
            جارٍ إنهاء التفريغ…{pending > 0 && ` (${pending})`}
          </span>
        </>
      )}
    </div>
  )
}
