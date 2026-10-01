/**
 * Arabic dictation via a local whisper.cpp binary.
 *
 * Windows voice typing (Win+H) has no Arabic, so the app supplies its own. whisper.cpp
 * runs entirely offline: no API key, no cost, and the audio never leaves the machine.
 * The binary and model are fetched on first use rather than shipped, which keeps ~600 MB
 * out of the installer.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { wavDurationSeconds } from '@shared/wav'
import { cpuThreads, segmentTimeoutMs, WhisperServer, type Backend } from './whisperServer'

/** A pinned download source. The checksum guards against a truncated or swapped asset. */
export interface Candidate {
  url: string
  /** Pinned SHA-256 of the exact bytes at that URL. Omitted when the asset is not pinned. */
  sha256?: string
}

/**
 * whisper.cpp is inconsistent about attaching Windows binaries to its release tags — v1.7.4
 * (pinned here originally, hence issue #4), v1.7.5 and even v1.9.4 ship none at all. So the
 * binary is not a single URL but a short list of tags known to carry whisper-bin-x64.zip,
 * tried in order: the first that downloads *and* matches its checksum wins.
 */
export const WHISPER_BIN_CANDIDATES: readonly Candidate[] = [
  {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip',
    sha256: '0d2eca299c248f965bd0341bcb219db4b433c7f0c0ce2200d4df85765e8156a9'
  },
  {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip',
    sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
  }
]

/**
 * The CUDA build, for machines with an NVIDIA card (issue #5). On CPU large-v3-turbo runs
 * slower than real time — 46 s for a 35 s clip on a 6-core i5 — while an RTX 3060 Ti does a
 * 12 s phrase in ~0.4 s. The archive bundles the CUDA 12 runtime, so only a driver is needed.
 * It is 443 MB, which is why it is fetched only when a GPU is actually present.
 */
export const WHISPER_CUDA_BIN_CANDIDATES: readonly Candidate[] = [
  {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-cublas-12.4.0-bin-x64.zip',
    sha256: '3fc4d3ebd9a678313de50c04d9e59c43117ae190f0cb7bff602d4aeefc4efe3d'
  }
]

/**
 * large-v3-turbo quantised: ~574 MB and several times faster than large-v3, at a few
 * points of WER. The model is swappable for exactly this reason. HuggingFace serves it from
 * a branch rather than a tag, so there is nothing stable to pin a checksum to.
 */
export const WHISPER_MODEL_CANDIDATES: readonly Candidate[] = [
  { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' }
]

/** Where `install()` fetches from. Overridable so tests can point at a local server. */
export interface AssetSources {
  bin: readonly Candidate[]
  cudaBin: readonly Candidate[]
  model: readonly Candidate[]
}

const DEFAULT_ASSETS: AssetSources = {
  bin: WHISPER_BIN_CANDIDATES,
  cudaBin: WHISPER_CUDA_BIN_CANDIDATES,
  model: WHISPER_MODEL_CANDIDATES
}

/** The CUDA build lives in its own folder so the CPU build stays intact as a fallback. */
const CUDA_DIR = 'cuda'

export interface DictationPaths {
  binaryPath: string | null
  modelPath: string | null
}

export interface DictationStatus extends DictationPaths {
  ready: boolean
  /** Non-null while an asset is being fetched. */
  progress: { what: string; received: number; total: number } | null
  /** A readable Arabic sentence, for the settings panel. */
  error: string | null
  /** The underlying failure, kept apart so the UI can render it left-to-right. */
  errorDetail: string | null
  /** The NVIDIA card found on this machine, if any. */
  gpu: string | null
  /** Whether the CUDA build has been downloaded. */
  cudaInstalled: boolean
  /** What the running whisper-server is using; null while none is running. */
  backend: Backend | null
  /** Why the preferred backend could not start, when it fell back. */
  backendDetail: string | null
}

export type ProgressHandler = (received: number, total: number) => void

/**
 * Stream a URL to disk, reporting progress. Downloads to a temp name and renames, so a
 * failure never leaves a half-written file under the real name. With `sha256`, the bytes
 * are verified before that rename.
 */
export async function downloadTo(
  url: string,
  destination: string,
  onProgress?: ProgressHandler,
  sha256?: string
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0

  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temp = `${destination}.part`

  const expected = sha256?.toLowerCase()
  // Hashing in the progress handler is a single pass over bytes we already touch; piping
  // through a transform, or reading 574 MB back off disk, would buy nothing.
  const hash = expected ? createHash('sha256') : null

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    hash?.update(chunk)
    onProgress?.(received, total)
  })

  try {
    await pipeline(source, createWriteStream(temp))
    if (expected && hash) {
      const digest = hash.digest('hex')
      if (digest !== expected) {
        throw new Error(`checksum mismatch for ${url}: expected ${expected}, got ${digest}`)
      }
    }
    // Only verified bytes may reach the final name: `install()` unzips whatever sits there,
    // and `fetchAsset` skips the download entirely when the file already exists.
    await fs.rename(temp, destination)
  } catch (err) {
    await fs.rm(temp, { force: true })
    throw err
  }
}

