import { readFileSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import Store from 'electron-store'

import {
  buildRuntime,
  type CreateProjectInput,
  deriveProjectTitle,
  deriveSessionTitle,
  resolveProjectRoot,
  resolveSessionCwd,
  type CreateSessionInput,
  type ListSessionsResponse,
  type ProjectConfig,
  type ProjectSnapshot,
  type SessionCloseResult,
  type SessionConfig,
  type SessionConfigEvent,
  type SessionDataEvent,
  type SessionExitMeta,
  type SessionRuntime,
  type SessionRuntimeEvent,
  type SessionSnapshot,
} from '../src/shared/session'
import {
  buildCopilotResumeCommand,
  extractCopilotSessionMeta,
  supportsCopilotSessionResume,
} from './copilotCli'
import {
  buildCodexResumeCommand,
  extractCodexSessionMeta,
  supportsCodexSessionResume,
} from './codexCli'
import { createProjectSessionWorktree } from './projectWorktree'
import {
  buildShellArgs,
  resolveShellCommand,
  supportsInlineShellCommand,
} from './windowsShell'

type IPty = import('node-pty').IPty

interface DetectedExternalSession {
  provider: 'codex' | 'copilot'
  sessionId: string
  timestamp: string
  cwd: string
  startedAt: number
  summary?: string
  sourcePath?: string
  originator?: string
  source?: string
}

type StoredSessionConfig = Omit<SessionConfig, 'projectId'> & {
  projectId?: string
  pendingFirstPromptTitle?: boolean
}

const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions')
const COPILOT_SESSIONS_ROOT = path.join(os.homedir(), '.copilot', 'session-state')
const CODEX_SESSION_FILE_PREFIX_BYTES = 4096
const CODEX_SESSION_DISCOVERY_LOOKBACK_MS = 5_000
const CODEX_SESSION_DISCOVERY_INTERVAL_MS = 750
const CODEX_SESSION_DISCOVERY_ATTEMPTS = 24
const CODEX_SESSION_DISCOVERY_FILE_LIMIT = 32
const HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000
const EXTERNAL_SESSION_TITLE_SCAN_BYTES = 131_072
const FIRST_PROMPT_TITLE_LIMIT = 80

const require = createRequire(import.meta.url)
const nodePty = require('node-pty') as typeof import('node-pty')

function isMeaningfulSessionTitleCandidate(title: string): boolean {
  const normalized = title.trim()
  if (!normalized) {
    return false
  }

  if (/^\/\S*$/u.test(normalized)) {
    return false
  }

  return /[\p{L}\p{N}]/u.test(normalized)
}

interface PersistedSessionState {
  projects: ProjectConfig[]
  sessions: StoredSessionConfig[]
  activeSessionId: string | null
}

interface SessionManagerEvents {
  onData: (event: SessionDataEvent) => void
  onConfig: (event: SessionConfigEvent) => void
  onRuntime: (event: SessionRuntimeEvent) => void
  onExit: (event: SessionExitMeta) => void
}

export class SessionManager {
  private readonly store = new Store<PersistedSessionState>({
    name: 'agenclis-sessions',
    defaults: {
      projects: [],
      sessions: [],
      activeSessionId: null,
    },
  })

  private readonly projects = new Map<string, ProjectConfig>()
  private readonly configs = new Map<string, SessionConfig>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly terminals = new Map<string, IPty>()
  private readonly pendingFirstPromptBuffers = new Map<string, string>()
  private readonly claimedExternalSessions = new Map<string, string>()
  private readonly pendingExternalSessionDetections = new Map<string, NodeJS.Timeout>()
  private readonly historicalExternalSessionRecovery = new Set<string>()
  private readonly suppressedExit = new Set<string>()
  private readonly events: SessionManagerEvents

  private activeSessionId: string | null
  private restored = false

  constructor(events: SessionManagerEvents) {
    this.events = events
    const persisted = this.store.store
    this.activeSessionId = persisted.activeSessionId

    for (const project of persisted.projects ?? []) {
      this.projects.set(project.id, project)
    }

    let shouldPersist = false

    for (const config of persisted.sessions ?? []) {
      const hydratedConfig = this.hydrateSessionConfig(config)
      this.configs.set(hydratedConfig.id, hydratedConfig)
      this.runtimes.set(hydratedConfig.id, buildRuntime(hydratedConfig.id))
      this.claimExternalSession(hydratedConfig)
      this.trackHistoricalExternalSessionRecovery(hydratedConfig)

      if (
        config.projectId !== hydratedConfig.projectId ||
        config.title !== hydratedConfig.title ||
        config.pendingFirstPromptTitle !== hydratedConfig.pendingFirstPromptTitle ||
        config.cwd !== hydratedConfig.cwd ||
        config.shell !== hydratedConfig.shell
      ) {
        shouldPersist = true
      }
    }

    if (this.activeSessionId && !this.configs.has(this.activeSessionId)) {
      this.activeSessionId = this.getOrderedConfigs()[0]?.id ?? null
      shouldPersist = true
    }

    if (shouldPersist) {
      this.persist()
    }
  }

  listSessions(): ListSessionsResponse {
    return {
      projects: this.getOrderedProjects().map((project) =>
        this.projectSnapshotFor(project.id),
      ),
      activeSessionId: this.activeSessionId,
    }
  }

  async restoreSessions(): Promise<ListSessionsResponse> {
    if (!this.restored) {
      this.restored = true
      if (this.activeSessionId) {
        void this.ensureSessionStarted(this.activeSessionId)
      }
    }

    return this.listSessions()
  }

  createProject(input: CreateProjectInput): ProjectSnapshot {
    const rootPath = input.rootPath.trim()
    if (!rootPath) {
      throw new Error('Project root path is required.')
    }

    const existingProject = this.findProjectByRootPath(rootPath)
    if (existingProject) {
      this.touchProject(existingProject.id)
      this.persist()
      return this.projectSnapshotFor(existingProject.id)
    }

    const now = new Date().toISOString()
    const project: ProjectConfig = {
      id: crypto.randomUUID(),
      title: deriveProjectTitle(input.title, rootPath),
      rootPath,
      createdAt: now,
      updatedAt: now,
    }

    this.projects.set(project.id, project)
    this.persist()
    return this.projectSnapshotFor(project.id)
  }

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    const now = new Date().toISOString()
    const project = this.resolveProjectForCreate(input)
    const id = crypto.randomUUID()
    const shell = resolveShellCommand()
    const cwd = input.createWithWorktree
      ? (
          await createProjectSessionWorktree({
            projectRootPath: project.rootPath,
            sessionId: id,
            createdAt: now,
          })
        ).cwd
      : resolveSessionCwd(input.cwd, project.rootPath)

    const config: SessionConfig = {
      id,
      projectId: project.id,
      title: deriveSessionTitle(input.title, input.startupCommand, cwd),
      startupCommand: input.startupCommand.trim(),
      pendingFirstPromptTitle: this.shouldCaptureFirstPromptTitle(
        input.startupCommand,
        input.title,
      ),
      cwd,
      shell,
      createdAt: now,
      updatedAt: now,
    }

    this.configs.set(id, config)
    this.runtimes.set(id, buildRuntime(id))
    this.touchProject(project.id, now)
    this.activeSessionId = id
    this.persist()

    await this.startSession(config)
    return this.snapshotFor(id)
  }

  renameSession(id: string, title: string): SessionSnapshot {
    const config = this.requireConfig(id)
    const nextTitle = deriveSessionTitle(title, config.startupCommand, config.cwd)
    const nextConfig: SessionConfig = {
      ...config,
      title: nextTitle,
      pendingFirstPromptTitle: config.pendingFirstPromptTitle && !title.trim(),
      updatedAt: new Date().toISOString(),
    }

    this.configs.set(id, nextConfig)
    this.persist()
    this.events.onConfig({
      sessionId: id,
      config: nextConfig,
    })
    return this.snapshotFor(id)
  }

  async activateSession(id: string): Promise<void> {
    const config = this.requireConfig(id)
    this.activeSessionId = id
    this.touchProject(config.projectId)
    this.touchRuntime(id)
    this.persist()
    await this.ensureSessionStarted(id)
  }

  async restartSession(id: string): Promise<SessionSnapshot> {
    const config = this.requireConfig(id)
    await this.startSession(config)
    return this.snapshotFor(id)
  }

  closeSession(id: string): SessionCloseResult {
    const orderedIds = this.getOrderedConfigs().map((config) => config.id)
    const closingIndex = orderedIds.indexOf(id)
    if (closingIndex === -1) {
      throw new Error(`Unknown session: ${id}`)
    }

    const closingConfig = this.requireConfig(id)

    this.stopSession(id, true)
    this.cancelExternalSessionDetection(id)
    this.pendingFirstPromptBuffers.delete(id)
    this.historicalExternalSessionRecovery.delete(id)
    this.releaseExternalSession(closingConfig)
    this.configs.delete(id)
    this.runtimes.delete(id)

    if (this.activeSessionId === id) {
      this.activeSessionId =
        orderedIds[closingIndex + 1] ??
        orderedIds[closingIndex - 1] ??
        null
    }

    this.persist()
    return {
      closedSessionId: id,
      activeSessionId: this.activeSessionId,
    }
  }

  writeToSession(id: string, data: string): void {
    this.capturePendingFirstPromptTitle(id, data)
    this.touchRuntime(id)
    this.terminals.get(id)?.write(data)
  }

  resizeSession(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id)
    if (!terminal || cols < 2 || rows < 1) {
      return
    }

    terminal.resize(Math.floor(cols), Math.floor(rows))
  }

  dispose(): void {
    for (const sessionId of Array.from(
      this.pendingExternalSessionDetections.keys(),
    )) {
      this.cancelExternalSessionDetection(sessionId)
    }

    for (const id of Array.from(this.terminals.keys())) {
      this.stopSession(id, true)
    }
  }

  private async startSession(config: SessionConfig): Promise<void> {
    this.stopSession(config.id, true)
    this.cancelExternalSessionDetection(config.id)
    this.pendingFirstPromptBuffers.delete(config.id)
    this.setRuntime(config.id, {
      status: 'starting',
      pid: undefined,
      exitCode: undefined,
    })

    try {
      const currentConfig = this.requireConfig(config.id)
      const shell = resolveShellCommand(currentConfig.shell)
      let normalizedConfig = currentConfig

      if (shell !== currentConfig.shell) {
        this.configs.set(config.id, {
          ...currentConfig,
          shell,
          updatedAt: new Date().toISOString(),
        })
        normalizedConfig = this.requireConfig(config.id)
        this.persist()
      }

      if (normalizedConfig.externalSession?.provider === 'codex') {
        const shouldKeepStoredSession =
          await this.shouldKeepStoredCodexExternalSession(normalizedConfig)
        if (!shouldKeepStoredSession) {
          this.releaseExternalSession(normalizedConfig)
          const nextConfig: SessionConfig = {
            ...normalizedConfig,
            externalSession: undefined,
          }
          this.configs.set(nextConfig.id, nextConfig)
          this.trackHistoricalExternalSessionRecovery(nextConfig)
          this.persist()
          this.events.onConfig({
            sessionId: nextConfig.id,
            config: nextConfig,
          })
          normalizedConfig = nextConfig
        }
      }

      const resumableProvider =
        normalizedConfig.externalSession === undefined &&
        this.historicalExternalSessionRecovery.has(normalizedConfig.id)
          ? this.detectResumableProvider(normalizedConfig.startupCommand)
          : null
      if (resumableProvider) {
        const historicalSession = await this.findHistoricalExternalSession(
          normalizedConfig,
          resumableProvider,
        )
        if (historicalSession) {
          this.attachExternalSession(normalizedConfig, historicalSession)
          normalizedConfig = this.requireConfig(config.id)
        }
      }

      const launchCommand = this.resolveStartupCommand(normalizedConfig)
      const launchesInline = supportsInlineShellCommand(shell)
      const terminal = nodePty.spawn(
        shell,
        buildShellArgs(shell, launchesInline ? launchCommand : undefined),
        {
        name: 'xterm-color',
        cols: 120,
        rows: 36,
        cwd: normalizedConfig.cwd,
        useConpty: true,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
        },
      )

      this.terminals.set(config.id, terminal)
      this.setRuntime(config.id, {
        status: 'running',
        pid: terminal.pid,
        exitCode: undefined,
      })

      terminal.onData((chunk) => {
        this.events.onData({
          sessionId: normalizedConfig.id,
          chunk,
        })
      })

      terminal.onExit(({ exitCode }) => {
        this.terminals.delete(normalizedConfig.id)
        this.cancelExternalSessionDetection(normalizedConfig.id)

        if (this.suppressedExit.delete(normalizedConfig.id)) {
          return
        }

        const status = exitCode === 0 ? 'exited' : 'error'
        this.setRuntime(normalizedConfig.id, {
          status,
          pid: undefined,
          exitCode,
        })
        this.events.onExit({
          sessionId: normalizedConfig.id,
          exitCode,
        })
      })

      const externalSessionProvider =
        !normalizedConfig.externalSession
          ? this.detectResumableProvider(normalizedConfig.startupCommand)
          : null
      const detectionStartedAt = Date.now()

      setTimeout(() => {
        if (!launchesInline) {
          terminal.write(`${launchCommand}\r`)
        }

        if (externalSessionProvider) {
          void this.pollForExternalSessionRef(
            normalizedConfig.id,
            externalSessionProvider,
            detectionStartedAt,
          )
        }
      }, 60)
    } catch (error) {
      this.setRuntime(config.id, {
        status: 'error',
        pid: undefined,
        exitCode: -1,
      })

      this.events.onData({
        sessionId: config.id,
        chunk: `\r\n[agenclis] Failed to start session: ${this.getErrorMessage(error)}\r\n`,
      })
      this.events.onExit({
        sessionId: config.id,
        exitCode: -1,
      })
    }
  }

  private async ensureSessionStarted(id: string): Promise<void> {
    if (this.terminals.has(id)) {
      return
    }

    if (this.runtimes.get(id)?.status === 'starting') {
      return
    }

    await this.startSession(this.requireConfig(id))
  }

  private stopSession(id: string, suppressExit: boolean): void {
    const terminal = this.terminals.get(id)
    if (!terminal) {
      return
    }

    if (suppressExit) {
      this.suppressedExit.add(id)
    }

    this.terminals.delete(id)
    try {
      terminal.kill()
    } catch {
      this.suppressedExit.delete(id)
    }
  }

  private resolveStartupCommand(config: SessionConfig): string {
    if (config.externalSession?.provider === 'codex') {
      return (
        buildCodexResumeCommand(
          config.startupCommand,
          config.externalSession.sessionId,
        ) ?? config.startupCommand
      )
    }

    if (config.externalSession?.provider === 'copilot') {
      return (
        buildCopilotResumeCommand(
          config.startupCommand,
          config.externalSession.sessionId,
        ) ?? config.startupCommand
      )
    }

    return config.startupCommand
  }

  private cancelExternalSessionDetection(sessionId: string): void {
    const timer = this.pendingExternalSessionDetections.get(sessionId)
    if (!timer) {
      return
    }

    clearTimeout(timer)
    this.pendingExternalSessionDetections.delete(sessionId)
  }

  private detectResumableProvider(
    command: string,
  ): 'codex' | 'copilot' | null {
    if (supportsCodexSessionResume(command)) {
      return 'codex'
    }

    if (supportsCopilotSessionResume(command)) {
      return 'copilot'
    }

    return null
  }

  private async pollForExternalSessionRef(
    sessionId: string,
    provider: 'codex' | 'copilot',
    startedAt: number,
    attempt = 0,
  ): Promise<void> {
    this.pendingExternalSessionDetections.delete(sessionId)

    const config = this.configs.get(sessionId)
    if (!config || config.externalSession || !this.terminals.has(sessionId)) {
      return
    }

    const detectedSession = await this.findMatchingExternalSession(
      config,
      provider,
      startedAt,
    )
    if (detectedSession) {
      this.attachExternalSession(config, detectedSession)
      return
    }

    if (attempt + 1 >= CODEX_SESSION_DISCOVERY_ATTEMPTS) {
      return
    }

    const timer = setTimeout(() => {
      void this.pollForExternalSessionRef(
        sessionId,
        provider,
        startedAt,
        attempt + 1,
      )
    }, CODEX_SESSION_DISCOVERY_INTERVAL_MS)
    this.pendingExternalSessionDetections.set(sessionId, timer)
  }

  private async findMatchingExternalSession(
    config: SessionConfig,
    provider: 'codex' | 'copilot',
    startedAt: number,
  ): Promise<DetectedExternalSession | null> {
    const candidates = await this.listRecentExternalSessions(
      provider,
      startedAt - CODEX_SESSION_DISCOVERY_LOOKBACK_MS,
    )
    const normalizedCwd = this.normalizePath(config.cwd)

    const match = candidates
      .filter((candidate) => this.isEligibleExternalSessionCandidate(candidate))
      .filter((candidate) => this.normalizePath(candidate.cwd) === normalizedCwd)
      .filter((candidate) => {
        const claimedBy = this.claimedExternalSessions.get(
          this.getExternalSessionClaimKey(candidate.provider, candidate.sessionId),
        )
        return !claimedBy || claimedBy === config.id
      })
      .sort((left, right) => {
        const leftDistance = Math.abs(left.startedAt - startedAt)
        const rightDistance = Math.abs(right.startedAt - startedAt)

        return leftDistance - rightDistance || right.startedAt - left.startedAt
      })[0]

    return match ?? null
  }

  private async findHistoricalExternalSession(
    config: SessionConfig,
    provider: 'codex' | 'copilot',
  ): Promise<DetectedExternalSession | null> {
    const referenceTimestamps = this.getExternalSessionReferenceTimes(config)
    if (referenceTimestamps.length === 0) {
      return null
    }

    const candidates = await this.listRecentExternalSessions(
      provider,
      Math.max(
        0,
        Math.min(...referenceTimestamps) - HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS,
      ),
    )
    const normalizedCwd = this.normalizePath(config.cwd)
    const defaultTitle = deriveSessionTitle(undefined, config.startupCommand, config.cwd)
    const normalizedTitle = config.title.trim().toLowerCase()
    const shouldMatchTitle =
      normalizedTitle.length > 0 &&
      normalizedTitle !== defaultTitle.trim().toLowerCase()

    const scoredCandidates = await Promise.all(
      candidates
        .filter((candidate) => this.isEligibleExternalSessionCandidate(candidate))
        .filter((candidate) => this.normalizePath(candidate.cwd) === normalizedCwd)
        .filter((candidate) => {
          const claimedBy = this.claimedExternalSessions.get(
            this.getExternalSessionClaimKey(candidate.provider, candidate.sessionId),
          )
          return !claimedBy || claimedBy === config.id
        })
        .map(async (candidate) => ({
          candidate,
          titleMatches: shouldMatchTitle
            ? await this.doesExternalSessionMatchTitle(candidate, normalizedTitle)
            : false,
          distance: Math.min(
            ...referenceTimestamps.map((referenceTime) =>
              Math.abs(candidate.startedAt - referenceTime),
            ),
          ),
        })),
    )

    return scoredCandidates
      .sort((left, right) => {
        if (left.titleMatches !== right.titleMatches) {
          return left.titleMatches ? -1 : 1
        }

        return (
          left.distance - right.distance ||
          right.candidate.startedAt - left.candidate.startedAt
        )
      })[0]?.candidate ?? null
  }

  private async shouldKeepStoredCodexExternalSession(
    config: SessionConfig,
  ): Promise<boolean> {
    if (config.externalSession?.provider !== 'codex') {
      return true
    }

    const candidate = await this.findRecentExternalSessionById(
      'codex',
      config.externalSession.sessionId,
      this.getExternalSessionReferenceTimes(config),
    )

    if (!candidate) {
      return true
    }

    return this.isEligibleExternalSessionCandidate(candidate)
  }

  private async findRecentExternalSessionById(
    provider: 'codex' | 'copilot',
    sessionId: string,
    referenceTimestamps: number[],
  ): Promise<DetectedExternalSession | null> {
    if (referenceTimestamps.length === 0) {
      return null
    }

    const candidates = await this.listRecentExternalSessions(
      provider,
      Math.max(
        0,
        Math.min(...referenceTimestamps) - HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS,
      ),
    )

    return candidates.find((candidate) => candidate.sessionId === sessionId) ?? null
  }

  private getExternalSessionReferenceTimes(config: SessionConfig): number[] {
    return [
      config.updatedAt,
      config.createdAt,
      config.externalSession?.detectedAt,
    ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => Date.parse(value))
      .filter((value) => !Number.isNaN(value))
  }

  private async doesExternalSessionMatchTitle(
    candidate: DetectedExternalSession,
    normalizedTitle: string,
  ): Promise<boolean> {
    if (candidate.summary) {
      const normalizedSummary = candidate.summary.trim().toLowerCase()
      if (
        normalizedSummary.includes(normalizedTitle) ||
        normalizedTitle.includes(normalizedSummary)
      ) {
        return true
      }
    }

    if (candidate.provider !== 'codex' || !candidate.sourcePath) {
      return false
    }

    const prefix = await this.readFilePrefix(
      candidate.sourcePath,
      EXTERNAL_SESSION_TITLE_SCAN_BYTES,
    )
    if (!prefix) {
      return false
    }

    return prefix.toLowerCase().includes(normalizedTitle)
  }

  private async listRecentExternalSessions(
    provider: 'codex' | 'copilot',
    sinceMs: number,
  ): Promise<DetectedExternalSession[]> {
    if (provider === 'copilot') {
      return this.listRecentCopilotSessions(sinceMs)
    }

    const candidateFiles = await this.listRecentCodexSessionFiles(sinceMs)
    const sessions: DetectedExternalSession[] = []

    for (const filePath of candidateFiles) {
      const sessionMeta = await this.readCodexSessionMeta(filePath)
      if (sessionMeta) {
        sessions.push(sessionMeta)
      }
    }

    return sessions
  }

  private async listRecentCopilotSessions(
    sinceMs: number,
  ): Promise<DetectedExternalSession[]> {
    let entries
    try {
      entries = await readdir(COPILOT_SESSIONS_ROOT, { withFileTypes: true })
    } catch {
      return []
    }

    const candidates: Array<{
      workspaceFilePath: string
      modifiedAt: number
    }> = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const workspaceFilePath = path.join(
        COPILOT_SESSIONS_ROOT,
        entry.name,
        'workspace.yaml',
      )

      let details
      try {
        details = await stat(workspaceFilePath)
      } catch {
        continue
      }

      if (details.mtimeMs < sinceMs) {
        continue
      }

      candidates.push({
        workspaceFilePath,
        modifiedAt: details.mtimeMs,
      })
    }

    const sessions: DetectedExternalSession[] = []
    for (const candidate of candidates
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, CODEX_SESSION_DISCOVERY_FILE_LIMIT)) {
      const sessionMeta = await this.readCopilotSessionMeta(candidate.workspaceFilePath)
      if (sessionMeta) {
        sessions.push(sessionMeta)
      }
    }

    return sessions
  }

  private async listRecentCodexSessionFiles(sinceMs: number): Promise<string[]> {
    const dayDirectories = this.getCodexSessionDayDirectories(sinceMs)
    const candidates: Array<{
      filePath: string
      modifiedAt: number
    }> = []

    for (const dayDirectory of dayDirectories) {
      let entries
      try {
        entries = await readdir(dayDirectory, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue
        }

        const filePath = path.join(dayDirectory, entry.name)
        let details
        try {
          details = await stat(filePath)
        } catch {
          continue
        }

        if (details.mtimeMs < sinceMs) {
          continue
        }

        candidates.push({
          filePath,
          modifiedAt: details.mtimeMs,
        })
      }
    }

    return candidates
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, CODEX_SESSION_DISCOVERY_FILE_LIMIT)
      .map((candidate) => candidate.filePath)
  }

  private getCodexSessionDayDirectories(sinceMs: number): string[] {
    const directories: string[] = []
    const currentDay = new Date(sinceMs)
    currentDay.setHours(0, 0, 0, 0)

    const endDay = new Date()
    endDay.setHours(0, 0, 0, 0)

    while (currentDay.getTime() <= endDay.getTime()) {
      directories.push(
        path.join(
          CODEX_SESSIONS_ROOT,
          `${currentDay.getFullYear()}`,
          `${currentDay.getMonth() + 1}`.padStart(2, '0'),
          `${currentDay.getDate()}`.padStart(2, '0'),
        ),
      )
      currentDay.setDate(currentDay.getDate() + 1)
    }

    return directories
  }

  private async readCodexSessionMeta(
    filePath: string,
  ): Promise<DetectedExternalSession | null> {
    let handle

    try {
      handle = await open(filePath, 'r')
      const buffer = Buffer.alloc(CODEX_SESSION_FILE_PREFIX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const prefix = buffer.toString('utf8', 0, bytesRead)
      const meta = extractCodexSessionMeta(prefix)
      if (!meta) {
        return null
      }

      const startedAt = Date.parse(meta.timestamp)
      if (Number.isNaN(startedAt)) {
        return null
      }

      return {
        provider: 'codex',
        sessionId: meta.sessionId,
        timestamp: meta.timestamp,
        cwd: meta.cwd,
        startedAt,
        sourcePath: filePath,
        originator: meta.originator,
        source: meta.source,
      }
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async readFilePrefix(
    filePath: string,
    byteLimit: number,
  ): Promise<string | null> {
    let handle

    try {
      handle = await open(filePath, 'r')
      const buffer = Buffer.alloc(byteLimit)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async readCopilotSessionMeta(
    filePath: string,
  ): Promise<DetectedExternalSession | null> {
    let handle

    try {
      handle = await open(filePath, 'r')
      const content = await handle.readFile({ encoding: 'utf8' })
      const meta = extractCopilotSessionMeta(content)
      if (!meta) {
        return null
      }

      const startedAt = Date.parse(meta.timestamp)
      if (Number.isNaN(startedAt)) {
        return null
      }

      return {
        provider: 'copilot',
        sessionId: meta.sessionId,
        timestamp: meta.timestamp,
        cwd: meta.cwd,
        startedAt,
        summary: meta.summary,
        sourcePath: filePath,
      }
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private attachExternalSession(
    config: SessionConfig,
    detectedSession: DetectedExternalSession,
  ): void {
    const latestConfig = this.configs.get(config.id)
    if (!latestConfig) {
      return
    }

    if (
      latestConfig.externalSession?.provider === detectedSession.provider &&
      latestConfig.externalSession.sessionId === detectedSession.sessionId
    ) {
      return
    }

    this.releaseExternalSession(latestConfig)
    const preferredTitle =
      detectedSession.summary &&
      this.shouldPreferExternalSessionTitle(
        latestConfig,
        latestConfig.cwd,
        latestConfig.title,
      )
        ? detectedSession.summary
        : null
    const titleChanged =
      preferredTitle !== null && preferredTitle !== latestConfig.title
    const timestamp = titleChanged
      ? new Date().toISOString()
      : latestConfig.updatedAt
    const nextConfig: SessionConfig = {
      ...latestConfig,
      title: preferredTitle ?? latestConfig.title,
      pendingFirstPromptTitle: titleChanged
        ? false
        : latestConfig.pendingFirstPromptTitle,
      externalSession: {
        provider: detectedSession.provider,
        sessionId: detectedSession.sessionId,
        detectedAt: new Date().toISOString(),
      },
      updatedAt: timestamp,
    }

    this.claimExternalSession(nextConfig)
    this.historicalExternalSessionRecovery.delete(nextConfig.id)
    this.configs.set(nextConfig.id, nextConfig)
    if (titleChanged) {
      this.touchProject(nextConfig.projectId, timestamp)
    }
    this.persist()
    this.events.onConfig({
      sessionId: nextConfig.id,
      config: nextConfig,
    })
  }

  private claimExternalSession(config: SessionConfig): void {
    if (!config.externalSession) {
      return
    }

    this.claimedExternalSessions.set(
      this.getExternalSessionClaimKey(
        config.externalSession.provider,
        config.externalSession.sessionId,
      ),
      config.id,
    )
  }

  private releaseExternalSession(config: SessionConfig): void {
    if (!config.externalSession) {
      return
    }

    const claimKey = this.getExternalSessionClaimKey(
      config.externalSession.provider,
      config.externalSession.sessionId,
    )
    const claimedBy = this.claimedExternalSessions.get(claimKey)
    if (claimedBy === config.id) {
      this.claimedExternalSessions.delete(claimKey)
    }
  }

  private getExternalSessionClaimKey(
    provider: 'codex' | 'copilot',
    sessionId: string,
  ): string {
    return `${provider}:${sessionId}`
  }

  private isEligibleExternalSessionCandidate(
    candidate: DetectedExternalSession,
  ): boolean {
    if (candidate.provider !== 'codex') {
      return true
    }

    return candidate.source === 'cli' || candidate.originator === 'codex_cli_rs'
  }

  private trackHistoricalExternalSessionRecovery(config: SessionConfig): void {
    if (
      config.externalSession ||
      !this.detectResumableProvider(config.startupCommand)
    ) {
      this.historicalExternalSessionRecovery.delete(config.id)
      return
    }

    this.historicalExternalSessionRecovery.add(config.id)
  }

  private hydrateSessionConfig(config: StoredSessionConfig): SessionConfig {
    const cwd = resolveSessionCwd(config.cwd, os.homedir())
    const title = this.resolveHydratedSessionTitle(config, cwd)
    const project = this.resolveProjectForHydration(config.projectId, cwd, config)

    return {
      ...config,
      projectId: project.id,
      title,
      pendingFirstPromptTitle: this.inferPendingFirstPromptTitle(config, cwd, title),
      cwd,
      shell: resolveShellCommand(config.shell),
    }
  }

  private resolveHydratedSessionTitle(
    config: StoredSessionConfig,
    cwd: string,
  ): string {
    const title = deriveSessionTitle(config.title, config.startupCommand, cwd)
    const externalTitle = this.readStoredExternalSessionTitle(config.externalSession)

    if (!externalTitle) {
      return title
    }

    return this.shouldPreferExternalSessionTitle(config, cwd, title)
      ? externalTitle
      : title
  }

  private readStoredExternalSessionTitle(
    externalSession: SessionConfig['externalSession'] | undefined,
  ): string | null {
    if (externalSession?.provider !== 'copilot') {
      return null
    }

    const workspaceFilePath = path.join(
      COPILOT_SESSIONS_ROOT,
      externalSession.sessionId,
      'workspace.yaml',
    )

    try {
      const content = readFileSync(workspaceFilePath, 'utf8')
      return extractCopilotSessionMeta(content)?.summary?.trim() || null
    } catch {
      return null
    }
  }

  private shouldPreferExternalSessionTitle(
    config: Pick<StoredSessionConfig, 'pendingFirstPromptTitle' | 'startupCommand'>,
    cwd: string,
    title: string,
  ): boolean {
    if (config.pendingFirstPromptTitle) {
      return true
    }

    if (!isMeaningfulSessionTitleCandidate(title)) {
      return true
    }

    return title === deriveSessionTitle(undefined, config.startupCommand, cwd)
  }

  private shouldCaptureFirstPromptTitle(
    startupCommand: string,
    title: string | undefined,
  ): boolean {
    if (title?.trim()) {
      return false
    }

    return (
      supportsCodexSessionResume(startupCommand) ||
      supportsCopilotSessionResume(startupCommand)
    )
  }

  private inferPendingFirstPromptTitle(
    config: StoredSessionConfig,
    cwd: string,
    title: string,
  ): boolean {
    if (typeof config.pendingFirstPromptTitle === 'boolean') {
      return config.pendingFirstPromptTitle
    }

    if (!this.shouldCaptureFirstPromptTitle(config.startupCommand, undefined)) {
      return false
    }

    return title === deriveSessionTitle(undefined, config.startupCommand, cwd)
  }

  private capturePendingFirstPromptTitle(id: string, data: string): void {
    const config = this.configs.get(id)
    if (!config?.pendingFirstPromptTitle) {
      return
    }

    let buffer = this.pendingFirstPromptBuffers.get(id) ?? ''

    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]

      if (char === '\u001b') {
        index = this.skipEscapeSequence(data, index)
        continue
      }

      if (char === '\r' || char === '\n') {
        const promptTitle = this.normalizeFirstPromptTitle(buffer)
        buffer = ''

        if (promptTitle && isMeaningfulSessionTitleCandidate(promptTitle)) {
          this.pendingFirstPromptBuffers.delete(id)
          this.applyFirstPromptTitle(id, promptTitle)
          return
        }

        continue
      }

      if (char === '\u0003' || char === '\u0015') {
        buffer = ''
        continue
      }

      if (char === '\u0008' || char === '\u007f') {
        buffer = buffer.slice(0, -1)
        continue
      }

      if (char === '\t') {
        buffer += ' '
        continue
      }

      if (char >= ' ') {
        buffer += char
      }
    }

    if (buffer) {
      this.pendingFirstPromptBuffers.set(id, buffer)
      return
    }

    this.pendingFirstPromptBuffers.delete(id)
  }

  private skipEscapeSequence(data: string, startIndex: number): number {
    let index = startIndex + 1
    if (index >= data.length) {
      return startIndex
    }

    if (data[index] === '[' || data[index] === 'O') {
      index += 1
      while (index < data.length) {
        const char = data[index]
        if (char >= '@' && char <= '~') {
          return index
        }

        index += 1
      }
    }

    return index
  }

  private normalizeFirstPromptTitle(value: string): string {
    const normalized = value.trim().replace(/\s+/g, ' ')
    if (normalized.length <= FIRST_PROMPT_TITLE_LIMIT) {
      return normalized
    }

    const preview = normalized.slice(0, FIRST_PROMPT_TITLE_LIMIT - 3)
    const breakPoint = preview.lastIndexOf(' ')

    if (breakPoint > Math.floor(FIRST_PROMPT_TITLE_LIMIT / 2)) {
      return `${preview.slice(0, breakPoint).trimEnd()}...`
    }

    return `${preview.trimEnd()}...`
  }

  private applyFirstPromptTitle(id: string, title: string): void {
    const config = this.configs.get(id)
    if (!config?.pendingFirstPromptTitle) {
      return
    }

    const timestamp = new Date().toISOString()
    const nextConfig: SessionConfig = {
      ...config,
      title,
      pendingFirstPromptTitle: false,
      updatedAt: timestamp,
    }

    this.configs.set(id, nextConfig)
    this.touchProject(config.projectId, timestamp)
    this.persist()
    this.events.onConfig({
      sessionId: id,
      config: nextConfig,
    })
  }

  private resolveProjectForCreate(input: CreateSessionInput): ProjectConfig {
    if (input.projectId) {
      return this.requireProject(input.projectId)
    }

    const fallbackRootPath = input.cwd?.trim() || os.homedir()
    const rootPath = resolveProjectRoot(input.projectRootPath, fallbackRootPath)
    const existingProject = this.findProjectByRootPath(rootPath)
    if (existingProject) {
      return existingProject
    }

    const now = new Date().toISOString()
    const project: ProjectConfig = {
      id: crypto.randomUUID(),
      title: deriveProjectTitle(input.projectTitle, rootPath),
      rootPath,
      createdAt: now,
      updatedAt: now,
    }

    this.projects.set(project.id, project)
    return project
  }

  private resolveProjectForHydration(
    projectId: string | undefined,
    rootPath: string,
    config: StoredSessionConfig,
  ): ProjectConfig {
    if (projectId) {
      const project = this.projects.get(projectId)
      if (project) {
        return project
      }
    }

    const existingProject = this.findProjectByRootPath(rootPath)
    if (existingProject) {
      return existingProject
    }

    const createdAt = config.createdAt ?? new Date().toISOString()
    const project: ProjectConfig = {
      id: projectId ?? crypto.randomUUID(),
      title: deriveProjectTitle(undefined, rootPath),
      rootPath,
      createdAt,
      updatedAt: config.updatedAt ?? createdAt,
    }

    this.projects.set(project.id, project)
    return project
  }

  private requireProject(id: string): ProjectConfig {
    const project = this.projects.get(id)
    if (!project) {
      throw new Error(`Unknown project: ${id}`)
    }

    return project
  }

  private touchProject(id: string, timestamp = new Date().toISOString()): void {
    const project = this.projects.get(id)
    if (!project) {
      return
    }

    this.projects.set(id, {
      ...project,
      updatedAt: timestamp,
    })
  }

  private touchRuntime(id: string): SessionRuntime {
    return this.setRuntime(id, {})
  }

  private setRuntime(
    id: string,
    patch: Partial<Omit<SessionRuntime, 'sessionId'>>,
  ): SessionRuntime {
    const current = this.runtimes.get(id) ?? buildRuntime(id)
    const nextRuntime: SessionRuntime = {
      ...current,
      ...patch,
      sessionId: id,
      lastActiveAt: new Date().toISOString(),
    }

    this.runtimes.set(id, nextRuntime)
    this.events.onRuntime({
      sessionId: id,
      runtime: nextRuntime,
    })
    return nextRuntime
  }

  private snapshotFor(id: string): SessionSnapshot {
    return {
      config: this.requireConfig(id),
      runtime: this.runtimes.get(id) ?? buildRuntime(id),
    }
  }

  private projectSnapshotFor(id: string): ProjectSnapshot {
    const project = this.requireProject(id)

    return {
      config: project,
      sessions: this.getOrderedConfigs(project.id).map((config) =>
        this.snapshotFor(config.id),
      ),
    }
  }

  private requireConfig(id: string): SessionConfig {
    const config = this.configs.get(id)
    if (!config) {
      throw new Error(`Unknown session: ${id}`)
    }

    return config
  }

  private getOrderedProjects(): ProjectConfig[] {
    return Array.from(this.projects.values())
      .sort((left, right) => {
        const lastRight = this.getProjectSortValue(right.id)
        const lastLeft = this.getProjectSortValue(left.id)

        return (
          lastRight.localeCompare(lastLeft) ||
          left.title.localeCompare(right.title)
        )
      })
  }

  private getOrderedConfigs(projectId?: string): SessionConfig[] {
    return Array.from(this.configs.values())
      .filter((config) => !projectId || config.projectId === projectId)
      .sort((left, right) => {
        const lastRight = this.getSessionSortValue(right.id, right.updatedAt)
        const lastLeft = this.getSessionSortValue(left.id, left.updatedAt)

        return (
          lastRight.localeCompare(lastLeft) ||
          left.title.localeCompare(right.title)
        )
      })
  }

  private getProjectSortValue(projectId: string): string {
    const mostRecentSession = this.getOrderedConfigs(projectId)[0]
    if (mostRecentSession) {
      return this.getSessionSortValue(
        mostRecentSession.id,
        mostRecentSession.updatedAt,
      )
    }

    return this.projects.get(projectId)?.updatedAt ?? ''
  }

  private getSessionSortValue(id: string, fallbackValue: string): string {
    return this.runtimes.get(id)?.lastActiveAt ?? fallbackValue
  }

  private findProjectByRootPath(rootPath: string): ProjectConfig | undefined {
    const targetPath = this.normalizePath(rootPath)

    return Array.from(this.projects.values()).find(
      (project) => this.normalizePath(project.rootPath) === targetPath,
    )
  }

  private persist(): void {
    this.store.set({
      projects: Array.from(this.projects.values()),
      sessions: Array.from(this.configs.values()),
      activeSessionId: this.activeSessionId,
    })
  }

  private normalizePath(value: string): string {
    return value.trim().replace(/[\\/]+$/, '').toLowerCase()
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return 'Unknown error'
  }
}
