import { WHISPER_SAMPLE_RATE } from '@shared/wav'
import pcmWorkletUrl from './pcm-worklet.ts?worker&url'

/**
 * Streaming microphone capture.
 *
 * The audio context runs at whisper's 16 kHz, so Chromium resamples the microphone for us,
 * and an AudioWorklet hands over raw samples while the user is still speaking — nothing
 * waits for the key to be released (issue #5). No ffmpeg, no decode step.
 */
export class Recorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private tap: AudioWorkletNode | null = null
  private levelData: Uint8Array<ArrayBuffer> | null = null

  get recording(): boolean {
    return this.context !== null
  }

  /** Start capturing; `onSamples` receives 16 kHz mono PCM as it arrives. */
  async start(onSamples: (samples: Float32Array) => void): Promise<void> {
    if (this.recording) return

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    const context = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE })
    try {
      await context.audioWorklet.addModule(pcmWorkletUrl)
      const source = context.createMediaStreamSource(stream)

      // A live analyser drives the level meter in the HUD.
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)

      const tap = new AudioWorkletNode(context, 'pcm-tap', { channelCount: 1 })
      tap.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(event.data)
      source.connect(tap)
      // A node only renders while it leads somewhere; a muted gain keeps the tap running
      // without echoing the microphone back out of the speakers.
      const mute = context.createGain()
      mute.gain.value = 0
      tap.connect(mute).connect(context.destination)

      this.stream = stream
      this.context = context
      this.analyser = analyser
      this.tap = tap
      // Explicitly ArrayBuffer-backed: getByteTimeDomainData rejects SharedArrayBuffer views.
      this.levelData = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop())
      void context.close().catch(() => {})
      throw err
    }
  }

  /** Current input level, 0..1, for the meter. */
  level(): number {
    if (!this.analyser || !this.levelData) return 0
    this.analyser.getByteTimeDomainData(this.levelData)
    let peak = 0
    for (const sample of this.levelData) peak = Math.max(peak, Math.abs(sample - 128) / 128)
    return peak
  }

  /** Stop capturing. Samples already delivered stay with the caller. */
  stop(): void {
    if (this.tap) this.tap.port.onmessage = null
    this.tap?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close().catch(() => {})
    this.stream = null
    this.context = null
    this.analyser = null
    this.tap = null
    this.levelData = null
  }
}
