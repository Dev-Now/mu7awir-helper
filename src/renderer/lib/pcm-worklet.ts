/**
 * Audio-thread tap: forwards raw microphone samples to the page in ~32 ms batches.
 *
 * Runs in the AudioWorkletGlobalScope, whose globals the DOM typings do not describe, so
 * the few it uses are declared here.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

/** 512 samples at 16 kHz: frequent enough to feel live, few enough to keep IPC quiet. */
const BATCH = 512

class PcmTap extends AudioWorkletProcessor {
  private batch = new Float32Array(BATCH)
  private filled = 0

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (channel) {
      for (const sample of channel) {
        this.batch[this.filled++] = sample
        if (this.filled === BATCH) {
          // Transfer rather than copy; a fresh batch takes its place.
          this.port.postMessage(this.batch, [this.batch.buffer])
          this.batch = new Float32Array(BATCH)
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)

export {}
