import { useCallback, useEffect, useRef, useState } from 'react'
import { Segmenter } from '@shared/segmenter'
import { makeSource } from '@shared/text'
import { encodeWav, WHISPER_SAMPLE_RATE } from '@shared/wav'
import { Recorder } from '../lib/recorder'
import { useApp } from '../state/store'

export type DictationPhase = 'idle' | 'recording' | 'finishing'

/** Held F4 is push-to-talk; a tap leaves the microphone open until the next press. */
export type DictationMode = 'hold' | 'handsfree'

export interface DictationState {
  phase: DictationPhase
  mode: DictationMode
  level: number
  /** The phrase still being spoken, as best the model can tell so far. */
  preview: string
  /** Phrases sent for transcription that have not reached the draft yet. */
  pending: number
}

/** A press released sooner than this is a tap, which switches to hands-free. */
const TAP_MS = 300

/** How often the open phrase is re-read for the HUD. */
const PREVIEW_INTERVAL_MS = 500

/** Below this there is too little audio for a preview worth showing. */
const PREVIEW_MIN_SAMPLES = WHISPER_SAMPLE_RATE / 2

/** Recent text is passed along so each phrase continues the last one coherently. */
const PROMPT_CHARS = 200

type Outcome = { text: string } | { error: Error }

/**
 * Live dictation. Audio is cut into phrases at natural pauses while the user is still
 * speaking; each phrase is transcribed locally in main and inserted at the caret of the open
 * draft as soon as it is ready, strictly in the order it was spoken.
 */
