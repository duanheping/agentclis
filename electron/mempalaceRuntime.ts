import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  MemoryBackendInstallResult,
  MemoryBackendInstallState,
  MemoryBackendRuntimeState,
  MemoryBackendStatus,
} from '../src/shared/memorySearch'
import { writeUtf8FileAtomic } from './atomicFile'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DEFAULT_MANIFEST_PATH = path.resolve(
  __dirname,
  '..',
  'third_party',
  'mempalace.json',
)
const DEFAULT_APPDATA_ROOT = process.env.APPDATA
  ? path.normalize(process.env.APPDATA)
  : path.join(os.homedir(), 'AppData', 'Roaming')
const PROCESS_OUTPUT_LIMIT_BYTES = 8 * 1024

interface MempalaceRuntimeManifest {
  repo: string
  commit: string
  python: string
  module: string
  installRoot: string
  palaceRoot: string
}

interface MempalaceRuntimeMetadata {
  repo: string
  commit: string
  module: string
  pythonVersion: string
  pythonLauncherCommand: string
  pythonLauncherArgs: string[]
  installedAt: string
}

interface ResolvedPythonCommand {
  command: string
  args: string[]
  executable: string
  version: string
}

interface ResolvedRuntimePaths {
  installRoot: string
  palacePath: string
  venvRoot: string
  venvPythonPath: string
  metadataPath: string
}

interface ProcessResult {
  stdout: string
  stderr: string
}

export interface MempalaceRuntimeOptions {
  manifestPath?: string
  appDataRoot?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: typeof spawn
}

type InstallationState = 'missing' | 'installed' | 'invalid'

function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }

  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value
  }

  const prefix = '...'
  const prefixBytes = Buffer.byteLength(prefix, 'utf8')
  if (prefixBytes >= maxBytes) {
    return prefix.slice(0, maxBytes)
  }

  let low = 0
  let high = value.length
  let best = value

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = value.slice(value.length - mid)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes - prefixBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return `${prefix}${best.trimStart()}`
}

function appendProcessTail(current: string, chunk: string): string {
  return truncateUtf8Tail(`${current}${chunk}`, PROCESS_OUTPUT_LIMIT_BYTES)
}

