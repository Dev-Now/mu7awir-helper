import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav, wavDurationSeconds, WHISPER_SAMPLE_RATE } from '@shared/wav'
import {
  Dictation,
  downloadTo,
  findWhisperBinary,
  parseTranscript,
  runWhisper,
  type SpawnLike
} from '../src/main/dictation'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mu7awir-dictation-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A stand-in for whisper-cli. Node refuses to spawn .cmd/.bat without a shell, and a
 * real .exe cannot be authored here, so the spawn call itself is stubbed. This also
 * lets the tests assert the exact arguments whisper is invoked with.
 */
function fakeSpawn(behaviour: { stdout?: string; stderr?: string; code?: number; hang?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []

  const impl = ((command: string, args: string[]) => {
    calls.push({ command, args: [...args] })
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}

    if (!behaviour.hang) {
      setTimeout(() => {
        if (behaviour.stdout) child.stdout.emit('data', Buffer.from(behaviour.stdout))
        if (behaviour.stderr) child.stderr.emit('data', Buffer.from(behaviour.stderr))
        child.emit('close', behaviour.code ?? 0)
      }, 5)
    }
    return child
  }) as unknown as SpawnLike

  return { impl, calls }
}

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header', () => {
    const wav = encodeWav(new Float32Array(160), WHISPER_SAMPLE_RATE)
    const view = new DataView(wav.buffer)
    const ascii = (at: number): string =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)))

    expect(ascii(0)).toBe('RIFF')
    expect(ascii(8)).toBe('WAVE')
    expect(ascii(12)).toBe('fmt ')
    expect(ascii(36)).toBe('data')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(WHISPER_SAMPLE_RATE)
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
  })

  it('sizes the buffer as header plus two bytes per sample', () => {
    expect(encodeWav(new Float32Array(1000)).length).toBe(44 + 2000)
  })

  it('declares matching chunk sizes', () => {
    const wav = encodeWav(new Float32Array(500))
    const view = new DataView(wav.buffer)
    expect(view.getUint32(4, true)).toBe(wav.length - 8)
    expect(view.getUint32(40, true)).toBe(1000)
  })

  it('maps the full float range without wrapping', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5, -0.5]))
    const view = new DataView(wav.buffer)
    const at = (i: number): number => view.getInt16(44 + i * 2, true)
    expect(at(0)).toBe(0)
    expect(at(1)).toBe(32767)
    expect(at(2)).toBe(-32768)
    expect(at(3)).toBeGreaterThan(16000)
    expect(at(4)).toBeLessThan(-16000)
  })

  it('clamps samples beyond the valid range instead of wrapping', () => {
    const view = new DataView(encodeWav(new Float32Array([4, -4])).buffer)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })

  it('reports the clip duration', () => {
    expect(wavDurationSeconds(encodeWav(new Float32Array(WHISPER_SAMPLE_RATE)))).toBe(1)
    expect(wavDurationSeconds(new Uint8Array(10))).toBe(0)
  })
})

describe('parseTranscript', () => {
  it('joins the spoken lines', () => {
    expect(parseTranscript(' الصبر مفتاح \n الفرج \n')).toBe('الصبر مفتاح الفرج')
  })

  it('drops whisper markers and blank lines', () => {
    expect(parseTranscript('[BLANK_AUDIO]\n\nالصبر\n[ Silence ]\n')).toBe('الصبر')
  })

  it('collapses runs of whitespace', () => {
    expect(parseTranscript('الصبر    مفتاح')).toBe('الصبر مفتاح')
  })

  it('returns an empty string when nothing was heard', () => {
    expect(parseTranscript('\n[BLANK_AUDIO]\n')).toBe('')
  })
})

