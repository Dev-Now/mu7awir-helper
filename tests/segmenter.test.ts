import { describe, expect, it } from 'vitest'
import { concat, Segmenter } from '@shared/segmenter'

const RATE = 16_000

/** A 220 Hz tone — loud enough to count as speech. */
function tone(ms: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round((RATE * ms) / 1000))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return out
}

/** Room noise well under the speech threshold. */
function hush(ms: number, amplitude = 0.001): Float32Array {
  const out = new Float32Array(Math.round((RATE * ms) / 1000))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(i * 1.7)
  return out
}

const seconds = (samples: Float32Array): number => samples.length / RATE

/** Push in the 512-sample batches the audio worklet delivers. */
function feed(segmenter: Segmenter, audio: Float32Array): void {
  for (let at = 0; at < audio.length; at += 512) segmenter.push(audio.subarray(at, at + 512))
}

function run(audio: Float32Array, flush = true): Float32Array[] {
  const phrases: Float32Array[] = []
  const segmenter = new Segmenter((p) => phrases.push(p))
  feed(segmenter, audio)
  if (flush) segmenter.flush()
  return phrases
}

describe('Segmenter', () => {
  it('closes a phrase at a pause, while the user is still talking', () => {
    const phrases: Float32Array[] = []
    const segmenter = new Segmenter((p) => phrases.push(p))
    feed(segmenter, concat([hush(300), tone(1500), hush(800), tone(1000)]))
    // The first phrase is out before the recording ends — that is the whole point.
    expect(phrases).toHaveLength(1)
    segmenter.flush()
    expect(phrases).toHaveLength(2)
  })

  it('keeps a little silence either side so syllables are not clipped', () => {
    const [phrase] = run(concat([hush(1000), tone(1000), hush(1000)]))
    // 1 s of speech plus ~200 ms of padding on each side.
    expect(seconds(phrase)).toBeGreaterThan(1.3)
    expect(seconds(phrase)).toBeLessThan(1.5)
  })

  it('does not split on the short gaps between words', () => {
    const words = concat([tone(400), hush(200), tone(500), hush(250), tone(400)])
    const phrases = run(concat([words, hush(800)]), false)
    expect(phrases).toHaveLength(1)
    expect(seconds(phrases[0])).toBeGreaterThan(1.7)
  })

  it('caps a phrase that never pauses, cutting at its quietest moment', () => {
    // 20 s of speech with one soft dip around 14 s.
    const audio = concat([tone(14_000), tone(100, 0.02), tone(5_900)])
    const phrases = run(audio, false)
    expect(phrases.length).toBeGreaterThanOrEqual(1)
    expect(seconds(phrases[0])).toBeLessThanOrEqual(15)
    // The cut lands in the dip, not mid-"word".
    expect(seconds(phrases[0])).toBeGreaterThan(13.9)
    expect(seconds(phrases[0])).toBeLessThan(14.2)
  })

  it('drops pure silence instead of sending whisper something to hallucinate on', () => {
    expect(run(hush(5_000))).toEqual([])
    expect(run(new Float32Array(RATE * 3))).toEqual([])
  })

  it('never cuts a long silence into phrases', () => {
    const phrases: Float32Array[] = []
    const segmenter = new Segmenter((p) => phrases.push(p))
    feed(segmenter, hush(40_000))
    expect(phrases).toEqual([])
    // ...and holds no more of it than the lead-in pad.
    expect(segmenter.pendingSeconds).toBeLessThanOrEqual(0.25)
  })

  it('keeps a lone short word that ends the recording', () => {
    const phrases = run(concat([hush(500), tone(250), hush(100)]))
    expect(phrases).toHaveLength(1)
  })

  it('sends a lone short word on its own once a real pause follows', () => {
    const phrases = run(concat([tone(250), hush(2_000)]), false)
    expect(phrases).toHaveLength(1)
  })

  it('exposes the open phrase for previews, and nothing during silence', () => {
    const segmenter = new Segmenter(() => {})
    feed(segmenter, hush(1_000))
    expect(segmenter.current()).toBeNull()
    feed(segmenter, tone(800))
    const open = segmenter.current()
    expect(open).not.toBeNull()
    expect(seconds(open!)).toBeGreaterThan(0.8)
  })

  it('forgets everything on reset', () => {
    const phrases: Float32Array[] = []
    const segmenter = new Segmenter((p) => phrases.push(p))
    feed(segmenter, tone(2_000))
    segmenter.reset()
    segmenter.flush()
    expect(phrases).toEqual([])
    expect(segmenter.current()).toBeNull()
  })

  it('adapts to a noisy room rather than hearing speech everywhere', () => {
    // Steady fan noise at 0.02 RMS-ish, above the absolute threshold, with speech on top.
    const noisy = (audio: Float32Array): Float32Array => {
      const out = audio.slice()
      for (let i = 0; i < out.length; i++) out[i] += 0.025 * Math.sin(i * 0.9)
      return out
    }
    const phrases = run(noisy(concat([hush(2_000, 0), tone(1_200), hush(1_500, 0), tone(1_000)])))
    expect(phrases).toHaveLength(2)
  })

  it('copes with pushes that do not line up with its frames', () => {
    const phrases: Float32Array[] = []
    const segmenter = new Segmenter((p) => phrases.push(p))
    const audio = concat([tone(1_000), hush(900)])
    for (let at = 0; at < audio.length; at += 77) segmenter.push(audio.subarray(at, at + 77))
    expect(phrases).toHaveLength(1)
  })
})
