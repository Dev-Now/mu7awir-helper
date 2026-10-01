import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, rmSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav, WHISPER_SAMPLE_RATE } from '@shared/wav'
import { Dictation, type SpawnLike } from '../src/main/dictation'
import {
  cpuThreads,
  freePort,
  segmentTimeoutMs,
  serverArgs,
  WhisperServer,
  type Backend
} from '../src/main/whisperServer'

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/** One second of silence, which is all the fake server needs to see. */
const clip = (): Uint8Array => encodeWav(new Float32Array(WHISPER_SAMPLE_RATE))

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }

/**
 * Stands in for the whisper-server process. The real HTTP side is played by `fakeHttp`;
 * this only has to log like whisper.cpp and die on cue.
 */
function fakeProcess(behaviour: { stderr?: string; exitCode?: number | null } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: FakeChild[] = []
  const impl = ((command: string, args: string[]) => {
    calls.push({ command, args: [...args] })
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      setTimeout(() => child.emit('exit', null), 1)
    }
    children.push(child)
    // whisper.cpp logs while loading the model, before it starts listening.
    process.nextTick(() => {
      if (behaviour.stderr) child.stderr.emit('data', Buffer.from(behaviour.stderr))
      if (behaviour.exitCode !== undefined) child.emit('exit', behaviour.exitCode)
    })
    return child
  }) as unknown as SpawnLike
  return { impl, calls, children }
}

interface Received {
  url: string
  body: string
}

/** Plays whisper-server's HTTP API: /health, and /inference answering with `reply`. */
async function fakeHttp(
  options: { reply?: (n: number) => string; delayMs?: number; healthy?: boolean } = {}
) {
  const received: Received[] = []
  let inFlight = 0
  let maxInFlight = 0
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.url === '/health') {
        if (options.healthy === false) res.writeHead(503).end('{"status":"loading model"}')
        else res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
        return
      }
      const n = received.length
      received.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight--
        const text = options.reply?.(n) ?? `مقطع ${n}`
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }))
      }, options.delayMs ?? 5)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    received,
    get maxInFlight() {
      return maxInFlight
    },
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/** The multipart field `name`, as the server would parse it. */
function field(body: string, name: string): string | null {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body)
  return match ? match[1] : null
}

let dir: string
let http: Awaited<ReturnType<typeof fakeHttp>> | null = null

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mu7awir-server-'))
})

afterEach(async () => {
  await http?.close()
  http = null
  rmSync(dir, { recursive: true, force: true })
})

describe('serverArgs', () => {
  it('runs the CUDA build with flash attention and no carried-over context', () => {
    const args = serverArgs({ modelPath: 'm.bin', backend: 'cuda', port: 9000 })
    expect(args).toEqual(
      expect.arrayContaining(['-m', 'm.bin', '-l', 'ar', '-nc', '-fa', '--port', '9000'])
    )
    expect(args).toContain('127.0.0.1')
    expect(args).not.toContain('-t')
  })

  it('gives the CPU build a thread count instead', () => {
    const args = serverArgs({ modelPath: 'm.bin', backend: 'cpu', port: 9000, threads: 6 })
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '6'])
    expect(args).not.toContain('-fa')
  })
})

describe('cpuThreads', () => {
  it('uses about one thread per physical core, within sane bounds', () => {
    expect(cpuThreads(12)).toBe(6)
    expect(cpuThreads(2)).toBe(4)
    expect(cpuThreads(64)).toBe(8)
  })
})

describe('segmentTimeoutMs', () => {
  it('grows with the clip rather than capping long dictation at a flat limit', () => {
    expect(segmentTimeoutMs(0)).toBe(20_000)
    expect(segmentTimeoutMs(15)).toBeGreaterThan(segmentTimeoutMs(1))
    // A 15 s phrase at CPU speed (~real time) has ample headroom.
    expect(segmentTimeoutMs(15)).toBeGreaterThanOrEqual(60_000)
  })
})

