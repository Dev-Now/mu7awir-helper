import { encodeWav, WHISPER_SAMPLE_RATE } from '@shared/wav'

/**
 * Push-to-talk microphone capture.
 *
 * Records with MediaRecorder, then decodes and resamples to the 16 kHz mono PCM that
 * whisper.cpp expects. Doing the conversion here keeps ffmpeg out of the build.
 */
export class Recorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelData: Uint8Array<ArrayBuffer> | null = null

  get recording(): boolean {
    return this.recorder?.state === 'recording'
  }

  async start(): Promise<void> {
    if (this.recording) return

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    // A live analyser drives the level meter in the HUD.
    this.context = new AudioContext()
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 512
    // Explicitly ArrayBuffer-backed: getByteTimeDomainData rejects SharedArrayBuffer views.
    this.levelData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))
    this.context.createMediaStreamSource(this.stream).connect(this.analyser)

    this.chunks = []
    this.recorder = new MediaRecorder(this.stream)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.start()
  }

  /** Current input level, 0..1, for the meter. */
  level(): number {
    if (!this.analyser || !this.levelData) return 0
    this.analyser.getByteTimeDomainData(this.levelData)
    let peak = 0
    for (const sample of this.levelData) peak = Math.max(peak, Math.abs(sample - 128) / 128)
    return peak
  }

  /** Stop recording and return the clip as 16 kHz mono WAV bytes. */
  async stop(): Promise<Uint8Array | null> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      this.teardown()
      return null
    }

    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    recorder.stop()
    await finished

    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' })
    this.teardown()
    if (blob.size === 0) return null

    return encodeWav(await toMonoPcm(await blob.arrayBuffer()), WHISPER_SAMPLE_RATE)
  }

  cancel(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.teardown()
  }

  private teardown(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close().catch(() => {})
    this.stream = null
    this.recorder = null
    this.context = null
    this.analyser = null
    this.levelData = null
  }
}

/** Decode compressed audio and resample it to 16 kHz mono. */
async function toMonoPcm(encoded: ArrayBuffer): Promise<Float32Array> {
  const decodeContext = new AudioContext()
  try {
    const decoded = await decodeContext.decodeAudioData(encoded)
    const frames = Math.ceil((decoded.duration * WHISPER_SAMPLE_RATE) / 1)
    const offline = new OfflineAudioContext(1, Math.max(1, frames), WHISPER_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return (await offline.startRendering()).getChannelData(0)
  } finally {
    void decodeContext.close().catch(() => {})
  }
}