export function useDictation(): DictationState {
  const appendToActiveDraft = useApp((s) => s.appendToActiveDraft)
  const showToast = useApp((s) => s.showToast)

  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [mode, setMode] = useState<DictationMode>('hold')
  const [level, setLevel] = useState(0)
  const [preview, setPreview] = useState('')
  const [pending, setPending] = useState(0)

  // Key events and transcription results arrive outside React's render cycle, so the
  // session's working state lives in refs; the useState mirrors only drive the HUD.
  const phaseRef = useRef<DictationPhase>('idle')
  const modeRef = useRef<DictationMode>('hold')
  const recorder = useRef<Recorder | null>(null)
  const segmenter = useRef<Segmenter | null>(null)
  /** Set while a start is in flight, so a fast release cannot overtake it. */
  const starting = useRef<Promise<void> | null>(null)
  const pressedAt = useRef(0)

  /** Bumped on every start and cancel; results from an older session are ignored. */
  const session = useRef(0)
  const nextSeq = useRef(0)
  const nextToInsert = useRef(0)
  const outcomes = useRef(new Map<number, Outcome>())
  const spoken = useRef('')
  const failed = useRef(false)
  const previewBusy = useRef(false)

  const enter = useCallback((next: DictationPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const switchMode = useCallback((next: DictationMode) => {
    modeRef.current = next
    setMode(next)
  }, [])

  const insert = useCallback(
    (text: string) => {
      // Prefer the caret in the open editor; fall back to appending.
      const inserted = useApp.getState().draftInsert?.(text)
      if (!inserted) appendToActiveDraft(text, makeSource(text, 'إملاء صوتي', ''))
    },
    [appendToActiveDraft]
  )

  /** Settle the session once the microphone is closed and every phrase is in. */
  const finishIfDone = useCallback(() => {
    if (phaseRef.current !== 'finishing' || nextToInsert.current < nextSeq.current) return
    if (nextSeq.current === 0) showToast('لم يُسمع أي كلام', 'warn')
    enter('idle')
  }, [enter, showToast])

  /** Insert whatever has come back, in spoken order — a fast phrase waits for a slow one. */
  const drain = useCallback(() => {
    while (outcomes.current.has(nextToInsert.current)) {
      const outcome = outcomes.current.get(nextToInsert.current)!
      outcomes.current.delete(nextToInsert.current)
      nextToInsert.current++

      if ('text' in outcome) {
        if (outcome.text) {
          insert(outcome.text)
          spoken.current = `${spoken.current} ${outcome.text}`.slice(-PROMPT_CHARS)
        }
      } else if (!failed.current) {
        // One toast per session; the remaining phrases carry on regardless.
        failed.current = true
        showToast(`تعذّر تفريغ جزء من الإملاء: ${outcome.error.message}`, 'warn')
      }
    }
    setPending(nextSeq.current - nextToInsert.current)
    finishIfDone()
  }, [finishIfDone, insert, showToast])

  const sendPhrase = useCallback(
    (samples: Float32Array) => {
      const seq = nextSeq.current++
      const owner = session.current
      setPending(nextSeq.current - nextToInsert.current)
      setPreview('')

      window.api
        .transcribeSegment(encodeWav(samples, WHISPER_SAMPLE_RATE), spoken.current.trim())
        .then(
          (text): Outcome => ({ text }),
          (error: Error): Outcome => ({ error })
        )
        .then((outcome) => {
          if (session.current !== owner) return
          outcomes.current.set(seq, outcome)
          drain()
        })
    },
    [drain]
  )

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle' || starting.current) return

    const run = async (): Promise<void> => {
      const status = await window.api.dictationStatus()
      if (!status.ready) {
        showToast('الإملاء غير مهيأ — نزّل نموذج whisper من الإعدادات', 'warn')
        return
      }
      // Load the model while the user starts talking, not when the first phrase ends.
      void window.api.warmDictation()

      session.current++
      nextSeq.current = 0
      nextToInsert.current = 0
      outcomes.current.clear()
      spoken.current = ''
      failed.current = false
      setPending(0)
      setPreview('')

      segmenter.current = new Segmenter(sendPhrase)
      recorder.current ??= new Recorder()
      try {
        const cut = segmenter.current
        await recorder.current.start((samples) => cut.push(samples))
        switchMode('hold')
        enter('recording')
      } catch {
        segmenter.current = null
        showToast('تعذّر الوصول إلى الميكروفون', 'warn')
      }
    }

    const pendingStart = run()
    starting.current = pendingStart
    try {
      await pendingStart
    } finally {
      starting.current = null
    }
  }, [enter, sendPhrase, showToast, switchMode])

  /** Close the microphone and send the last phrase; the HUD stays until it is in. */
  const stop = useCallback(async () => {
    await starting.current
    if (phaseRef.current !== 'recording') return

    recorder.current?.stop()
    enter('finishing')
    setLevel(0)
    setPreview('')
    segmenter.current?.flush()
    segmenter.current = null
    finishIfDone()
  }, [enter, finishIfDone])

  const cancel = useCallback(() => {
    recorder.current?.stop()
    segmenter.current?.reset()
    segmenter.current = null
    session.current++ // anything still in flight is now stale
    outcomes.current.clear()
    setPending(0)
    setPreview('')
    setLevel(0)
    enter('idle')
    showToast('أُلغي التسجيل')
  }, [enter, showToast])

  // Both edges of F4 are matched in main and relayed here, so dictation works even while
  // focus is inside an embedded search page.
  useEffect(
    () =>
      window.api.onDictationKey((edge) => {
        if (edge === 'down') {
          if (phaseRef.current === 'idle') {
            pressedAt.current = Date.now()
            void start()
          } else if (phaseRef.current === 'recording' && modeRef.current === 'handsfree') {
            void stop()
          }
          return
        }

        // Key up: tap or hold? Timed now, before waiting out a start still in flight —
        // opening the microphone can itself take longer than a tap.
        const heldFor = Date.now() - pressedAt.current
        void (async () => {
          await starting.current
          if (phaseRef.current !== 'recording' || modeRef.current !== 'hold') return
          if (heldFor < TAP_MS) switchMode('handsfree')
          else void stop()
        })()
      }),
    [start, stop, switchMode]
  )

  // Escape abandons the session: the open phrase and anything not yet inserted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && phaseRef.current !== 'idle') cancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancel])

  // Drive the level meter only while it is on screen.
  useEffect(() => {
    if (phase !== 'recording') return
    const timer = setInterval(() => setLevel(recorder.current?.level() ?? 0), 80)
    return () => clearInterval(timer)
  }, [phase])

  // Re-read the open phrase for the HUD. Main answers null whenever real phrases are
  // queued or there is no GPU, so this can never slow the text that lands in the draft.
  useEffect(() => {
    if (phase !== 'recording') return
    let lastLength = 0
    const timer = setInterval(() => {
      const open = segmenter.current?.current()
      if (previewBusy.current || !open || open.length < PREVIEW_MIN_SAMPLES) return
      if (open.length === lastLength) return
      lastLength = open.length

      const owner = session.current
      // If the phrase closes while its preview is in flight, the answer is already stale.
      const phrase = nextSeq.current
      previewBusy.current = true
      window.api
        .previewSegment(encodeWav(open, WHISPER_SAMPLE_RATE), spoken.current.trim())
        .then((text) => {
          const current = session.current === owner && nextSeq.current === phrase
          if (text !== null && current && phaseRef.current === 'recording') setPreview(text)
        })
        .catch(() => {})
        .finally(() => {
          previewBusy.current = false
        })
    }, PREVIEW_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [phase])

  return { phase, mode, level, preview, pending }
}