describe('WhisperServer', () => {
  const make = (
    port: number,
    proc: ReturnType<typeof fakeProcess>,
    extra: Partial<ConstructorParameters<typeof WhisperServer>[0]> = {}
  ): WhisperServer =>
    new WhisperServer({
      binaryPath: 'whisper-server.exe',
      modelPath: 'm.bin',
      backend: 'cuda',
      port,
      spawnImpl: proc.impl,
      ...extra
    })

  it('waits for the model and reports the backend whisper.cpp settled on', async () => {
    http = await fakeHttp()
    const proc = fakeProcess({ stderr: 'whisper_backend_init_gpu: using CUDA0 backend\n' })
    const server = make(http.port, proc)
    await server.start()
    expect(server.running).toBe(true)
    expect(server.backend).toBe('cuda')
    expect(proc.calls[0].command).toBe('whisper-server.exe')
    server.stop()
  })

  it('reports cpu when the CUDA build could not find a usable GPU', async () => {
    http = await fakeHttp()
    const server = make(http.port, fakeProcess({ stderr: 'no GPU found\n' }))
    await server.start()
    expect(server.backend).toBe('cpu')
    server.stop()
  })

  it('fails fast, with the process’s own words, when it dies while loading', async () => {
    http = await fakeHttp({ healthy: false })
    const server = make(http.port, fakeProcess({ stderr: 'CUDA error: no kernel image', exitCode: 1 }))
    await expect(server.start()).rejects.toThrow(/exited 1.*no kernel image/s)
    expect(server.running).toBe(false)
  })

  it('gives up when the model never finishes loading', async () => {
    http = await fakeHttp({ healthy: false })
    const proc = fakeProcess()
    const server = make(http.port, proc, { readyTimeoutMs: 400 })
    await expect(server.start()).rejects.toThrow(/did not become ready/)
    expect(server.running).toBe(false)
  })

  it('posts the clip with the language-neutral fields and the continuity prompt', async () => {
    http = await fakeHttp({ reply: () => ' الصبر مفتاح الفرج ' })
    const server = make(http.port, fakeProcess())
    await server.start()

    await expect(server.infer(clip(), { prompt: 'ما سبق', timeoutMs: 5_000 })).resolves.toBe(
      ' الصبر مفتاح الفرج '
    )
    const [request] = http.received
    expect(request.url).toBe('/inference')
    expect(request.body).toContain('filename="clip.wav"')
    expect(field(request.body, 'response_format')).toBe('json')
    expect(field(request.body, 'temperature')).toBe('0')
    expect(field(request.body, 'prompt')).toBe('ما سبق')
    server.stop()
  })

  it('sends phrases one at a time, in the order they were spoken', async () => {
    http = await fakeHttp({ delayMs: 30, reply: (n) => `phrase ${n}` })
    const server = make(http.port, fakeProcess())
    await server.start()

    const results = await Promise.all(
      [0, 1, 2].map(() => server.infer(clip(), { timeoutMs: 5_000 }))
    )
    expect(results).toEqual(['phrase 0', 'phrase 1', 'phrase 2'])
    expect(http.maxInFlight).toBe(1)
    server.stop()
  })

  it('keeps going after a failed phrase', async () => {
    http = await fakeHttp({ delayMs: 5 })
    const server = make(http.port, fakeProcess())
    await server.start()

    await expect(server.infer(clip(), { timeoutMs: 1 })).rejects.toThrow(/timed out/)
    await expect(server.infer(clip(), { timeoutMs: 5_000 })).resolves.toMatch(/مقطع/)
    server.stop()
  })

  it('declines a preview while real phrases are in flight', async () => {
    http = await fakeHttp({ delayMs: 50 })
    const server = make(http.port, fakeProcess())
    await server.start()

    const committed = server.infer(clip(), { timeoutMs: 5_000 })
    await expect(server.preview(clip(), { timeoutMs: 5_000 })).resolves.toBeNull()
    await committed
    await expect(server.preview(clip(), { timeoutMs: 5_000 })).resolves.toMatch(/مقطع/)
    server.stop()
  })

  it('reports a crash, but not its own shutdown', async () => {
    http = await fakeHttp()
    const exits: string[] = []
    const proc = fakeProcess()
    const crashing = make(http.port, proc, { onExit: (detail) => exits.push(detail) })
    await crashing.start()
    proc.children[0].emit('exit', 3221225477)
    expect(crashing.running).toBe(false)
    expect(exits).toHaveLength(1)

    const quiet = make(http.port, fakeProcess(), { onExit: (detail) => exits.push(detail) })
    await quiet.start()
    quiet.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(exits).toHaveLength(1)
  })
})