export interface MirrorOptions {
  onProgress?: ProgressHandler
  /** Fired before each attempt, so a caller can reset its progress meter. */
  onAttempt?: (index: number) => void
}

/**
 * Try each pinned source in turn and return the one that worked. A checksum mismatch is
 * treated exactly like a 404 — that mirror is not the file we pinned, so the next candidate
 * gets a go. Rejects with every failure when none of them works.
 */
export async function downloadFirstAvailable(
  candidates: readonly Candidate[],
  destination: string,
  options: MirrorOptions = {}
): Promise<string> {
  const failures: string[] = []
  for (const [index, candidate] of candidates.entries()) {
    options.onAttempt?.(index)
    try {
      await downloadTo(candidate.url, destination, options.onProgress, candidate.sha256)
      return candidate.url
    } catch (err) {
      failures.push((err as Error).message)
    }
  }
  throw new Error(
    failures.join('; ') || `no download sources configured for ${path.basename(destination)}`
  )
}

const exists = async (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false
  )

/**
 * whisper-cli is the real binary. `main` is a deprecation stub in current builds — it prints
 * a notice to stdout and exits 1 — and it sorts *before* whisper-cli in the extracted Release
 * folder, so the walk has to rank what it finds rather than take the first hit. `main` stays
 * on as a fallback for the older builds a user may point us at from settings.
 */
const BINARY_NAMES = ['whisper-cli', 'main']

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : ''

/**
 * Locate whisper-cli.exe (or whisper-cli) anywhere under a directory. Folders named in
 * `skip` are not entered — the CPU search must not wander into the CUDA build.
 */
export async function findWhisperBinary(
  root: string,
  skip: readonly string[] = []
): Promise<string | null> {
  const wanted = BINARY_NAMES.map((name) => `${name}${EXE_SUFFIX}`)
  const skipped = new Set(skip.map((name) => name.toLowerCase()))
  const found = new Map<string, string>()
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name.toLowerCase())) queue.push(full)
        continue
      }
      const name = entry.name.toLowerCase()
      if (name === wanted[0]) return full // nothing can outrank whisper-cli
      if (wanted.includes(name) && !found.has(name)) found.set(name, full)
    }
  }
  for (const name of wanted) {
    const hit = found.get(name)
    if (hit) return hit
  }
  return null
}

/** whisper-server ships beside whisper-cli in every release archive. */
export async function findServerBinary(dir: string): Promise<string | null> {
  const candidate = path.join(dir, `whisper-server${EXE_SUFFIX}`)
  return (await exists(candidate)) ? candidate : null
}

/**
 * The name of the first NVIDIA GPU, or null. nvidia-smi is installed with every NVIDIA
 * driver, so its absence is as good as "no usable card".
 */