function parseMinimumPythonVersion(specifier: string): {
  major: number
  minor: number
} {
  const match = specifier.trim().match(/^>=\s*(\d+)\.(\d+)$/u)
  if (!match) {
    throw new Error(`Unsupported Python version constraint: ${specifier}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
  }
}

function parsePythonVersion(version: string): {
  major: number
  minor: number
  patch: number
} | null {
  const match = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/u)
  if (!match) {
    return null
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
    patch: Number.parseInt(match[3] ?? '0', 10),
  }
}

function isPythonVersionAtLeast(
  version: string,
  minimum: { major: number; minor: number },
): boolean {
  const parsed = parsePythonVersion(version)
  if (!parsed) {
    return false
  }

  if (parsed.major !== minimum.major) {
    return parsed.major > minimum.major
  }

  return parsed.minor >= minimum.minor
}

function buildPythonCandidates(platform: NodeJS.Platform): Array<{
  command: string
  args: string[]
}> {
  if (platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] },
    ]
  }

  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ]
}

function buildRuntimeFailureMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
  stdoutTail: string,
): string {
  const parts = [
    `MemPalace runtime exited unexpectedly (code=${code ?? 'unknown'}, signal=${signal ?? 'none'}).`,
  ]

  if (stderrTail.trim()) {
    parts.push(`stderr: ${stderrTail.trim()}`)
  }
  if (stdoutTail.trim()) {
    parts.push(`stdout: ${stdoutTail.trim()}`)
  }

  return parts.join(' ')
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

export class MempalaceRuntime {
  private readonly manifestPath: string
  private readonly appDataRoot: string
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly spawnImpl: typeof spawn

  private manifestPromise: Promise<MempalaceRuntimeManifest> | null = null
  private installPromise: Promise<boolean> | null = null
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null
  private currentProcess: ChildProcessWithoutNullStreams | null = null
  private runtimeState: MemoryBackendRuntimeState = 'stopped'
  private lastError: string | null = null
  private message: string | null = null
  private stdoutTail = ''
  private stderrTail = ''
  private stopRequested = false

  constructor(options: MempalaceRuntimeOptions = {}) {
    this.manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH
    this.appDataRoot = path.normalize(options.appDataRoot ?? DEFAULT_APPDATA_ROOT)
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.spawnImpl = options.spawn ?? spawn
  }

  async getStatus(): Promise<MemoryBackendStatus> {
    const manifest = await this.loadManifest()
    const runtimePaths = this.resolveRuntimePaths(manifest)
    const installationState = await this.inspectInstallationState(
      manifest,
      runtimePaths,
    )
    const installState = this.deriveInstallState(installationState)
    const resolvedPython =
      installState === 'installed'
        ? null
        : await this.tryResolveSystemPython(manifest.python)

    let message = this.message
    let lastError = this.lastError

    if (!message) {
      if (installState === 'installing') {
        message = 'Installing pinned MemPalace runtime.'
      } else if (installState === 'installed') {
        message = this.runtimeState === 'running'
          ? 'MemPalace runtime is running.'
          : 'MemPalace runtime is installed.'
      } else if (installState === 'failed') {
        message = 'MemPalace runtime installation is incomplete or failed.'
      } else if (resolvedPython) {
        message = `Python ${resolvedPython.version} is available for MemPalace installation.`
      } else {
        message = `Python ${manifest.python} is required to install MemPalace.`
      }
    }

    if (!lastError && installState === 'failed' && installationState === 'invalid') {
      lastError =
        'MemPalace runtime files exist, but the pinned install metadata or virtual environment is incomplete.'
    }

    return {
      backend: 'mempalace',
      repo: manifest.repo,
      commit: manifest.commit,
      installState,
      runtimeState: this.runtimeState,
      installRoot: runtimePaths.installRoot,
      palacePath: runtimePaths.palacePath,
      pythonPath:
        installState === 'installed'
          ? runtimePaths.venvPythonPath
          : (resolvedPython?.executable ?? null),
      module: manifest.module,
      message,
      lastError,
    }
  }

  async installRuntime(): Promise<MemoryBackendInstallResult> {
    if (!this.installPromise) {
      this.installPromise = this.installRuntimeInternal()
    }

    let success = false

    try {
      success = await this.installPromise
    } finally {
      this.installPromise = null
    }

    return {
      success,
      status: await this.getStatus(),
    }
  }

  async start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.currentProcess) {
      return this.currentProcess
    }

    if (this.startPromise) {
      return await this.startPromise
    }

    this.startPromise = this.startInternal()

    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  stop(): void {
    this.stopRequested = true

    try {
      this.currentProcess?.kill()
    } catch {
      // Ignore shutdown failures; status is updated by the close/error handlers.
    }
  }

  private async installRuntimeInternal(): Promise<boolean> {
    this.message = 'Installing pinned MemPalace runtime.'
    this.lastError = null

    try {
      const manifest = await this.loadManifest()
      const runtimePaths = this.resolveRuntimePaths(manifest)
      const minimumPythonVersion = parseMinimumPythonVersion(manifest.python)
      const resolvedPython = await this.resolveSystemPython(minimumPythonVersion)

      await mkdir(runtimePaths.installRoot, { recursive: true })
      await mkdir(runtimePaths.palacePath, { recursive: true })

      await this.runProcessCommand(
        resolvedPython.command,
        [...resolvedPython.args, '-m', 'venv', runtimePaths.venvRoot],
        runtimePaths.installRoot,
      )
      await this.runProcessCommand(
        runtimePaths.venvPythonPath,
        ['-m', 'pip', 'install', '--upgrade', 'pip'],
        runtimePaths.installRoot,
      )
      await this.runProcessCommand(
        runtimePaths.venvPythonPath,
        ['-m', 'pip', 'install', `git+${manifest.repo}@${manifest.commit}`],
        runtimePaths.installRoot,
      )

      const metadata: MempalaceRuntimeMetadata = {
        repo: manifest.repo,
        commit: manifest.commit,
        module: manifest.module,
        pythonVersion: resolvedPython.version,
        pythonLauncherCommand: resolvedPython.command,
        pythonLauncherArgs: [...resolvedPython.args],
        installedAt: new Date().toISOString(),
      }
      await writeUtf8FileAtomic(
        runtimePaths.metadataPath,
        `${JSON.stringify(metadata, null, 2)}\n`,
      )

      this.lastError = null
      this.message = 'MemPalace runtime is installed.'
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.message = 'MemPalace runtime installation failed.'
      const manifest = await this.loadManifest()
      const runtimePaths = this.resolveRuntimePaths(manifest)
      await rm(runtimePaths.metadataPath, { force: true }).catch(() => undefined)
      return false
    }
  }

  private async startInternal(): Promise<ChildProcessWithoutNullStreams> {
    const manifest = await this.loadManifest()
    const runtimePaths = this.resolveRuntimePaths(manifest)
    const installationState = await this.inspectInstallationState(
      manifest,
      runtimePaths,
    )

    if (installationState !== 'installed') {
      throw new Error('MemPalace runtime is not installed.')
    }

    await mkdir(runtimePaths.palacePath, { recursive: true })

    this.stopRequested = false
    this.runtimeState = 'starting'
    this.lastError = null
    this.message = 'Starting MemPalace runtime.'
    this.stdoutTail = ''
    this.stderrTail = ''

    const child = this.spawnImpl(
      runtimePaths.venvPythonPath,
      ['-m', manifest.module, '--palace', runtimePaths.palacePath],
      {
        cwd: runtimePaths.installRoot,
        env: this.env,
        stdio: 'pipe',
        windowsHide: true,
      },
    )
    this.currentProcess = child

    child.stdout.on('data', (chunk) => {
      this.stdoutTail = appendProcessTail(this.stdoutTail, chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      this.stderrTail = appendProcessTail(this.stderrTail, chunk.toString())
    })
    child.on('error', (error) => {
      if (this.currentProcess === child) {
        this.currentProcess = null
      }
      this.runtimeState = 'failed'
      this.lastError = error.message
      this.message = 'MemPalace runtime failed to start.'
    })
    child.on('close', (code, signal) => {
      if (this.currentProcess === child) {
        this.currentProcess = null
      }

      if (this.stopRequested) {
        this.runtimeState = 'stopped'
        this.message = 'MemPalace runtime stopped.'
        this.lastError = null
        this.stopRequested = false
        return
      }

      if (code === 0) {
        this.runtimeState = 'stopped'
        this.message = 'MemPalace runtime exited.'
        return
      }

      this.runtimeState = 'failed'
      this.lastError = buildRuntimeFailureMessage(
        code,
        signal,
        this.stderrTail,
        this.stdoutTail,
      )
      this.message = 'MemPalace runtime exited unexpectedly.'
    })

    await new Promise<void>((resolve, reject) => {
      let startupTimer: ReturnType<typeof setTimeout> | null = null

      const handleSpawn = () => {
        startupTimer = setTimeout(() => {
          cleanup()
          resolve()
        }, 0)
      }
      const handleError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const handleClose = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        reject(
          new Error(
            buildRuntimeFailureMessage(
              code,
              signal,
              this.stderrTail,
              this.stdoutTail,
            ),
          ),
        )
      }
      const cleanup = () => {
        if (startupTimer) {
          clearTimeout(startupTimer)
          startupTimer = null
        }
        child.off('spawn', handleSpawn)
        child.off('error', handleError)
        child.off('close', handleClose)
      }

      child.once('spawn', handleSpawn)
      child.once('error', handleError)
      child.once('close', handleClose)
    })

    this.runtimeState = 'running'
    this.message = 'MemPalace runtime is running.'
    return child
  }

  private async loadManifest(): Promise<MempalaceRuntimeManifest> {
    if (!this.manifestPromise) {
      this.manifestPromise = this.loadManifestInternal()
    }

    return await this.manifestPromise
  }

  private async loadManifestInternal(): Promise<MempalaceRuntimeManifest> {
    const content = await readFile(this.manifestPath, 'utf8')
    const manifest = JSON.parse(content) as Partial<MempalaceRuntimeManifest>

    if (
      typeof manifest.repo !== 'string' ||
      typeof manifest.commit !== 'string' ||
      typeof manifest.python !== 'string' ||
      typeof manifest.module !== 'string' ||
      typeof manifest.installRoot !== 'string' ||
      typeof manifest.palaceRoot !== 'string'
    ) {
      throw new Error('Invalid MemPalace runtime manifest.')
    }

    return {
      repo: manifest.repo,
      commit: manifest.commit,
      python: manifest.python,
      module: manifest.module,
      installRoot: manifest.installRoot,
      palaceRoot: manifest.palaceRoot,
    }
  }

  private resolveRuntimePaths(
    manifest: MempalaceRuntimeManifest,
  ): ResolvedRuntimePaths {
    const installRoot = path.normalize(
      manifest.installRoot
        .replace(/%APPDATA%/gu, this.appDataRoot)
        .replace(/<commit>/gu, manifest.commit),
    )
    const palacePath = path.normalize(
      manifest.palaceRoot.replace(/%APPDATA%/gu, this.appDataRoot),
    )
    const venvRoot = path.join(installRoot, 'venv')
    const venvPythonPath = this.platform === 'win32'
      ? path.join(venvRoot, 'Scripts', 'python.exe')
      : path.join(venvRoot, 'bin', 'python')

    return {
      installRoot,
      palacePath,
      venvRoot,
      venvPythonPath,
      metadataPath: path.join(installRoot, 'agentclis-mempalace-runtime.json'),
    }
  }

  private async inspectInstallationState(
    manifest: MempalaceRuntimeManifest,
    runtimePaths: ResolvedRuntimePaths,
  ): Promise<InstallationState> {
    const metadata = await this.readMetadata(runtimePaths.metadataPath)
    const venvPythonExists = await fileExists(runtimePaths.venvPythonPath)

    if (!metadata && !venvPythonExists) {
      return 'missing'
    }

    if (
      metadata &&
      venvPythonExists &&
      metadata.repo === manifest.repo &&
      metadata.commit === manifest.commit &&
      metadata.module === manifest.module
    ) {
      return 'installed'
    }

    return 'invalid'
  }

  private deriveInstallState(
    installationState: InstallationState,
  ): MemoryBackendInstallState {
    if (this.installPromise) {
      return 'installing'
    }

    if (installationState === 'installed') {
      return 'installed'
    }

    if (installationState === 'invalid' || this.lastError) {
      return 'failed'
    }

    return 'not-installed'
  }

  private async readMetadata(
    metadataPath: string,
  ): Promise<MempalaceRuntimeMetadata | null> {
    try {
      const content = await readFile(metadataPath, 'utf8')
      const metadata = JSON.parse(content) as Partial<MempalaceRuntimeMetadata>

      if (
        typeof metadata.repo !== 'string' ||
        typeof metadata.commit !== 'string' ||
        typeof metadata.module !== 'string' ||
        typeof metadata.pythonVersion !== 'string' ||
        typeof metadata.pythonLauncherCommand !== 'string' ||
        !Array.isArray(metadata.pythonLauncherArgs) ||
        typeof metadata.installedAt !== 'string'
      ) {
        return null
      }

      return {
        repo: metadata.repo,
        commit: metadata.commit,
        module: metadata.module,
        pythonVersion: metadata.pythonVersion,
        pythonLauncherCommand: metadata.pythonLauncherCommand,
        pythonLauncherArgs: metadata.pythonLauncherArgs.filter(
          (value): value is string => typeof value === 'string',
        ),
        installedAt: metadata.installedAt,
      }
    } catch {
      return null
    }
  }

  private async tryResolveSystemPython(
    pythonSpecifier: string,
  ): Promise<ResolvedPythonCommand | null> {
    try {
      return await this.resolveSystemPython(
        parseMinimumPythonVersion(pythonSpecifier),
      )
    } catch {
      return null
    }
  }

  private async resolveSystemPython(minimum: {
    major: number
    minor: number
  }): Promise<ResolvedPythonCommand> {
    const script = [
      'import json, sys',
      "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), 'executable': sys.executable}))",
    ].join('; ')

    for (const candidate of buildPythonCandidates(this.platform)) {
      try {
        const result = await this.runProcessCommand(
          candidate.command,
          [...candidate.args, '-c', script],
        )
        const probe = JSON.parse(result.stdout.trim()) as Partial<{
          version: string
          executable: string
        }>

        if (
          typeof probe.version !== 'string' ||
          typeof probe.executable !== 'string' ||
          !isPythonVersionAtLeast(probe.version, minimum)
        ) {
          continue
        }

        return {
          command: candidate.command,
          args: [...candidate.args],
          executable: probe.executable,
          version: probe.version,
        }
      } catch {
        continue
      }
    }

    throw new Error(
      `Python ${minimum.major}.${minimum.minor}+ was not found on PATH.`,
    )
  }

  private async runProcessCommand(
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false

      const child = this.spawnImpl(command, args, {
        cwd,
        env: this.env,
        stdio: 'pipe',
        windowsHide: true,
      })

      const finalize = (
        callback: () => void,
      ) => {
        if (settled) {
          return
        }

        settled = true
        callback()
      }

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        finalize(() => {
          reject(error)
        })
      })
      child.on('close', (code, signal) => {
        finalize(() => {
          if (code === 0) {
            resolve({ stdout, stderr })
            return
          }

          reject(
            new Error(
              [
                `${command} exited with code ${code ?? 'unknown'}${signal ? ` (signal=${signal})` : ''}.`,
                stderr.trim() ? `stderr: ${stderr.trim()}` : null,
                stdout.trim() ? `stdout: ${stdout.trim()}` : null,
              ]
                .filter(Boolean)
                .join(' '),
            ),
          )
        })
      })
    })
  }
}