describe('Dictation with a resident server', () => {
  /** Lay out an install: CPU build at the top, optionally the CUDA build under cuda/. */
  async function install(options: { cpuServer?: boolean; cuda?: boolean } = {}) {
    const assets = path.join(dir, 'whisper')
    const release = path.join(assets, 'Release')
    await fs.mkdir(release, { recursive: true })
    await fs.writeFile(path.join(release, exe('whisper-cli')), '')
    if (options.cpuServer !== false) await fs.writeFile(path.join(release, exe('whisper-server')), '')
    await fs.writeFile(path.join(assets, 'ggml-test.bin'), '')
    if (options.cuda) {
      const cuda = path.join(assets, 'cuda', 'Release')
      await fs.mkdir(cuda, { recursive: true })
      await fs.writeFile(path.join(cuda, exe('whisper-cli')), '')
      await fs.writeFile(path.join(cuda, exe('whisper-server')), '')
    }
  }

  /**
   * Builds servers against the fake HTTP side, recording which build was asked for. A
   * failing build dies while loading and never answers, like a CUDA build without a driver.
   */
  async function serverFactory(
    port: number,
    stderrFor: (backend: Backend) => string,
    failing: Backend[] = []
  ) {
    const deadPort = await freePort()
    const started: Array<{ backend: Backend; binaryPath: string }> = []
    const create = (options: {
      binaryPath: string
      modelPath: string
      backend: Backend
      onExit: (detail: string) => void
    }): WhisperServer => {
      started.push({ backend: options.backend, binaryPath: options.binaryPath })
      const fails = failing.includes(options.backend)
      return new WhisperServer({
        ...options,
        port: fails ? deadPort : port,
        readyTimeoutMs: 2_000,
        spawnImpl: fakeProcess({
          stderr: fails ? 'CUDA error: out of memory' : stderrFor(options.backend),
          exitCode: fails ? 1 : undefined
        }).impl
      })
    }
    return { create, started }
  }

  const cudaLog = (backend: Backend): string =>
    backend === 'cuda' ? 'whisper_backend_init_gpu: using CUDA0 backend\n' : ''

  it('transcribes through the server, never spawning whisper-cli', async () => {
    await install()
    http = await fakeHttp({ reply: () => '  الصبر\n مفتاح الفرج ' })
    const cli = fakeProcess()
    const factory = await serverFactory(http.port, cudaLog)
    const service = new Dictation(dir, () => {}, {
      spawnImpl: cli.impl,
      detectGpu: async () => null,
      createServer: factory.create
    })
    await service.refresh()

    await expect(service.transcribeSegment(clip(), 'ما سبق')).resolves.toBe('الصبر مفتاح الفرج')
    expect(cli.calls).toHaveLength(0)
    expect(factory.started).toEqual([
      { backend: 'cpu', binaryPath: path.join(dir, 'whisper', 'Release', exe('whisper-server')) }
    ])
    expect(service.status().backend).toBe('cpu')
    service.dispose()
  })

  it('prefers the CUDA build when this machine has an NVIDIA card', async () => {
    await install({ cuda: true })
    http = await fakeHttp()
    const factory = await serverFactory(http.port, cudaLog)
    const service = new Dictation(dir, () => {}, {
      detectGpu: async () => 'NVIDIA GeForce RTX 3060 Ti',
      createServer: factory.create
    })
    const status = await service.refresh()
    expect(status).toMatchObject({ gpu: 'NVIDIA GeForce RTX 3060 Ti', cudaInstalled: true })
    // The CPU build must not have been picked up from inside cuda/.
    expect(status.binaryPath).toBe(path.join(dir, 'whisper', 'Release', exe('whisper-cli')))

    await service.transcribeSegment(clip())
    expect(factory.started.map((s) => s.backend)).toEqual(['cuda'])
    expect(factory.started[0].binaryPath).toContain(path.join('cuda', 'Release'))
    expect(service.status().backend).toBe('cuda')
    service.dispose()
  })

  it('falls back to the CPU server when the CUDA one will not start', async () => {
    await install({ cuda: true })
    http = await fakeHttp()
    const factory = await serverFactory(http.port, cudaLog, ['cuda'])
    const service = new Dictation(dir, () => {}, {
      detectGpu: async () => 'NVIDIA GeForce RTX 3060 Ti',
      createServer: factory.create
    })
    await service.refresh()

    await expect(service.transcribeSegment(clip())).resolves.toMatch(/مقطع/)
    expect(factory.started.map((s) => s.backend)).toEqual(['cuda', 'cpu'])
    expect(service.status()).toMatchObject({ backend: 'cpu' })
    expect(service.status().backendDetail).toMatch(/out of memory/)

    // A failed backend is not retried on every phrase.
    await service.transcribeSegment(clip())
    expect(factory.started.map((s) => s.backend)).toEqual(['cuda', 'cpu'])
    service.dispose()
  })

  it('falls back to whisper-cli when no server can run', async () => {
    await install({ cpuServer: false })
    // whisper-cli: prints the transcript, then closes.
    const cli = { calls: [] as Array<{ command: string; args: string[] }> }
    const talkative = ((command: string, args: string[]) => {
      cli.calls.push({ command, args: [...args] })
      const child = new EventEmitter() as FakeChild
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from('من الأداة\n'))
        child.emit('close', 0)
      }, 2)
      return child
    }) as unknown as SpawnLike
    const service = new Dictation(dir, () => {}, {
      spawnImpl: talkative,
      detectGpu: async () => null,
      createServer: () => {
        throw new Error('no server binary, so this must not be called')
      }
    })
    await service.refresh()

    await expect(service.transcribeSegment(clip(), 'ما سبق')).resolves.toBe('من الأداة')
    const args = cli.calls[0].args
    expect(args).toContain('--prompt')
    expect(args).toContain('-t')
    service.dispose()
  })

  it('previews only on the GPU, where it costs next to nothing', async () => {
    await install({ cuda: true })
    http = await fakeHttp({ reply: () => 'معاينة' })

    const gpu = new Dictation(dir, () => {}, {
      detectGpu: async () => 'NVIDIA GeForce RTX 3060 Ti',
      createServer: (await serverFactory(http.port, cudaLog)).create
    })
    await gpu.refresh()
    expect(await gpu.preview(clip())).toBeNull() // nothing running yet: previews never start one
    await gpu.transcribeSegment(clip())
    expect(await gpu.preview(clip())).toBe('معاينة')

    // A phrase on its way in claims the server before any preview can, even before it has
    // reached the server itself.
    const committing = gpu.transcribeSegment(clip())
    expect(await gpu.preview(clip())).toBeNull()
    await committing
    expect(await gpu.preview(clip())).toBe('معاينة')
    gpu.dispose()

    const cpu = new Dictation(dir, () => {}, {
      detectGpu: async () => null,
      createServer: (await serverFactory(http.port, cudaLog)).create
    })
    await cpu.refresh()
    await cpu.transcribeSegment(clip())
    expect(await cpu.preview(clip())).toBeNull()
    cpu.dispose()
  })

  it('starts a fresh server after a crash', async () => {
    await install()
    http = await fakeHttp()
    const children: FakeChild[] = []
    let starts = 0
    const service = new Dictation(dir, () => {}, {
      detectGpu: async () => null,
      createServer: (options) => {
        starts++
        const proc = fakeProcess()
        const spawnImpl = ((command: string, args: string[]) => {
          const child = proc.impl(command, args, {}) as unknown as FakeChild
          children.push(child)
          return child
        }) as unknown as SpawnLike
        return new WhisperServer({ ...options, port: http!.port, spawnImpl })
      }
    })
    await service.refresh()
    await service.transcribeSegment(clip())
    children[0].emit('exit', 3221225477)
    expect(service.status().backend).toBeNull()

    await expect(service.transcribeSegment(clip())).resolves.toMatch(/مقطع/)
    expect(starts).toBe(2)
    service.dispose()
  })

  it('stops the server on dispose', async () => {
    await install()
    http = await fakeHttp()
    const children: FakeChild[] = []
    const service = new Dictation(dir, () => {}, {
      detectGpu: async () => null,
      createServer: (options) => {
        const proc = fakeProcess()
        const spawnImpl = ((command: string, args: string[]) => {
          const child = proc.impl(command, args, {}) as unknown as FakeChild
          children.push(child)
          return child
        }) as unknown as SpawnLike
        return new WhisperServer({ ...options, port: http!.port, spawnImpl })
      }
    })
    await service.refresh()
    await service.transcribeSegment(clip())
    let killed = false
    children[0].kill = () => {
      killed = true
    }
    service.dispose()
    expect(killed).toBe(true)
    expect(service.status().backend).toBeNull()
  })
})

