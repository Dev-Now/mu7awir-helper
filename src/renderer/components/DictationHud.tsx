import type { DictationState } from '../hooks/useDictation'

const BARS = 14

/** Overlay shown while push-to-talk is active. */
export function DictationHud({ phase, level }: DictationState): React.JSX.Element | null {
  if (phase === 'idle') return null

  const lit = Math.round(level * BARS)
  return (
    <div className={`hud hud--${phase}`} data-testid="dictation-hud" data-phase={phase} dir="auto">
      {phase === 'recording' ? (
        <>
          <span className="hud__dot" />
          <span className="hud__label">جارٍ التسجيل… أفلت F4 للتفريغ</span>
          <span className="hud__meter" aria-hidden>
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} className={i < lit ? 'hud__bar hud__bar--lit' : 'hud__bar'} />
            ))}
          </span>
        </>
      ) : (
        <>
          <span className="hud__spinner" />
          <span className="hud__label">جارٍ التفريغ…</span>
        </>
      )}
    </div>
  )
}
