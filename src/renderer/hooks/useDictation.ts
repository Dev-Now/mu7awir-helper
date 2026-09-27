import { useCallback, useEffect, useRef, useState } from 'react'
import { makeSource } from '@shared/text'
import { Recorder } from '../lib/recorder'
import { useApp } from '../state/store'

export type DictationPhase = 'idle' | 'recording' | 'transcribing'

export interface DictationState {
  phase: DictationPhase
  level: number
}

/** Anything shorter than this is a mis-press, not speech. */
const MIN_CLIP_SECONDS = 0.4

/**
 * Push-to-talk dictation: hold the key, speak, release. Transcription runs locally in
 * main and the text is inserted at the caret of whatever draft is open.
 */
export function useDictation(): DictationState {
  const appendToActiveDraft = useApp((s) => s.appendToActiveDraft)
  const showToast = useApp((s) => s.showToast)

  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [level, setLevel] = useState(0)
  const recorder = useRef<Recorder | null>(null)
  const startedAt = useRef(0)
  /** Set while a start is in flight, so a fast release cannot overtake it. */
  const starting = useRef<Promise<void> | null>(null)

  const start = useCallback(async () => {
    if (phase !== 'idle' || starting.current) return

    const status = await window.api.dictationStatus()
    if (!status.ready) {
      showToast('الإملاء غير مهيأ — نزّل نموذج whisper من الإعدادات', 'warn')
      return
    }

    recorder.current ??= new Recorder()
    const pending = recorder.current.start()
    starting.current = pending
    try {
      await pending
      startedAt.current = Date.now()
      setPhase('recording')
    } catch {
      showToast('تعذّر الوصول إلى الميكروفون', 'warn')
    } finally {
      starting.current = null
    }
  }, [phase, showToast])

  const stop = useCallback(async () => {
    await starting.current
    const active = recorder.current
    if (!active?.recording) return

    const heldFor = (Date.now() - startedAt.current) / 1000
    setPhase('transcribing')
    setLevel(0)

    try {
      const wav = await active.stop()
      if (!wav || heldFor < MIN_CLIP_SECONDS) {
        showToast('التسجيل قصير جدًا', 'warn')
        return
      }

      const text = await window.api.transcribe(wav)
      if (!text) {
        showToast('لم يُسمع أي كلام', 'warn')
        return
      }

      // Prefer the caret in the open editor; fall back to appending.
      const inserted = useApp.getState().draftInsert?.(text)
      if (!inserted) {
        appendToActiveDraft(text, makeSource(text, 'إملاء صوتي', ''))
      }
      showToast(`أُمليت: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`)
    } catch (err) {
      showToast(`تعذّر التفريغ: ${(err as Error).message}`, 'warn')
    } finally {
      setPhase('idle')
    }
  }, [appendToActiveDraft, showToast])

  // F4 is push-to-talk; Escape abandons the clip.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'F4' && !event.repeat) {
        event.preventDefault()
        void start()
      } else if (event.key === 'Escape' && phase === 'recording') {
        recorder.current?.cancel()
        setPhase('idle')
        showToast('أُلغي التسجيل')
      }
    }
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'F4') {
        event.preventDefault()
        void stop()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [phase, showToast, start, stop])

  // Drive the level meter only while it is on screen.
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => setLevel(recorder.current?.level() ?? 0), 80)
    return () => clearInterval(timer)
  }, [phase])

  return { phase, level }
}