export function detectNvidiaGpu(spawnImpl: SpawnLike = spawn): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    let child: ReturnType<SpawnLike>
    try {
      child = spawnImpl('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
        windowsHide: true
      })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, 5_000)

    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.on('error', () => done(null))
    child.on('close', (code) => {
      const name = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
      // Guard against an error message masquerading as a card name.
      done(code === 0 && /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name) ? name : null)
    })
  })
}

/**
 * Subtitle credits whisper learned from its Arabic training data and recites over noise.
 * Short phrases make a noise-only clip likelier, so a transcript that is nothing but one of
 * these is dropped. Matched loosely: the model varies the spelling and punctuation.
 */
const HALLUCINATIONS = [/^ترجمة نان?سي قن?قر$/, /^اشتركوا في القناة$/]

/**
 * Parse whisper-cli's stdout. With `-nt -np` it prints the transcription and nothing
 * else, but it still emits the odd blank line and bracketed marker such as [BLANK_AUDIO].
 */
export function parseTranscript(stdout: string): string {
  const text = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]*\]$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  const bare = text.replace(/[\p{P}\p{S}]/gu, '').trim()
  return HALLUCINATIONS.some((pattern) => pattern.test(bare)) ? '' : text
}

/** Injection seam: tests supply a stub so the arguments can be asserted directly. */
export type SpawnLike = typeof spawn

export interface RunOptions {
  binaryPath: string
  modelPath: string
  wavPath: string
  language?: string
  /** Recent text, to keep a phrase consistent with the one before it. */
  prompt?: string
  threads?: number
  /** Callers size this to the clip with `segmentTimeoutMs`; the default is a backstop. */
  timeoutMs?: number
}

