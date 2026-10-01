/**
 * Cuts a live microphone stream into phrases at natural pauses.
 *
 * Whisper is fast on a short phrase and slow — or, past 30 s, lossy — on a long clip. So
 * instead of transcribing one recording when the key is released, the stream is split while
 * the user is still speaking and each phrase is transcribed as soon as it ends (issue #5).
 *
 * Voice detection is a plain energy gate against an adaptive noise floor. The microphone
 * already runs Chromium's noise suppression, so this does not need to be clever; it only
 * needs to find the gaps between phrases.
 */

export interface SegmenterOptions {
  sampleRate?: number
  /** Analysis granularity. */
  frameMs?: number
  /** A pause at least this long ends a phrase... */
  endSilenceMs?: number
  /** ...provided the phrase holds this much speech; shorter ones wait for a longer pause. */
  minSpeechMs?: number
  /** No phrase grows past this; whisper's window is 30 s, and latency grows with length. */
  maxSegmentMs?: number
  /** When forced to cut, it happens at the quietest frame within this tail. */
  cutSearchMs?: number
  /** Silence kept either side of the speech, so first and last syllables are not clipped. */
  padMs?: number
  /** Absolute energy below which nothing counts as speech, however quiet the room. */
  minThreshold?: number
}

const DEFAULTS: Required<SegmenterOptions> = {
  sampleRate: 16_000,
  frameMs: 20,
  endSilenceMs: 500,
  minSpeechMs: 400,
  maxSegmentMs: 15_000,
  cutSearchMs: 1_500,
  padMs: 200,
  minThreshold: 0.01
}

/** Speech has to stand this far above the noise floor. */
const FLOOR_RATIO = 3

/**
 * The floor is the quietest frame of the last few seconds. Speech always dips between
 * syllables, so this follows the room's noise without being dragged up by a long phrase.
 */
const FLOOR_WINDOW_MS = 3_000

/** However loud the room, quiet speech must still get through. */
const MAX_FLOOR = 0.02

export function concat(parts: readonly Float32Array[]): Float32Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Float32Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function rms(frame: Float32Array): number {
  let sum = 0
  for (const sample of frame) sum += sample * sample
  return Math.sqrt(sum / frame.length)
}

export class Segmenter {
  private readonly opts: Required<SegmenterOptions>
  private readonly frameSize: number
  private readonly onSegment: (samples: Float32Array) => void

  /** The open phrase, frame by frame. */
  private frames: Float32Array[] = []
  private energy: number[] = []
  private voiced: boolean[] = []
  private voicedCount = 0
  private silenceRun = 0

  /** Samples left over from a push that did not fill a whole frame. */
  private partial = new Float32Array(0)
  /** Recent frame energies, for the noise floor. */
  private recent: number[] = []

  constructor(onSegment: (samples: Float32Array) => void, options: SegmenterOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
    this.frameSize = Math.round((this.opts.sampleRate * this.opts.frameMs) / 1000)
    this.onSegment = onSegment
  }

  private count(ms: number): number {
    return Math.max(1, Math.round(ms / this.opts.frameMs))
  }

  /** Feed captured audio, in chunks of any size. */
  push(chunk: Float32Array): void {
    let samples = chunk
    if (this.partial.length > 0) samples = concat([this.partial, chunk])

    let at = 0
    while (samples.length - at >= this.frameSize) {
      // Copy: the caller's buffer may be reused by the audio thread.
      this.addFrame(samples.slice(at, at + this.frameSize))
      at += this.frameSize
    }
    this.partial = samples.slice(at)
  }

  private isSpeech(level: number): boolean {
    this.recent.push(level)
    if (this.recent.length > this.count(FLOOR_WINDOW_MS)) this.recent.shift()
    const floor = Math.min(MAX_FLOOR, ...this.recent)
    return level > Math.max(this.opts.minThreshold, floor * FLOOR_RATIO)
  }

  private addFrame(frame: Float32Array): void {
    const level = rms(frame)
    const speech = this.isSpeech(level)

    this.frames.push(frame)
    this.energy.push(level)
    this.voiced.push(speech)

    if (speech) {
      this.voicedCount++
      this.silenceRun = 0
    } else {
      this.silenceRun++
    }

    // Before any speech, keep only enough lead-in to pad the phrase's first syllable.
    if (this.voicedCount === 0) {
      this.trimLeadIn()
      return
    }

    // A short blip waits a little longer in case more speech follows, but a lone word
    // followed by a real pause is a phrase in its own right.
    const pause = this.voicedCount >= this.count(this.opts.minSpeechMs)
      ? this.count(this.opts.endSilenceMs)
      : this.count(this.opts.endSilenceMs * 3)
    if (this.silenceRun >= pause) {
      // End of phrase: keep a little of the pause, and carry the rest as the next lead-in.
      this.emitUpTo(this.frames.length - this.silenceRun + this.count(this.opts.padMs))
    } else if (this.frames.length >= this.count(this.opts.maxSegmentMs)) {
      this.emitUpTo(this.quietestCut())
    }
  }

  private trimLeadIn(): void {
    const keep = this.count(this.opts.padMs)
    if (this.frames.length <= keep) return
    const drop = this.frames.length - keep
    this.frames.splice(0, drop)
    this.energy.splice(0, drop)
    this.voiced.splice(0, drop)
  }

  /** The least disruptive place to split a phrase that ran too long. */
  private quietestCut(): number {
    const end = this.frames.length
    const start = Math.max(1, end - this.count(this.opts.cutSearchMs))
    let best = end
    for (let i = start; i < end; i++) {
      if (this.energy[i] < (this.energy[best] ?? Infinity)) best = i
    }
    return best
  }

  /** Emit frames [0, end) as a phrase; whatever follows opens the next one. */
  private emitUpTo(end: number): void {
    const cut = Math.min(end, this.frames.length)
    const phrase = this.frames.slice(0, cut)
    const hadSpeech = this.voiced.slice(0, cut).some(Boolean)

    this.frames = this.frames.slice(cut)
    this.energy = this.energy.slice(cut)
    this.voiced = this.voiced.slice(cut)
    this.voicedCount = this.voiced.filter(Boolean).length
    this.silenceRun = 0
    for (let i = this.voiced.length - 1; i >= 0 && !this.voiced[i]; i--) this.silenceRun++
    if (this.voicedCount === 0) this.trimLeadIn()

    if (hadSpeech) this.onSegment(concat(phrase))
  }

  /** The phrase still being spoken, or null while there is only silence. */
  current(): Float32Array | null {
    if (this.voicedCount === 0) return null
    return concat(this.frames)
  }

  /** Seconds of audio in the open phrase. */
  get pendingSeconds(): number {
    return (this.frames.length * this.opts.frameMs) / 1000
  }

  /**
   * Emit whatever is open. At the end of a recording even a short word counts — "نعم" is
   * a whole answer — so only pure silence is dropped here.
   */
  flush(): void {
    if (this.partial.length > 0) {
      const padded = new Float32Array(this.frameSize)
      padded.set(this.partial)
      this.partial = new Float32Array(0)
      this.addFrame(padded)
    }
    if (this.voicedCount > 0) {
      let last = this.voiced.length - 1
      while (last > 0 && !this.voiced[last]) last--
      this.emitUpTo(last + 1 + this.count(this.opts.padMs))
    }
    this.reset()
  }

  /** Drop everything, as on cancel. */
  reset(): void {
    this.frames = []
    this.energy = []
    this.voiced = []
    this.voicedCount = 0
    this.silenceRun = 0
    this.partial = new Float32Array(0)
  }
}
