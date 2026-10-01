/**
 * A long-lived whisper-server child process.
 *
 * whisper-cli loads the 574 MB model on every call, which on its own costs seconds per
 * clip. The server loads it once and then answers each phrase over loopback HTTP — on a
 * CUDA build a 12 s phrase comes back in a few hundred milliseconds, which is what makes
 * dictation feel live (issue #5).
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import os from 'node:os'

export type Backend = 'cuda' | 'cpu'

/** Structural match for `child_process.spawn`, so tests can hand in a stub. */
type SpawnFn = typeof spawn

export interface WhisperServerOptions {
  binaryPath: string
  modelPath: string
  /** Which build `binaryPath` belongs to; decides the flags it is started with. */
  backend: Backend
  language?: string
  /** Fixed port, for tests. Production picks a free one. */
  port?: number
  readyTimeoutMs?: number
  spawnImpl?: SpawnFn
  fetchImpl?: typeof fetch
  /** Fired when the process goes away without `stop()` having been called. */
  onExit?: (detail: string) => void
}

export interface InferOptions {
  /** Recent text, so a phrase continues the last one in style and spelling. */
  prompt?: string
  timeoutMs: number
}

/**
 * Roughly the physical core count. Hyperthreads add little to whisper's matmuls, and the
 * default of 4 leaves most of a modern CPU idle — on a 6-core i5 going from 4 to 6 threads
 * cut a 35 s clip from 55 s to 46 s.
 */
export function cpuThreads(parallelism = os.availableParallelism()): number {
  return Math.min(8, Math.max(4, Math.floor(parallelism / 2)))
}

/**
 * How long one phrase may take. Generous enough for the CPU build, which runs at about
 * real time, yet bounded so a wedged process cannot hang dictation — and scaled with the
 * clip, unlike the flat 180 s that used to kill long recordings outright.
 */
export function segmentTimeoutMs(audioSeconds: number): number {
  return 20_000 + Math.ceil(audioSeconds * 4_000)
}

export function serverArgs(options: {
  modelPath: string
  backend: Backend
  port: number
  language?: string
  threads?: number
}): string[] {
  const { modelPath, backend, port, language = 'ar', threads = cpuThreads() } = options
  // -nc: every request stands alone. The caller supplies continuity through `prompt`,
  // which it controls, rather than the server carrying hidden state between phrases.
  const args = ['-m', modelPath, '-l', language, '-nt', '-nc', '--host', '127.0.0.1', '--port', String(port)]
  // Flash attention is a clear win on CUDA; on CPU what matters is the thread count.
  if (backend === 'cuda') args.push('-fa')
  else args.push('-t', String(threads))
  return args
}

/** Ask the OS for a port nobody is listening on. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class WhisperServer {
  private readonly options: WhisperServerOptions
  private readonly spawnImpl: SpawnFn
  private readonly fetchImpl: typeof fetch
  private child: ReturnType<SpawnFn> | null = null
  private port = 0
  private stderrTail = ''
  private stopping = false
  private exited = false

  /** Requests in flight or queued; previews only run when this is zero. */
  private busy = 0
  /** Committed phrases run strictly one after another, in the order they were sent. */
  private queue: Promise<unknown> = Promise.resolve()

  /** What the process reported it is running on, once it is up. */
  backend: Backend | null = null

  constructor(options: WhisperServerOptions) {
    this.options = options
    this.spawnImpl = options.spawnImpl ?? spawn
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  /** The last few hundred characters the process wrote to stderr, for error reports. */
  get detail(): string {
    return this.stderrTail.trim().slice(-300)
  }

  private get base(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** Spawn the process and resolve once the model is loaded and requests are accepted. */
  async start(): Promise<void> {
    const { binaryPath, modelPath, backend, language, readyTimeoutMs = 60_000 } = this.options
    this.port = this.options.port ?? (await freePort())

    const child = this.spawnImpl(
      binaryPath,
      serverArgs({ modelPath, backend, port: this.port, language }),
      { windowsHide: true }
    )
    this.child = child

    let exitDetail: string | null = null
    child.stderr?.on('data', (chunk: Buffer | string) => {
      // Model loading is chatty; only the tail is ever useful.
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000)
    })
    child.stdout?.on('data', () => {})
    const onGone = (reason: string): void => {
      if (this.exited) return
      this.exited = true
      exitDetail = `${reason}${this.detail ? `: ${this.detail}` : ''}`
      if (!this.stopping) this.options.onExit?.(exitDetail)
    }
    child.on('error', (err: Error) => onGone(err.message))
    child.on('exit', (code: number | null) => onGone(`whisper-server exited ${code}`))

    const deadline = Date.now() + readyTimeoutMs
    while (Date.now() < deadline) {
      if (exitDetail) throw new Error(exitDetail)
      try {
        const response = await this.fetchImpl(`${this.base}/health`, {
          signal: AbortSignal.timeout(1_000)
        })
        if (response.ok) {
          // whisper.cpp logs the backend it settled on while loading the model.
          this.backend = /using CUDA\d* backend/i.test(this.stderrTail) ? 'cuda' : 'cpu'
          return
        }
      } catch {
        /* not listening yet */
      }
      await sleep(150)
    }
    this.stop()
    throw new Error(`whisper-server did not become ready within ${readyTimeoutMs / 1000}s`)
  }

  /** Transcribe one committed phrase. Queued behind any phrase already in flight. */
  infer(wav: Uint8Array, options: InferOptions): Promise<string> {
    this.busy++
    const run = (): Promise<string> => this.post(wav, options)
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result.finally(() => {
      this.busy--
    })
  }

  /**
   * A best-effort look at the phrase still being spoken. It never waits: when anything
   * else is in flight it returns null at once, so previews can never delay real text.
   */
  async preview(wav: Uint8Array, options: InferOptions): Promise<string | null> {
    if (this.busy > 0 || !this.running) return null
    this.busy++
    try {
      return await this.post(wav, options)
    } finally {
      this.busy--
    }
  }

  private async post(wav: Uint8Array, { prompt, timeoutMs }: InferOptions): Promise<string> {
    if (!this.running) throw new Error('whisper-server is not running')

    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (prompt) form.append('prompt', prompt)

    let response: Response
    try {
      response = await this.fetchImpl(`${this.base}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new Error(`whisper timed out after ${Math.round(timeoutMs / 1000)}s`)
      }
      throw err
    }

    const body = (await response.json().catch(() => ({}))) as { text?: string; error?: string }
    if (!response.ok || typeof body.text !== 'string') {
      throw new Error(`whisper-server ${response.status}: ${body.error ?? 'no transcript'}`)
    }
    return body.text
  }

  stop(): void {
    this.stopping = true
    if (this.child && !this.exited) this.child.kill()
    this.exited = true
  }
}