/** Invoke whisper-cli on a WAV file and return what it heard. */
export function runWhisper(options: RunOptions, spawnImpl: SpawnLike = spawn): Promise<string> {
  const { binaryPath, modelPath, wavPath, language = 'ar', prompt, threads } = options
  const timeoutMs = options.timeoutMs ?? 180_000
  const args = ['-m', modelPath, '-f', wavPath, '-l', language, '-nt', '-np']
  if (threads) args.push('-t', String(threads))
  if (prompt) args.push('--prompt', prompt)

  return new Promise((resolve, reject) => {
    const child = spawnImpl(binaryPath, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`whisper timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(parseTranscript(stdout))
      else reject(new Error(`whisper exited ${code}: ${stderr.trim().slice(-300) || 'no output'}`))
    })
  })
}

/** A single quote is escaped by doubling it inside a PowerShell single-quoted string. */
const psQuote = (value: string): string => value.replace(/'/g, "''")

export interface DictationOptions {
  /** Injection seam: tests and the smoke run supply a stand-in for whisper-cli. */
  spawnImpl?: SpawnLike
  assets?: AssetSources
  /** Overridable so tests do not depend on the machine's graphics card. */
  detectGpu?: () => Promise<string | null>
  /** Keep the model resident in whisper-server. Off for stand-in runs, which have no server. */
  useServer?: boolean
  /** Builds the server process; overridable for tests. */
  createServer?: (options: {
    binaryPath: string
    modelPath: string
    backend: Backend
    onExit: (detail: string) => void
  }) => WhisperServer
}

/** A resident model holds ~1 GB of RAM or VRAM; give it back after a quiet spell. */
const SERVER_IDLE_MS = 15 * 60_000

export class Dictation {
  private readonly dir: string
  private readonly onStatus: (status: DictationStatus) => void
  private paths: DictationPaths = { binaryPath: null, modelPath: null }
  private cudaBinaryPath: string | null = null
  private progress: DictationStatus['progress'] = null
  private error: string | null = null
  private errorDetail: string | null = null
  private busy = false

  private readonly spawnImpl: SpawnLike
  private readonly assets: AssetSources
  private readonly useServer: boolean
  private readonly createServer: NonNullable<DictationOptions['createServer']>
  private readonly gpuProbe: () => Promise<string | null>
  private gpu: Promise<string | null> | null = null
  private gpuName: string | null = null

  private server: WhisperServer | null = null
  private serverStarting: Promise<WhisperServer | null> | null = null
  /** Backends that failed to start this session; they are not retried until restart. */
  private readonly failedBackends = new Set<Backend>()
  private backendDetail: string | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** Phrases between arriving and being answered; previews stand aside for them. */
  private committing = 0

  constructor(
    userDataDir: string,
    onStatus: (status: DictationStatus) => void,
    options: DictationOptions = {}
  ) {
    this.dir = path.join(userDataDir, 'whisper')
    this.onStatus = onStatus
    this.spawnImpl = options.spawnImpl ?? spawn
    this.assets = options.assets ?? DEFAULT_ASSETS
    this.useServer = options.useServer ?? true
    this.gpuProbe = options.detectGpu ?? (() => detectNvidiaGpu())
    this.createServer =
      options.createServer ?? ((serverOptions) => new WhisperServer(serverOptions))
  }

  get assetDir(): string {
    return this.dir
  }

  status(): DictationStatus {
    return {
      ...this.paths,
      ready: Boolean(this.paths.binaryPath && this.paths.modelPath),
      progress: this.progress,
      error: this.error,
      errorDetail: this.errorDetail,
      gpu: this.gpuName,
      cudaInstalled: Boolean(this.cudaBinaryPath),
      backend: this.server?.running ? this.server.backend : null,
      backendDetail: this.backendDetail
    }
  }

  private publish(): void {
    this.onStatus(this.status())
  }

  /** Probed once per run: nvidia-smi takes a moment and the card does not change. */
  private detectGpu(): Promise<string | null> {
    this.gpu ??= this.gpuProbe().then(
      (name) => (this.gpuName = name),
      () => null
    )
    return this.gpu
  }

  /** Look for assets already on disk, including ones the user pointed us at. */
  async refresh(override?: Partial<DictationPaths>): Promise<DictationStatus> {
    const binary = override?.binaryPath ?? this.paths.binaryPath
    const model = override?.modelPath ?? this.paths.modelPath

    await this.detectGpu()
    this.paths = {
      binaryPath:
        binary && (await exists(binary)) ? binary : await findWhisperBinary(this.dir, [CUDA_DIR]),
      modelPath: model && (await exists(model)) ? model : await this.findModel()
    }
    this.cudaBinaryPath = await findWhisperBinary(path.join(this.dir, CUDA_DIR))
    this.publish()
    return this.status()
  }

  private async findModel(): Promise<string | null> {
    try {
      const entries = await fs.readdir(this.dir)
      const model = entries.find((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      return model ? path.join(this.dir, model) : null
    } catch {
      return null
    }
  }

  /**
   * Fetch whatever is missing. Safe to call repeatedly; already-present assets are kept.
   * The CPU build and model come first, so dictation works even if the larger CUDA download
   * then fails.
   */
  async install(): Promise<DictationStatus> {
    if (this.busy) return this.status()
    this.busy = true
    this.error = null
    this.errorDetail = null

    let stage: 'base' | 'cuda' = 'base'
    try {
      await fs.mkdir(this.dir, { recursive: true })

      if (!this.paths.binaryPath) {
        const zip = path.join(this.dir, 'whisper-bin-x64.zip')
        await this.fetchAsset('برنامج whisper', this.assets.bin, zip)
        await this.unzip(zip, this.dir)
        await fs.rm(zip, { force: true })
      }

      if (!this.paths.modelPath) {
        const model = path.join(this.dir, 'ggml-large-v3-turbo-q5_0.bin')
        await this.fetchAsset('النموذج الصوتي', this.assets.model, model)
      }

      await this.refresh()

      if ((await this.detectGpu()) && !this.cudaBinaryPath) {
        stage = 'cuda'
        const zip = path.join(this.dir, 'whisper-cublas-bin-x64.zip')
        await this.fetchAsset('تسريع GPU (CUDA)', this.assets.cudaBin, zip)
        await this.unzip(zip, path.join(this.dir, CUDA_DIR))
        await fs.rm(zip, { force: true })
        await this.refresh()
        // A CPU server may already be up from earlier dictation; let the next phrase start
        // the faster one.
        this.failedBackends.delete('cuda')
        if (this.server?.backend === 'cpu') this.stopServer()
      }
    } catch (err) {
      // The panel is Arabic and RTL; the raw fetch error belongs beside the sentence, not
      // in place of it.
      this.error =
        stage === 'cuda'
          ? 'تعذّر تنزيل تسريع GPU. الإملاء يعمل على المعالج، ويمكنك إعادة المحاولة لاحقًا.'
          : 'تعذّر تنزيل ملفات الإملاء. تحقّق من الاتصال ثم أعد المحاولة.'
      this.errorDetail = (err as Error).message.trim().slice(0, 300)
    } finally {
      this.progress = null
      this.busy = false
      this.publish()
    }
    return this.status()
  }

  private async fetchAsset(
    what: string,
    candidates: readonly Candidate[],
    destination: string
  ): Promise<void> {
    if (await exists(destination)) return

    let lastPublished = 0
    const reset = (): void => {
      this.progress = { what, received: 0, total: 0 }
      // Clear the throttle too, or the reset itself could be the update that gets swallowed.
      lastPublished = 0
      this.publish()
    }
    reset()

    await downloadFirstAvailable(candidates, destination, {
      // A fallback restarts from zero, so zero the meter rather than let it jump backwards.
      onAttempt: (index) => {
        if (index > 0) reset()
      },
      onProgress: (received, total) => {
        this.progress = { what, received, total }
        // Publishing every chunk would flood the renderer; twice a second is plenty.
        const now = Date.now()
        if (now - lastPublished > 500) {
          lastPublished = now
          this.publish()
        }
      }
    })
  }

  /** Windows ships Expand-Archive, which saves pulling in a zip dependency. */
  private async unzip(zip: string, destination: string): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('automatic extraction is only wired up for Windows; unzip it manually')
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath '${psQuote(zip)}' -DestinationPath '${psQuote(destination)}' -Force`
        ],
        { windowsHide: true }
      )
      let stderr = ''
      child.stderr.on('data', (c) => (stderr += c))
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`extraction failed: ${stderr.slice(-200)}`))
      )
    })
  }

  // ── the resident server ────────────────────────────────────────────────

  /** Start the server ahead of the first phrase, so loading the model overlaps speech. */
  warm(): void {
    void this.ensureServer()
  }

  /** The running server, starting one if needed; null when only whisper-cli is usable. */
  private ensureServer(): Promise<WhisperServer | null> {
    if (this.server?.running) {
      this.armIdleTimer()
      return Promise.resolve(this.server)
    }
    this.serverStarting ??= this.startServer().finally(() => {
      this.serverStarting = null
    })
    return this.serverStarting
  }

  /** Try CUDA, then CPU. Whichever comes up first is kept. */
  private async startServer(): Promise<WhisperServer | null> {
    const { binaryPath, modelPath } = this.paths
    if (!this.useServer || !modelPath) return null

    const builds: Array<{ backend: Backend; cli: string | null }> = [
      { backend: 'cuda', cli: (await this.detectGpu()) ? this.cudaBinaryPath : null },
      { backend: 'cpu', cli: binaryPath }
    ]

    for (const { backend, cli } of builds) {
      if (!cli || this.failedBackends.has(backend)) continue
      const serverBinary = await findServerBinary(path.dirname(cli))
      if (!serverBinary) continue

      const server = this.createServer({
        binaryPath: serverBinary,
        modelPath,
        backend,
        onExit: (detail) => {
          // A crash mid-session: forget it, and the next phrase starts a fresh one.
          if (this.server === server) {
            this.server = null
            this.backendDetail = detail.slice(0, 300)
            this.publish()
          }
        }
      })
      try {
        await server.start()
        this.server = server
        this.armIdleTimer()
        this.publish()
        return server
      } catch (err) {
        server.stop()
        this.failedBackends.add(backend)
        this.backendDetail = `${backend}: ${(err as Error).message}`.slice(0, 300)
        console.warn(`[dictation] ${backend} whisper-server failed to start:`, err)
      }
    }
    this.publish()
    return null
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stopServer(), SERVER_IDLE_MS)
    this.idleTimer.unref?.()
  }

  private stopServer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const server = this.server
    this.server = null
    server?.stop()
    if (server) this.publish()
  }

  /** Stop the server. Called on quit so no whisper-server outlives the app. */
  dispose(): void {
    this.stopServer()
  }

  // ── transcription ──────────────────────────────────────────────────────

  /**
   * Transcribe one phrase. Uses the resident server when there is one, and whisper-cli
   * otherwise — slower, since it reloads the model, but phrases are short enough that it
   * never runs into its timeout.
   */
  async transcribeSegment(wav: Uint8Array, prompt = '', language = 'ar'): Promise<string> {
    const { binaryPath, modelPath } = this.paths
    if (!binaryPath || !modelPath) throw new Error('الإملاء غير مهيأ بعد')

    // Counted from the moment it arrives, before any await, so a preview cannot slip in
    // ahead of it while the server is being looked up.
    this.committing++
    try {
      const timeoutMs = segmentTimeoutMs(wavDurationSeconds(wav))
      const server = await this.ensureServer()
      if (server) {
        try {
          return parseTranscript(await server.infer(wav, { prompt, timeoutMs }))
        } catch (err) {
          // A server that is still up gave a real answer: the failure stands. One that died
          // mid-request should not cost the user this phrase.
          if (server.running) throw err
        }
      }
      return await this.transcribeWithCli(wav, { prompt, language, timeoutMs })
    } finally {
      this.committing--
    }
  }

  /**
   * A best-effort transcript of the phrase still being spoken, for the HUD. Null when no
   * server is up or it is busy with real phrases — a preview must never delay those. CPU
   * servers get none: a preview there takes about as long as the audio, and a real phrase
   * arriving meanwhile would queue behind it.
   */
  async preview(wav: Uint8Array, prompt = ''): Promise<string | null> {
    const server = this.server?.running ? this.server : null
    if (!server || server.backend !== 'cuda' || this.committing > 0) return null
    const timeoutMs = segmentTimeoutMs(wavDurationSeconds(wav))
    const text = await server.preview(wav, { prompt, timeoutMs }).catch(() => null)
    return text === null ? null : parseTranscript(text)
  }

  /** Transcribe a whole clip. Kept for callers that predate segmenting. */
  transcribe(wav: Uint8Array, language = 'ar'): Promise<string> {
    return this.transcribeSegment(wav, '', language)
  }

  /** The temp file is always cleaned up. */
  private async transcribeWithCli(
    wav: Uint8Array,
    options: { prompt: string; language: string; timeoutMs: number }
  ): Promise<string> {
    const { binaryPath, modelPath } = this.paths
    if (!binaryPath || !modelPath) throw new Error('الإملاء غير مهيأ بعد')

    await fs.mkdir(this.dir, { recursive: true })
    const wavPath = path.join(this.dir, `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    await fs.writeFile(wavPath, wav)
    try {
      return await runWhisper(
        { binaryPath, modelPath, wavPath, threads: cpuThreads(), ...options },
        this.spawnImpl
      )
    } finally {
      await fs.rm(wavPath, { force: true })
    }
  }
}
