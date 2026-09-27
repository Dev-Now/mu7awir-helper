/**
 * Arabic dictation via a local whisper.cpp binary.
 *
 * Windows voice typing (Win+H) has no Arabic, so the app supplies its own. whisper.cpp
 * runs entirely offline: no API key, no cost, and the audio never leaves the machine.
 * The binary and model are fetched on first use rather than shipped, which keeps ~600 MB
 * out of the installer.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** Prebuilt CPU binary; small enough to fetch on demand. */
export const WHISPER_BIN_URL =
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.4/whisper-bin-x64.zip'
/**
 * large-v3-turbo quantised: ~574 MB and several times faster than large-v3, at a few
 * points of WER. The model is swappable for exactly this reason.
 */
export const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'

export interface DictationPaths {
  binaryPath: string | null
  modelPath: string | null
}

export interface DictationStatus extends DictationPaths {
  ready: boolean
  /** Non-null while an asset is being fetched. */
  progress: { what: string; received: number; total: number } | null
  error: string | null
}

export type ProgressHandler = (received: number, total: number) => void

/** Stream a URL to disk, reporting progress. Downloads to a temp name and renames. */
export async function downloadTo(
  url: string,
  destination: string,
  onProgress?: ProgressHandler
): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0

  await fs.mkdir(path.dirname(destination), { recursive: true })
  const temp = `${destination}.part`

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.(received, total)
  })

  await pipeline(source, createWriteStream(temp))
  await fs.rename(temp, destination)
}

const exists = async (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false
  )

/** Locate whisper-cli.exe (or whisper-cli) anywhere under a directory. */
export async function findWhisperBinary(root: string): Promise<string | null> {
  const wanted = process.platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main']
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
      if (entry.isDirectory()) queue.push(full)
      else if (wanted.includes(entry.name.toLowerCase())) return full
    }
  }
  return null
}

/**
 * Parse whisper-cli's stdout. With `-nt -np` it prints the transcription and nothing
 * else, but it still emits the odd blank line and bracketed marker such as [BLANK_AUDIO].
 */
export function parseTranscript(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[[^\]]*\]$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Injection seam: tests supply a stub so the arguments can be asserted directly. */
export type SpawnLike = typeof spawn

export interface RunOptions {
  binaryPath: string
  modelPath: string
  wavPath: string
  language?: string
  timeoutMs?: number
}

/** Invoke whisper-cli on a WAV file and return what it heard. */
export function runWhisper(options: RunOptions, spawnImpl: SpawnLike = spawn): Promise<string> {
  const { binaryPath, modelPath, wavPath, language = 'ar', timeoutMs = 180_000 } = options
  const args = ['-m', modelPath, '-f', wavPath, '-l', language, '-nt', '-np']

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

export class Dictation {
  private readonly dir: string
  private readonly onStatus: (status: DictationStatus) => void
  private paths: DictationPaths = { binaryPath: null, modelPath: null }
  private progress: DictationStatus['progress'] = null
  private error: string | null = null
  private busy = false

  private readonly spawnImpl: SpawnLike

  constructor(
    userDataDir: string,
    onStatus: (status: DictationStatus) => void,
    spawnImpl: SpawnLike = spawn
  ) {
    this.dir = path.join(userDataDir, 'whisper')
    this.onStatus = onStatus
    this.spawnImpl = spawnImpl
  }

  get assetDir(): string {
    return this.dir
  }

  status(): DictationStatus {
    return {
      ...this.paths,
      ready: Boolean(this.paths.binaryPath && this.paths.modelPath),
      progress: this.progress,
      error: this.error
    }
  }

  private publish(): void {
    this.onStatus(this.status())
  }

  /** Look for assets already on disk, including ones the user pointed us at. */
  async refresh(override?: Partial<DictationPaths>): Promise<DictationStatus> {
    const binary = override?.binaryPath ?? this.paths.binaryPath
    const model = override?.modelPath ?? this.paths.modelPath

    this.paths = {
      binaryPath: binary && (await exists(binary)) ? binary : await findWhisperBinary(this.dir),
      modelPath: model && (await exists(model)) ? model : await this.findModel()
    }
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

  /** Fetch whatever is missing. Safe to call repeatedly; already-present assets are kept. */
  async install(): Promise<DictationStatus> {
    if (this.busy) return this.status()
    this.busy = true
    this.error = null

    try {
      await fs.mkdir(this.dir, { recursive: true })

      if (!this.paths.binaryPath) {
        const zip = path.join(this.dir, 'whisper-bin-x64.zip')
        await this.fetchAsset('برنامج whisper', WHISPER_BIN_URL, zip)
        await this.unzip(zip)
        await fs.rm(zip, { force: true })
      }

      if (!this.paths.modelPath) {
        const model = path.join(this.dir, 'ggml-large-v3-turbo-q5_0.bin')
        await this.fetchAsset('النموذج الصوتي', WHISPER_MODEL_URL, model)
      }

      await this.refresh()
    } catch (err) {
      this.error = (err as Error).message
    } finally {
      this.progress = null
      this.busy = false
      this.publish()
    }
    return this.status()
  }

  private async fetchAsset(what: string, url: string, destination: string): Promise<void> {
    if (await exists(destination)) return
    this.progress = { what, received: 0, total: 0 }
    this.publish()
    let lastPublished = 0
    await downloadTo(url, destination, (received, total) => {
      this.progress = { what, received, total }
      // Publishing every chunk would flood the renderer; twice a second is plenty.
      const now = Date.now()
      if (now - lastPublished > 500) {
        lastPublished = now
        this.publish()
      }
    })
  }

  /** Windows ships Expand-Archive, which saves pulling in a zip dependency. */
  private async unzip(zip: string): Promise<void> {
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
          `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${this.dir}' -Force`
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

  /** Transcribe a WAV clip. The temp file is always cleaned up. */
  async transcribe(wav: Uint8Array, language = 'ar'): Promise<string> {
    const { binaryPath, modelPath } = this.paths
    if (!binaryPath || !modelPath) throw new Error('الإملاء غير مهيأ بعد')

    await fs.mkdir(this.dir, { recursive: true })
    const wavPath = path.join(this.dir, `clip-${Date.now()}.wav`)
    await fs.writeFile(wavPath, wav)
    try {
      return await runWhisper({ binaryPath, modelPath, wavPath, language }, this.spawnImpl)
    } finally {
      await fs.rm(wavPath, { force: true })
    }
  }
}