describe('Dictation install with a GPU', () => {
  async function ready(): Promise<void> {
    const assets = path.join(dir, 'whisper')
    await fs.mkdir(assets, { recursive: true })
    await fs.writeFile(path.join(assets, exe('whisper-cli')), '')
    await fs.writeFile(path.join(assets, 'ggml-test.bin'), '')
  }

  it('fetches the CUDA build only when an NVIDIA card is present', async () => {
    await ready()
    http = await fakeHttp()
    const cudaBin = [{ url: `http://127.0.0.1:${http.port}/missing-cublas.zip` }]

    const withoutGpu = new Dictation(dir, () => {}, {
      detectGpu: async () => null,
      useServer: false,
      assets: { bin: [], model: [], cudaBin }
    })
    await withoutGpu.refresh()
    const plain = await withoutGpu.install()
    expect(plain.error).toBeNull()
    expect(http.received).toHaveLength(0)

    const withGpu = new Dictation(dir, () => {}, {
      detectGpu: async () => 'NVIDIA GeForce RTX 3060 Ti',
      useServer: false,
      assets: { bin: [], model: [], cudaBin }
    })
    await withGpu.refresh()
    await withGpu.install()
    expect(http.received.map((r) => r.url)).toEqual(['/missing-cublas.zip'])
  })

  it('keeps CPU dictation working when the CUDA download fails', async () => {
    await ready()
    const server = createServer((_req, res) => res.writeHead(404).end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const service = new Dictation(dir, () => {}, {
        detectGpu: async () => 'NVIDIA GeForce RTX 3060 Ti',
        useServer: false,
        assets: { bin: [], model: [], cudaBin: [{ url: `http://127.0.0.1:${port}/cublas.zip` }] }
      })
      await service.refresh()
      const status = await service.install()
      expect(status.ready).toBe(true)
      expect(status.cudaInstalled).toBe(false)
      expect(status.error).toMatch(/^تعذّر تنزيل تسريع GPU/)
      expect(status.errorDetail).toContain('404')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