describe('runWhisper', () => {
  it('invokes whisper with the model, clip and language', async () => {
    const { impl, calls } = fakeSpawn({ stdout: 'الصبر\n' })
    await runWhisper(
      { binaryPath: 'whisper-cli.exe', modelPath: 'm.bin', wavPath: 'c.wav', language: 'ar' },
      impl
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('whisper-cli.exe')
    expect(calls[0].args).toEqual(['-m', 'm.bin', '-f', 'c.wav', '-l', 'ar', '-nt', '-np'])
  })

  it('returns the transcript when the binary succeeds', async () => {
    const { impl } = fakeSpawn({ stdout: 'الصَّبْرُ مفتاح الفرج\n' })
    await expect(
      runWhisper({ binaryPath: 'w', modelPath: 'm', wavPath: 'c' }, impl)
    ).resolves.toBe('الصَّبْرُ مفتاح الفرج')
  })

  it('surfaces a non-zero exit with the binary’s own message', async () => {
    const { impl } = fakeSpawn({ stderr: 'model not found', code: 3 })
    await expect(
      runWhisper({ binaryPath: 'w', modelPath: 'm', wavPath: 'c' }, impl)
    ).rejects.toThrow(/exited 3.*model not found/s)
  })

  it('rejects when the binary does not exist', async () => {
    // Real spawn here, to prove a missing executable surfaces rather than hanging.
    await expect(
      runWhisper({ binaryPath: path.join(dir, 'nope.exe'), modelPath: 'm', wavPath: 'w' })
    ).rejects.toThrow()
  })

  it('gives up rather than hanging forever', async () => {
    const { impl } = fakeSpawn({ hang: true })
    await expect(
      runWhisper({ binaryPath: 'w', modelPath: 'm', wavPath: 'c', timeoutMs: 200 }, impl)
    ).rejects.toThrow(/timed out/)
  })
})

describe('findWhisperBinary', () => {
  it('finds the executable nested inside the extracted archive', async () => {
    const nested = path.join(dir, 'Release', 'bin')
    await fs.mkdir(nested, { recursive: true })
    const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    await fs.writeFile(path.join(nested, name), '')
    expect(await findWhisperBinary(dir)).toBe(path.join(nested, name))
  })

  it('returns null when nothing is installed', async () => {
    expect(await findWhisperBinary(dir)).toBeNull()
    expect(await findWhisperBinary(path.join(dir, 'missing'))).toBeNull()
  })
})

describe('downloadTo', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === '/missing') {
        res.writeHead(404).end()
        return
      }
      const body = Buffer.from('x'.repeat(5000))
      res.writeHead(200, { 'content-length': String(body.length) })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('streams to disk and reports progress', async () => {
    const target = path.join(dir, 'nested', 'asset.bin')
    const seen: Array<[number, number]> = []
    await downloadTo(`${base}/asset`, target, (received, total) => seen.push([received, total]))

    expect((await fs.stat(target)).size).toBe(5000)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1][0]).toBe(5000)
    expect(seen[seen.length - 1][1]).toBe(5000)
  })

  it('leaves no partial file behind on success', async () => {
    await downloadTo(`${base}/asset`, path.join(dir, 'asset.bin'))
    expect(await fs.readdir(dir)).not.toContain('asset.bin.part')
  })

  it('throws on an error response without creating the target', async () => {
    const target = path.join(dir, 'asset.bin')
    await expect(downloadTo(`${base}/missing`, target)).rejects.toThrow(/404/)
    await expect(fs.access(target)).rejects.toThrow()
  })
})

describe('Dictation', () => {
  it('reports itself unready with nothing installed', async () => {
    const status = await new Dictation(dir, () => {}).refresh()
    expect(status).toMatchObject({ ready: false, binaryPath: null, modelPath: null, error: null })
  })

  it('becomes ready once a binary and model are present', async () => {
    const service = new Dictation(dir, () => {})
    const assets = service.assetDir
    await fs.mkdir(assets, { recursive: true })
    const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
    await fs.writeFile(path.join(assets, name), '')
    await fs.writeFile(path.join(assets, 'ggml-large-v3-turbo-q5_0.bin'), '')

    const status = await service.refresh()
    expect(status.ready).toBe(true)
    expect(status.modelPath).toContain('ggml-')
  })

  it('accepts paths the user points it at', async () => {
    const custom = path.join(dir, 'elsewhere')
    await fs.mkdir(custom, { recursive: true })
    const binary = path.join(custom, 'my-whisper.exe')
    const model = path.join(custom, 'my-model.bin')
    await fs.writeFile(binary, '')
    await fs.writeFile(model, '')

    const status = await new Dictation(dir, () => {}).refresh({
      binaryPath: binary,
      modelPath: model
    })
    expect(status).toMatchObject({ ready: true, binaryPath: binary, modelPath: model })
  })

  it('refuses to transcribe before it is set up', async () => {
    await expect(new Dictation(dir, () => {}).transcribe(new Uint8Array(44))).rejects.toThrow()
  })

  it('transcribes a clip and cleans up the temp file', async () => {
    const { impl } = fakeSpawn({ stdout: 'الصبر مفتاح الفرج' })
    const service = new Dictation(dir, () => {}, impl)
    await fs.mkdir(service.assetDir, { recursive: true })
    const binary = path.join(service.assetDir, 'whisper-cli.exe')
    const model = path.join(service.assetDir, 'ggml-test.bin')
    await fs.writeFile(binary, '')
    await fs.writeFile(model, '')
    await service.refresh({ binaryPath: binary, modelPath: model })

    const wav = encodeWav(new Float32Array(WHISPER_SAMPLE_RATE))
    await expect(service.transcribe(wav)).resolves.toBe('الصبر مفتاح الفرج')
    expect((await fs.readdir(service.assetDir)).filter((f) => f.endsWith('.wav'))).toEqual([])
  })

  it('cleans up the temp file even when whisper fails', async () => {
    const { impl } = fakeSpawn({ stderr: 'boom', code: 1 })
    const service = new Dictation(dir, () => {}, impl)
    await fs.mkdir(service.assetDir, { recursive: true })
    const binary = path.join(service.assetDir, 'whisper-cli.exe')
    const model = path.join(service.assetDir, 'ggml-test.bin')
    await fs.writeFile(binary, '')
    await fs.writeFile(model, '')
    await service.refresh({ binaryPath: binary, modelPath: model })

    await expect(service.transcribe(encodeWav(new Float32Array(160)))).rejects.toThrow()
    expect((await fs.readdir(service.assetDir)).filter((f) => f.endsWith('.wav'))).toEqual([])
  })

  it('publishes status changes to its listener', async () => {
    const seen: boolean[] = []
    const service = new Dictation(dir, (s) => seen.push(s.ready))
    await service.refresh()
    expect(seen).toEqual([false])
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
