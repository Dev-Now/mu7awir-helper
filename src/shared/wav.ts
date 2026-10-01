/**
 * Minimal 16-bit PCM WAV encoder.
 *
 * whisper.cpp wants 16 kHz mono PCM. Encoding it here — about forty lines — avoids
 * bundling ffmpeg, which would add ~80 MB and a licensing question for no benefit.
 */

export const WHISPER_SAMPLE_RATE = 16_000

const HEADER_BYTES = 44

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** Clamp a float sample to the signed 16-bit range. */
function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

export function encodeWav(samples: Float32Array, sampleRate = WHISPER_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // file size minus the first 8 bytes
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate: rate * blockAlign
  view.setUint16(32, 2, true) // block align: channels * bytesPerSample
  view.setUint16(34, 16, true) // bits per sample

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(HEADER_BYTES + i * 2, toPcm16(samples[i]), true)
  }

  return new Uint8Array(buffer)
}

/** Seconds of audio in an encoded clip, used to reject empty recordings. */
export function wavDurationSeconds(bytes: Uint8Array): number {
  if (bytes.length <= HEADER_BYTES) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleRate = view.getUint32(24, true)
  const dataBytes = view.getUint32(40, true)
  return sampleRate > 0 ? dataBytes / 2 / sampleRate : 0
}
