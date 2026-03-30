import { readFileSync, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import Store from 'electron-store'

import type {
  ProjectArchitectureAnalysisResult,
  ProjectSessionsAnalysisResult,
} from '../src/shared/ipc'
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
  type SessionAttentionKind,
  type SessionExitMeta,
  type SessionRuntime,
  type SessionRuntimeEvent,
  type SessionSnapshot,
} from '../src/shared/session'
import {
  extractTerminalAttentionFromText,
  reduceCodexAttentionState,
  reduceCopilotAttentionState,
} from '../src/shared/sessionAttention'
import type {
  ProjectLocation,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import {
  buildCopilotResumeCommand,
  extractCopilotSessionMeta,
  supportsCopilotSessionResume,
} from './copilotCli'
import {
  buildCodexResumeCommand,
  extractCodexSessionMeta,
  supportsCodexSessionResume,
  withCodexDangerousBypass,
} from './codexCli'
import type { ProjectLocationIdentity } from './projectIdentity'
import type { ProjectMemoryService } from './projectMemoryService'
import { createProjectSessionWorktree } from './projectWorktree'
import type { TranscriptStore } from './transcriptStore'
import {
  buildShellArgs,
  resolveShellCommand,
  supportsInlineShellCommand,
} from './windowsShell'
import { killTerminalProcessTree } from './ptyProcessTree'

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

interface ExternalSessionAttentionTracker {
  provider: 'codex' | 'copilot'
  externalSessionId: string
  filePath: string
  interval: NodeJS.Timeout
  offset: number
  remainder: string
  polling: boolean
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
const HISTORICAL_EXTERNAL_SESSION_FILE_LIMIT = 256
const EXTERNAL_SESSION_MATCH_START_TOLERANCE_MS = 1_000
const HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000
const EXTERNAL_SESSION_TITLE_SCAN_BYTES = 131_072
const FIRST_PROMPT_TITLE_LIMIT = 80
const BACKGROUND_IDENTITY_REFRESH_DELAY_MS = 1_500
const BACKGROUND_MEMORY_BACKFILL_DELAY_MS = 4_500
const EXTERNAL_ATTENTION_POLL_INTERVAL_MS = 1_500
const LIVE_ATTENTION_BUFFER_LIMIT = 4_096
const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'gu',
)
const EXTERNAL_ATTENTION_HISTORY_SCAN_BYTES = 512 * 1024

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
  locations: ProjectLocation[]
  sessions: StoredSessionConfig[]
  runtimes: Array<Pick<SessionRuntime, 'sessionId' | 'lastActiveAt'>>
  activeSessionId: string | null
}

interface SessionManagerEvents {
  onData: (event: SessionDataEvent) => void
  onConfig: (event: SessionConfigEvent) => void
  onRuntime: (event: SessionRuntimeEvent) => void
  onExit: (event: SessionExitMeta) => void
}

interface SessionManagerServices {
  identityResolver?: {
    inspect: (rootPath: string) => Promise<ProjectLocationIdentity>
  }
  transcriptStore?: Pick<TranscriptStore, 'append'>
  projectMemory?: Pick<
    ProjectMemoryService,
    | 'analyzeHistoricalArchitecture'
    | 'analyzeHistoricalSessions'
    | 'assembleContext'
    | 'captureSession'
    | 'scheduleBackfillSessions'
    | 'dispose'
  > & {
    refreshHistoricalImport?: ProjectMemoryService['refreshHistoricalImport']
  }
}

const defaultIdentityResolver: NonNullable<SessionManagerServices['identityResolver']> = {
  inspect: async (rootPath) => {
    const normalizedRootPath = rootPath.trim().replace(/[\\/]+$/, '')
    return {
      rootPath: normalizedRootPath,
      label: path.basename(normalizedRootPath) || normalizedRootPath,
      repoRoot: null,
      gitCommonDir: null,
      remoteFingerprint: null,
    }
  },
}

const noopTranscriptStore: NonNullable<SessionManagerServices['transcriptStore']> = {
  append: async () => undefined,
}

const noopProjectMemory: NonNullable<SessionManagerServices['projectMemory']> = {
  assembleContext: async (input) => ({
    projectId: input.project.id,
    locationId: input.location?.id ?? null,
    generatedAt: new Date().toISOString(),
    bootstrapMessage: null,
    fileReferences: [],
    summaryExcerpt: null,
  }),
  captureSession: async () => undefined,
  scheduleBackfillSessions: () => undefined,
  refreshHistoricalImport: async () => ({
    cleanedProjectCount: 0,
    removedEmptySummaryCount: 0,
    prunedCandidateCount: 0,
    regeneratedArchitectureCount: 0,
  }),
  analyzeHistoricalArchitecture: async () => ({
    analyzedProjectCount: 0,
  }),
  analyzeHistoricalSessions: async () => ({
    analyzedProjectCount: 0,
    analyzedSessionCount: 0,
    skippedSessionCount: 0,
    cleanedProjectCount: 0,
    removedEmptySummaryCount: 0,
    prunedCandidateCount: 0,
  }),
  dispose: () => undefined,
}

export class SessionManager {
  private readonly store = new Store<PersistedSessionState>({
    name: 'agenclis-sessions',
    defaults: {
      projects: [],
      locations: [],
      sessions: [],
      runtimes: [],
      activeSessionId: null,
    },
  })

  private readonly projects = new Map<string, ProjectConfig>()
  private readonly locations = new Map<string, ProjectLocation>()
  private readonly configs = new Map<string, SessionConfig>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly terminals = new Map<string, IPty>()
  private readonly pendingFirstPromptBuffers = new Map<string, string>()
  private readonly liveAttentionBuffers = new Map<string, string>()
  private readonly claimedExternalSessions = new Map<string, string>()
  private readonly pendingExternalSessionDetections = new Map<string, NodeJS.Timeout>()
  private readonly externalSessionAttentionTrackers = new Map<
    string,
    ExternalSessionAttentionTracker
  >()
  private readonly historicalExternalSessionRecovery = new Set<string>()
  private readonly suppressedExit = new Set<string>()
  private readonly pendingQueryBootstrapSessions = new Set<string>()
  private readonly events: SessionManagerEvents
  private readonly identityResolver: NonNullable<SessionManagerServices['identityResolver']>
  private readonly transcriptStore: NonNullable<SessionManagerServices['transcriptStore']>
  private readonly projectMemory: NonNullable<SessionManagerServices['projectMemory']>

  private activeSessionId: string | null
  private restored = false
  private identityRefreshTimer: NodeJS.Timeout | null = null
  private memoryBackfillTimer: NodeJS.Timeout | null = null

  constructor(events: SessionManagerEvents, services: SessionManagerServices = {}) {
    this.events = events
    this.identityResolver = services.identityResolver ?? defaultIdentityResolver
    this.transcriptStore = services.transcriptStore ?? noopTranscriptStore
    this.projectMemory = services.projectMemory ?? noopProjectMemory
    const persisted = this.store.store
    this.activeSessionId = persisted.activeSessionId
    const persistedRuntimes = new Map(
      (persisted.runtimes ?? [])
        .filter(
          (runtime): runtime is Pick<SessionRuntime, 'sessionId' | 'lastActiveAt'> =>
            typeof runtime?.sessionId === 'string' &&
            typeof runtime?.lastActiveAt === 'string' &&
            runtime.lastActiveAt.length > 0,
        )
        .map((runtime) => [runtime.sessionId, runtime]),
    )

    for (const project of persisted.projects ?? []) {
      const hydratedProject = this.hydrateProjectConfig(project)
      this.projects.set(hydratedProject.id, hydratedProject)
    }

    for (const location of persisted.locations ?? []) {
      const hydratedLocation = this.hydrateProjectLocation(location)
      this.locations.set(hydratedLocation.id, hydratedLocation)
    }

    let shouldPersist = false

    for (const project of Array.from(this.projects.values())) {
      if (this.ensureProjectPrimaryLocation(project.id)) {
        shouldPersist = true
      }
    }

    if (this.splitLegacyMultiLocationProjects()) {
      shouldPersist = true
    }

    for (const project of Array.from(this.projects.values())) {
      if (this.ensureProjectPrimaryLocation(project.id)) {
        shouldPersist = true
      }
    }

    for (const config of persisted.sessions ?? []) {
      const hydratedConfig = this.hydrateSessionConfig(config)
      const persistedRuntime = persistedRuntimes.get(hydratedConfig.id)
      const restoredLastActiveAt =
        persistedRuntime?.lastActiveAt ||
        hydratedConfig.updatedAt ||
        hydratedConfig.createdAt
      this.configs.set(hydratedConfig.id, hydratedConfig)
      this.runtimes.set(
        hydratedConfig.id,
        buildRuntime(hydratedConfig.id, 'exited', restoredLastActiveAt),
      )
      this.claimExternalSession(hydratedConfig)
      this.trackHistoricalExternalSessionRecovery(hydratedConfig)

      if (
        persistedRuntime?.lastActiveAt !== restoredLastActiveAt ||
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
      this.scheduleBackgroundProjectMaintenance()

      for (const config of this.getOrderedConfigs()) {
        await this.ensureSessionStarted(config.id)
      }
    }

    return this.listSessions()
  }

  getProjectConfigs(): ProjectConfig[] {
    return Array.from(this.projects.values())
  }

  getBackfillInputs(): Array<{
    project: ProjectConfig
    location: ProjectLocation | null
    session: SessionConfig
  }> {
    return this.collectBackfillInputs()
  }

  async ensureProjectIdentity(): Promise<void> {
    await this.refreshStoredProjectIdentity()
  }

  scheduleProjectMemoryBackfill(): void {
    if (this.memoryBackfillTimer) {
      return
    }

    this.memoryBackfillTimer = setTimeout(() => {
      this.memoryBackfillTimer = null
      this.projectMemory.scheduleBackfillSessions(this.collectBackfillInputs())
    }, BACKGROUND_MEMORY_BACKFILL_DELAY_MS)
  }

  async analyzeHistoricalProjectArchitecture(): Promise<ProjectArchitectureAnalysisResult> {
    await this.refreshStoredProjectIdentity()
    return await this.projectMemory.analyzeHistoricalArchitecture(
      Array.from(this.projects.values()),
    )
  }

  async analyzeHistoricalProjectSessions(): Promise<ProjectSessionsAnalysisResult> {
    await this.refreshStoredProjectIdentity()
    const refreshResult = await this.projectMemory.refreshHistoricalImport?.(
      Array.from(this.projects.values()),
      {
        regenerateArchitecture: false,
      },
    )
    const analysisResult = await this.projectMemory.analyzeHistoricalSessions(
      this.collectBackfillInputs(),
    )

    return {
      analyzedProjectCount: analysisResult.analyzedProjectCount,
      analyzedSessionCount: analysisResult.analyzedSessionCount,
      skippedSessionCount: analysisResult.skippedSessionCount,
      cleanedProjectCount: refreshResult?.cleanedProjectCount ?? 0,
      removedEmptySummaryCount: refreshResult?.removedEmptySummaryCount ?? 0,
      prunedCandidateCount: refreshResult?.prunedCandidateCount ?? 0,
    }
  }

  async createProject(input: CreateProjectInput): Promise<ProjectSnapshot> {
    const rootPath = input.rootPath.trim()
    if (!rootPath) {
      throw new Error('Project root path is required.')
    }

    const now = new Date().toISOString()
    const inspectedLocation = await this.identityResolver.inspect(rootPath)
    const existingProject = this.findProjectByRootPath(inspectedLocation.rootPath)
    if (existingProject) {
      this.upsertProjectLocation(existingProject.id, inspectedLocation, now, true)
      this.touchProject(existingProject.id, now)
      this.persist()
      return this.projectSnapshotFor(existingProject.id)
    }

    const project: ProjectConfig = {
      id: crypto.randomUUID(),
      title: deriveProjectTitle(input.title, inspectedLocation.rootPath),
      rootPath: inspectedLocation.rootPath,
      createdAt: now,
      updatedAt: now,
      primaryLocationId: null,
      identity: {
        repoRoot: inspectedLocation.repoRoot,
        gitCommonDir: inspectedLocation.gitCommonDir,
        remoteFingerprint: inspectedLocation.remoteFingerprint,
      },
    }

    this.projects.set(project.id, project)
    this.upsertProjectLocation(project.id, inspectedLocation, now, true)
    this.persist()
    return this.projectSnapshotFor(project.id)
  }

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    const now = new Date().toISOString()
    const { project, location } = await this.resolveProjectForCreate(input, now)
    const id = crypto.randomUUID()
    const shell = resolveShellCommand()
    const cwd = input.createWithWorktree
      ? (
          await createProjectSessionWorktree({
            projectRootPath: location.rootPath,
            sessionId: id,
            createdAt: now,
          })
        ).cwd
      : resolveSessionCwd(input.cwd, location.rootPath)

    const config: SessionConfig = {
      id,
      projectId: project.id,
      locationId: location.id,
      title: deriveSessionTitle(input.title, input.startupCommand, cwd),
      startupCommand: input.startupCommand.trim(),
      pendingFirstPromptTitle: this.shouldCaptureFirstPromptTitle(
        input.startupCommand,
        input.title,
      ),
      permissionLevel: input.permissionLevel,
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
    this.appendTranscriptEvent({
      sessionId: id,
      kind: 'system',
      source: 'system',
      chunk: `Session created for ${project.title}.`,
    })

    await this.startSession(config)
    if (input.attachProjectContext) {
      this.scheduleProjectContextBootstrap(config.id)
    }
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
    if (!this.acknowledgeSessionAttention(id)) {
      this.touchRuntime(id)
    }
    this.persist()
    await this.ensureSessionStarted(id)
  }

  async restartSession(id: string): Promise<SessionSnapshot> {
    const config = this.requireConfig(id)
    await this.startSession(config)
    return this.snapshotFor(id)
  }

  async closeSession(id: string): Promise<SessionCloseResult> {
    const orderedIds = this.getOrderedConfigs().map((config) => config.id)
    const closingIndex = orderedIds.indexOf(id)
    if (closingIndex === -1) {
      throw new Error(`Unknown session: ${id}`)
    }

    const closingConfig = this.requireConfig(id)
    this.appendTranscriptEvent({
      sessionId: id,
      kind: 'system',
      source: 'system',
      chunk: 'Session closed by agentclis.',
    })
    void this.queueProjectMemoryCapture(closingConfig)

    this.stopSession(id, true)
    this.cancelExternalSessionDetection(id)
    this.stopExternalSessionAttentionTracking(id)
    this.pendingFirstPromptBuffers.delete(id)
    this.pendingQueryBootstrapSessions.delete(id)
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

    const nextActiveSessionId = this.activeSessionId
    this.persist()

    if (nextActiveSessionId) {
      await this.ensureSessionStarted(nextActiveSessionId)
    }

    return {
      closedSessionId: id,
      activeSessionId: nextActiveSessionId,
    }
  }

  writeToSession(id: string, data: string): void {
    this.writeToSessionInternal(id, data, 'user')
  }

  resizeSession(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id)
    if (!terminal || cols < 2 || rows < 1) {
      return
    }

    terminal.resize(Math.floor(cols), Math.floor(rows))
  }

  dispose(): void {
    if (this.identityRefreshTimer) {
      clearTimeout(this.identityRefreshTimer)
      this.identityRefreshTimer = null
    }
    if (this.memoryBackfillTimer) {
      clearTimeout(this.memoryBackfillTimer)
      this.memoryBackfillTimer = null
    }

    for (const sessionId of Array.from(
      this.pendingExternalSessionDetections.keys(),
    )) {
      this.cancelExternalSessionDetection(sessionId)
    }

    for (const sessionId of Array.from(
      this.externalSessionAttentionTrackers.keys(),
    )) {
      this.stopExternalSessionAttentionTracking(sessionId)
    }

    for (const config of Array.from(this.configs.values())) {
      void this.queueProjectMemoryCapture(config)
    }

    for (const id of Array.from(this.terminals.keys())) {
      this.stopSession(id, true)
    }

    this.projectMemory.dispose()
  }

  private async startSession(config: SessionConfig): Promise<void> {
    this.stopSession(config.id, true)
    this.cancelExternalSessionDetection(config.id)
    this.stopExternalSessionAttentionTracking(config.id)
    this.pendingFirstPromptBuffers.delete(config.id)
    this.pendingQueryBootstrapSessions.delete(config.id)
    this.clearLiveAttentionBuffer(config.id)
    this.setRuntime(config.id, {
      attention: null,
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
      if (normalizedConfig.externalSession) {
        void this.ensureExternalSessionAttentionTracking(normalizedConfig)
      }

      // Capture immutable sessionId to prevent stale closure references when
      // normalizedConfig is reassigned during concurrent session startups.
      const sessionId = config.id

      terminal.onData((chunk) => {
        if (this.terminals.get(sessionId) !== terminal) {
          return
        }

        this.appendTranscriptEvent({
          sessionId,
          kind: 'output',
          source: 'pty',
          chunk,
        })
        this.processLiveSessionOutputAttention(sessionId, chunk)
        this.events.onData({
          sessionId,
          chunk,
        })
      })

      terminal.onExit(({ exitCode }) => {
        if (this.terminals.get(sessionId) !== terminal) {
          return
        }

        this.terminals.delete(sessionId)
        this.clearLiveAttentionBuffer(sessionId)
        this.cancelExternalSessionDetection(sessionId)

        if (this.suppressedExit.delete(sessionId)) {
          return
        }

        const status = exitCode === 0 ? 'exited' : 'error'
        this.setRuntime(sessionId, {
          status,
          pid: undefined,
          exitCode,
        })
        this.appendTranscriptEvent({
          sessionId,
          kind: 'system',
          source: 'system',
          chunk: `Session exited with code ${exitCode}.`,
        })
        const exitConfig = this.configs.get(sessionId)
        if (exitConfig) {
          void this.queueProjectMemoryCapture(exitConfig)
        }
        this.events.onExit({
          sessionId,
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
          this.writeToTerminal(sessionId, `${launchCommand}\r`)
        }

        if (externalSessionProvider) {
          void this.pollForExternalSessionRef(
            sessionId,
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
      this.appendTranscriptEvent({
        sessionId: config.id,
        kind: 'system',
        source: 'system',
        chunk: `Failed to start session: ${this.getErrorMessage(error)}`,
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
      this.liveAttentionBuffers.delete(id)
      return
    }

    if (suppressExit) {
      this.suppressedExit.add(id)
    }

    this.terminals.delete(id)
    this.liveAttentionBuffers.delete(id)
    try {
      killTerminalProcessTree(terminal)
    } catch {
      this.suppressedExit.delete(id)
    }
  }

  private clearLiveAttentionBuffer(id: string): void {
    this.liveAttentionBuffers.delete(id)
  }

  private processLiveSessionOutputAttention(id: string, chunk: string): void {
    const sanitizedChunk = chunk.replace(ANSI_ESCAPE_REGEX, '')
    if (!sanitizedChunk) {
      return
    }

    const nextBuffer = `${this.liveAttentionBuffers.get(id) ?? ''}${sanitizedChunk}`
      .slice(-LIVE_ATTENTION_BUFFER_LIMIT)
    this.liveAttentionBuffers.set(id, nextBuffer)

    const attention = extractTerminalAttentionFromText(nextBuffer)
    if (!attention) {
      return
    }

    this.setSessionAttention(id, attention)
  }

  private resolveStartupCommand(config: SessionConfig): string {
    if (config.externalSession?.provider === 'codex') {
      return this.applyPermissionFlags(
        buildCodexResumeCommand(
          config.startupCommand,
          config.externalSession.sessionId,
        ) ?? config.startupCommand,
        config,
      )
    }

    if (config.externalSession?.provider === 'copilot') {
      return this.applyPermissionFlags(
        buildCopilotResumeCommand(
          config.startupCommand,
          config.externalSession.sessionId,
        ) ?? config.startupCommand,
        config,
      )
    }

    return this.applyPermissionFlags(config.startupCommand, config)
  }

  private applyPermissionFlags(
    command: string,
    config: SessionConfig,
  ): string {
    if (config.permissionLevel !== 'full-access') {
      return command
    }

    const provider = this.detectResumableProvider(command)
    if (provider === 'copilot' && !command.includes('--no-ask-user')) {
      return `${command} --no-ask-user`
    }

    if (
      provider === 'codex'
    ) {
      return withCodexDangerousBypass(command) ?? command
    }

    return command
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

  private shouldAllowHistoricalExternalSessionMatching(
    config: SessionConfig,
  ): boolean {
    if (this.historicalExternalSessionRecovery.has(config.id)) {
      return true
    }

    return this.isExplicitResumeCommand(config.startupCommand)
  }

  private isExplicitResumeCommand(command: string): boolean {
    if (
      supportsCodexSessionResume(command) &&
      /\b(?:resume|fork)\b/u.test(command)
    ) {
      return true
    }

    return (
      supportsCopilotSessionResume(command) &&
      /(^|\s)--(?:resume|continue)(?:\s|=|$)/u.test(command)
    )
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
      if (this.shouldAllowHistoricalExternalSessionMatching(config)) {
        const historicalSession = await this.findHistoricalExternalSession(
          config,
          provider,
        )
        if (historicalSession) {
          this.attachExternalSession(config, historicalSession)
        }
      }
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
    const allowHistoricalMatch =
      this.shouldAllowHistoricalExternalSessionMatching(config)
    const earliestAllowedStart =
      startedAt - EXTERNAL_SESSION_MATCH_START_TOLERANCE_MS

    const match = candidates
      .filter((candidate) => this.isEligibleExternalSessionCandidate(candidate))
      .filter((candidate) => this.normalizePath(candidate.cwd) === normalizedCwd)
      .filter(
        (candidate) =>
          allowHistoricalMatch || candidate.startedAt >= earliestAllowedStart,
      )
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
      HISTORICAL_EXTERNAL_SESSION_FILE_LIMIT,
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

    const sorted = scoredCandidates
      .sort((left, right) => {
        if (left.titleMatches !== right.titleMatches) {
          return left.titleMatches ? -1 : 1
        }

        return (
          left.distance - right.distance ||
          right.candidate.startedAt - left.candidate.startedAt
        )
      })

    const best = sorted[0]
    if (!best) {
      return null
    }

    // When the session has a meaningful title, require a title match to
    // prevent cross-session bleed between sessions that share the same CWD.
    if (shouldMatchTitle && !best.titleMatches) {
      return null
    }

    return best.candidate
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
    limit = CODEX_SESSION_DISCOVERY_FILE_LIMIT,
  ): Promise<DetectedExternalSession[]> {
    if (provider === 'copilot') {
      return this.listRecentCopilotSessions(sinceMs, limit)
    }

    const candidateFiles = await this.listRecentCodexSessionFiles(sinceMs, limit)
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
    limit = CODEX_SESSION_DISCOVERY_FILE_LIMIT,
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
      .slice(0, limit)) {
      const sessionMeta = await this.readCopilotSessionMeta(candidate.workspaceFilePath)
      if (sessionMeta) {
        sessions.push(sessionMeta)
      }
    }

    return sessions
  }

  private async listRecentCodexSessionFiles(
    sinceMs: number,
    limit = CODEX_SESSION_DISCOVERY_FILE_LIMIT,
  ): Promise<string[]> {
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
      .slice(0, limit)
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

  private async readFileTail(
    filePath: string,
    byteLimit: number,
  ): Promise<string | null> {
    let handle

    try {
      const details = await stat(filePath)
      const size = details.size
      if (size <= 0) {
        return null
      }

      handle = await open(filePath, 'r')
      const bytesToRead = Math.min(size, byteLimit)
      const startOffset = Math.max(0, size - bytesToRead)
      const buffer = Buffer.alloc(bytesToRead)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, startOffset)
      const content = buffer.toString('utf8', 0, bytesRead)

      if (startOffset === 0) {
        return content
      }

      const firstNewlineIndex = content.search(/\r?\n/u)
      if (firstNewlineIndex === -1) {
        return null
      }

      return content.slice(firstNewlineIndex + 1)
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
    void this.ensureExternalSessionAttentionTracking(
      nextConfig,
      detectedSession.sourcePath,
    )
  }

  private async ensureExternalSessionAttentionTracking(
    config: SessionConfig,
    sourcePath?: string,
  ): Promise<void> {
    if (!config.externalSession) {
      this.stopExternalSessionAttentionTracking(config.id)
      return
    }

    const filePath =
      sourcePath ??
      (await this.resolveExternalSessionAttentionFilePath(
        config.externalSession.provider,
        config.externalSession.sessionId,
      ))
    if (!filePath) {
      return
    }

    const existingTracker = this.externalSessionAttentionTrackers.get(config.id)
    if (
      existingTracker &&
      existingTracker.provider === config.externalSession.provider &&
      existingTracker.externalSessionId === config.externalSession.sessionId &&
      existingTracker.filePath === filePath
    ) {
      return
    }

    let initialOffset = 0
    let initialAttention: SessionAttentionKind | null = null
    try {
      const details = await stat(filePath)
      initialOffset = details.size
      initialAttention = await this.readPersistedExternalSessionAttention(
        config.externalSession.provider,
        filePath,
      )
    } catch {
      return
    }

    this.stopExternalSessionAttentionTracking(config.id)
    if (initialAttention) {
      this.setSessionAttention(config.id, initialAttention)
    }
    const interval = setInterval(() => {
      void this.pollExternalSessionAttention(config.id)
    }, EXTERNAL_ATTENTION_POLL_INTERVAL_MS)

    this.externalSessionAttentionTrackers.set(config.id, {
      provider: config.externalSession.provider,
      externalSessionId: config.externalSession.sessionId,
      filePath,
      interval,
      offset: initialOffset,
      remainder: '',
      polling: false,
    })
  }

  private async readPersistedExternalSessionAttention(
    provider: 'codex' | 'copilot',
    filePath: string,
  ): Promise<SessionAttentionKind | null> {
    const content = await this.readFileTail(
      filePath,
      EXTERNAL_ATTENTION_HISTORY_SCAN_BYTES,
    )
    if (!content) {
      return null
    }

    let attention: SessionAttentionKind | null = null
    const lines = content.split(/\r?\n/u)
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }

      attention =
        provider === 'codex'
          ? reduceCodexAttentionState(attention, line)
          : reduceCopilotAttentionState(attention, line)
    }

    return attention
  }

  private stopExternalSessionAttentionTracking(sessionId: string): void {
    const tracker = this.externalSessionAttentionTrackers.get(sessionId)
    if (!tracker) {
      return
    }

    clearInterval(tracker.interval)
    this.externalSessionAttentionTrackers.delete(sessionId)
  }

  private async resolveExternalSessionAttentionFilePath(
    provider: 'codex' | 'copilot',
    sessionId: string,
  ): Promise<string | null> {
    if (provider === 'copilot') {
      const filePath = path.join(COPILOT_SESSIONS_ROOT, sessionId, 'events.jsonl')
      try {
        return (await stat(filePath)).isFile() ? filePath : null
      } catch {
        return null
      }
    }

    const dayDirectories = this.getCodexSessionDayDirectories(
      Date.now() - HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS,
    )

    for (const dayDirectory of dayDirectories) {
      let entries: Dirent[] = []
      try {
        entries = await readdir(dayDirectory, { withFileTypes: true })
      } catch {
        continue
      }

      const matchingEntry = entries.find(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(`${sessionId}.jsonl`),
      )
      if (!matchingEntry) {
        continue
      }

      return path.join(dayDirectory, matchingEntry.name)
    }

    return null
  }

  private async pollExternalSessionAttention(sessionId: string): Promise<void> {
    const tracker = this.externalSessionAttentionTrackers.get(sessionId)
    if (!tracker || tracker.polling) {
      return
    }

    const config = this.configs.get(sessionId)
    if (
      !config?.externalSession ||
      config.externalSession.provider !== tracker.provider ||
      config.externalSession.sessionId !== tracker.externalSessionId
    ) {
      this.stopExternalSessionAttentionTracking(sessionId)
      return
    }

    tracker.polling = true
    let handle: Awaited<ReturnType<typeof open>> | null = null

    try {
      const details = await stat(tracker.filePath)
      if (details.size < tracker.offset) {
        tracker.offset = 0
        tracker.remainder = ''
      }

      if (details.size <= tracker.offset) {
        return
      }

      const length = details.size - tracker.offset
      const buffer = Buffer.alloc(length)
      handle = await open(tracker.filePath, 'r')
      await handle.read(buffer, 0, length, tracker.offset)
      tracker.offset = details.size

      const nextChunk = `${tracker.remainder}${buffer.toString('utf8')}`
      const lines = nextChunk.split(/\r?\n/u)
      tracker.remainder = lines.pop() ?? ''

      for (const line of lines) {
        this.processExternalSessionAttentionLine(sessionId, tracker.provider, line)
      }
    } catch {
      return
    } finally {
      tracker.polling = false
      await handle?.close().catch(() => undefined)
    }
  }

  private processExternalSessionAttentionLine(
    sessionId: string,
    provider: 'codex' | 'copilot',
    line: string,
  ): void {
    if (!line.trim()) {
      return
    }

    const currentAttention = this.runtimes.get(sessionId)?.attention ?? null
    const nextAttention =
      provider === 'codex'
        ? reduceCodexAttentionState(currentAttention, line)
        : reduceCopilotAttentionState(currentAttention, line)
    if (nextAttention === currentAttention) {
      return
    }

    this.setSessionAttention(sessionId, nextAttention)
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

  private hydrateProjectConfig(project: ProjectConfig): ProjectConfig {
    const rootPath = resolveProjectRoot(project.rootPath, os.homedir())
    return {
      ...project,
      title: deriveProjectTitle(project.title, rootPath),
      rootPath,
      primaryLocationId:
        typeof project.primaryLocationId === 'string'
          ? project.primaryLocationId
          : null,
      identity: {
        repoRoot:
          typeof project.identity?.repoRoot === 'string'
            ? project.identity.repoRoot
            : null,
        gitCommonDir:
          typeof project.identity?.gitCommonDir === 'string'
            ? project.identity.gitCommonDir
            : null,
        remoteFingerprint:
          typeof project.identity?.remoteFingerprint === 'string'
            ? project.identity.remoteFingerprint
            : null,
      },
    }
  }

  private hydrateProjectLocation(location: ProjectLocation): ProjectLocation {
    const rootPath = resolveProjectRoot(location.rootPath, os.homedir())
    return {
      ...location,
      rootPath,
      label: location.label?.trim() || path.basename(rootPath) || rootPath,
      repoRoot: typeof location.repoRoot === 'string' ? location.repoRoot : null,
      gitCommonDir:
        typeof location.gitCommonDir === 'string' ? location.gitCommonDir : null,
      remoteFingerprint:
        typeof location.remoteFingerprint === 'string'
          ? location.remoteFingerprint
          : null,
      lastSeenAt: location.lastSeenAt || location.updatedAt || location.createdAt,
    }
  }

  private ensureProjectPrimaryLocation(projectId: string): boolean {
    const project = this.projects.get(projectId)
    if (!project) {
      return false
    }

    const currentPrimary =
      project.primaryLocationId && this.locations.get(project.primaryLocationId)
    if (currentPrimary) {
      const nextProject = {
        ...project,
        rootPath: currentPrimary.rootPath,
      }
      this.projects.set(projectId, nextProject)
      return nextProject.rootPath !== project.rootPath
    }

    const existingLocation = this.getProjectLocations(projectId)[0]
    if (existingLocation) {
      this.setProjectPrimaryLocation(projectId, existingLocation.id, project.updatedAt)
      return true
    }

    const location = this.upsertProjectLocation(
      projectId,
      {
        rootPath: project.rootPath,
        label: path.basename(project.rootPath) || project.rootPath,
        repoRoot: project.identity?.repoRoot ?? null,
        gitCommonDir: project.identity?.gitCommonDir ?? null,
        remoteFingerprint: project.identity?.remoteFingerprint ?? null,
      },
      project.updatedAt,
      true,
    )

    return Boolean(location)
  }

  private hydrateSessionConfig(config: StoredSessionConfig): SessionConfig {
    const cwd = resolveSessionCwd(config.cwd, os.homedir())
    const title = this.resolveHydratedSessionTitle(config, cwd)
    const project = this.resolveProjectForHydration(config.projectId, cwd, config)
    const location = this.resolveLocationForHydration(project, config)

    return {
      ...config,
      projectId: project.id,
      locationId: location.id,
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
    this.scheduleDeferredQueryBootstrap(id, title)
  }

  private async resolveProjectForCreate(
    input: CreateSessionInput,
    timestamp: string,
  ): Promise<{
    project: ProjectConfig
    location: ProjectLocation
  }> {
    if (input.projectId) {
      const project = this.requireProject(input.projectId)
      const projectRootPath = resolveProjectRoot(input.projectRootPath, project.rootPath)
      const inspectedLocation = await this.identityResolver.inspect(projectRootPath)
      const location = this.upsertProjectLocation(
        project.id,
        inspectedLocation,
        timestamp,
        !input.createWithWorktree,
      )
      return {
        project: this.requireProject(project.id),
        location,
      }
    }

    const fallbackRootPath = input.cwd?.trim() || os.homedir()
    const rootPath = resolveProjectRoot(input.projectRootPath, fallbackRootPath)
    const inspectedLocation = await this.identityResolver.inspect(rootPath)
    const existingProject = this.findProjectByRootPath(inspectedLocation.rootPath)
    if (existingProject) {
      return {
        project: this.requireProject(existingProject.id),
        location: this.upsertProjectLocation(
          existingProject.id,
          inspectedLocation,
          timestamp,
          true,
        ),
      }
    }

    const project: ProjectConfig = {
      id: crypto.randomUUID(),
      title: deriveProjectTitle(input.projectTitle, inspectedLocation.rootPath),
      rootPath: inspectedLocation.rootPath,
      createdAt: timestamp,
      updatedAt: timestamp,
      primaryLocationId: null,
      identity: {
        repoRoot: inspectedLocation.repoRoot,
        gitCommonDir: inspectedLocation.gitCommonDir,
        remoteFingerprint: inspectedLocation.remoteFingerprint,
      },
    }

    this.projects.set(project.id, project)
    return {
      project: this.requireProject(project.id),
      location: this.upsertProjectLocation(project.id, inspectedLocation, timestamp, true),
    }
  }

  private resolveProjectForHydration(
    projectId: string | undefined,
    rootPath: string,
    config: StoredSessionConfig,
  ): ProjectConfig {
    const locationProjectId = config.locationId
      ? this.locations.get(config.locationId)?.projectId
      : undefined

    if (projectId) {
      const project = this.projects.get(projectId)
      if (project && (!locationProjectId || locationProjectId === projectId)) {
        return project
      }
    }

    if (locationProjectId) {
      const project = this.projects.get(locationProjectId)
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
      primaryLocationId: null,
      identity: {
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: null,
      },
    }

    this.projects.set(project.id, project)
    return project
  }

  private resolveLocationForHydration(
    project: ProjectConfig,
    config: StoredSessionConfig,
  ): ProjectLocation {
    if (config.locationId) {
      const existingLocation = this.locations.get(config.locationId)
      if (existingLocation) {
        return existingLocation
      }
    }

    const primaryLocation =
      project.primaryLocationId && this.locations.get(project.primaryLocationId)
    if (primaryLocation) {
      return primaryLocation
    }

    return this.upsertProjectLocation(
      project.id,
      {
        rootPath: project.rootPath,
        label: path.basename(project.rootPath) || project.rootPath,
        repoRoot: project.identity?.repoRoot ?? null,
        gitCommonDir: project.identity?.gitCommonDir ?? null,
        remoteFingerprint: project.identity?.remoteFingerprint ?? null,
      },
      config.updatedAt ?? config.createdAt ?? new Date().toISOString(),
      true,
    )
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

  private setSessionAttention(
    id: string,
    attention: SessionAttentionKind | null,
  ): boolean {
    const currentAttention = this.runtimes.get(id)?.attention ?? null
    if (currentAttention === attention) {
      return false
    }

    this.setRuntime(id, {
      attention,
    })
    return true
  }

  private acknowledgeSessionAttention(id: string): boolean {
    if (this.runtimes.get(id)?.attention !== 'task-complete') {
      return false
    }

    return this.setSessionAttention(id, null)
  }

  private clearSessionAttention(id: string): boolean {
    return this.setSessionAttention(id, null)
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
    if (Object.keys(patch).length > 0) {
      this.appendTranscriptEvent({
        sessionId: id,
        kind: 'runtime',
        source: 'system',
        metadata: {
          attention: nextRuntime.attention ?? null,
          status: nextRuntime.status,
          pid: nextRuntime.pid ?? null,
          exitCode: nextRuntime.exitCode ?? null,
        },
      })
    }
    this.events.onRuntime({
      sessionId: id,
      runtime: nextRuntime,
    })
    return nextRuntime
  }

  private writeToSessionInternal(
    id: string,
    data: string,
    source: 'system' | 'user',
  ): void {
    if (source === 'user') {
      this.clearLiveAttentionBuffer(id)
      const attentionCleared = this.clearSessionAttention(id)
      this.capturePendingFirstPromptTitle(id, data)
      if (!attentionCleared) {
        this.touchRuntime(id)
      }
    }

    this.appendTranscriptEvent({
      sessionId: id,
      kind: 'input',
      source,
      chunk: data,
    })
    this.writeToTerminal(id, data)
  }

  private writeToTerminal(id: string, data: string): void {
    this.terminals.get(id)?.write(data)
  }

  private appendTranscriptEvent(
    input: Omit<TranscriptEvent, 'id' | 'locationId' | 'projectId' | 'timestamp'> & {
      locationId?: string | null
      projectId?: string
      timestamp?: string
    },
  ): Promise<void> {
    const config = this.configs.get(input.sessionId)
    const projectId = input.projectId ?? config?.projectId
    if (!projectId) {
      return Promise.resolve()
    }

    const locationId = input.locationId ?? config?.locationId ?? null
    return this.transcriptStore.append({
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      projectId,
      locationId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      chunk: input.chunk,
      metadata: input.metadata,
    })
  }

  private scheduleProjectContextBootstrap(sessionId: string): void {
    setTimeout(() => {
      void this.attachProjectContextBootstrap(sessionId)
    }, 140)
  }

  private scheduleBackgroundProjectMaintenance(): void {
    if (!this.identityRefreshTimer) {
      this.identityRefreshTimer = setTimeout(() => {
        this.identityRefreshTimer = null
        void this.refreshStoredProjectIdentity()
      }, BACKGROUND_IDENTITY_REFRESH_DELAY_MS)
    }

    this.scheduleProjectMemoryBackfill()
  }

  private async refreshStoredProjectIdentity(): Promise<void> {
    let shouldPersist = false

    for (const location of Array.from(this.locations.values())) {
      const needsRefresh =
        !location.repoRoot ||
        !location.gitCommonDir ||
        !location.remoteFingerprint
      if (!needsRefresh) {
        continue
      }

      let inspectedLocation: ProjectLocationIdentity | null = null
      try {
        inspectedLocation = await this.identityResolver.inspect(location.rootPath)
      } catch {
        inspectedLocation = null
      }

      if (!inspectedLocation) {
        continue
      }

      if (this.updateStoredLocationIdentity(location.id, inspectedLocation)) {
        shouldPersist = true
      }
    }

    if (shouldPersist) {
      this.persist()
    }
  }

  private updateStoredLocationIdentity(
    locationId: string,
    inspectedLocation: ProjectLocationIdentity,
  ): boolean {
    const currentLocation = this.locations.get(locationId)
    if (!currentLocation) {
      return false
    }

    const timestamp = new Date().toISOString()
    const nextLocation: ProjectLocation = {
      ...currentLocation,
      rootPath: inspectedLocation.rootPath,
      label: inspectedLocation.label,
      repoRoot: inspectedLocation.repoRoot,
      gitCommonDir: inspectedLocation.gitCommonDir,
      remoteFingerprint: inspectedLocation.remoteFingerprint,
      updatedAt: timestamp,
    }
    const locationChanged =
      nextLocation.rootPath !== currentLocation.rootPath ||
      nextLocation.label !== currentLocation.label ||
      nextLocation.repoRoot !== currentLocation.repoRoot ||
      nextLocation.gitCommonDir !== currentLocation.gitCommonDir ||
      nextLocation.remoteFingerprint !== currentLocation.remoteFingerprint

    if (!locationChanged) {
      return false
    }

    this.locations.set(locationId, nextLocation)

    const project = this.projects.get(currentLocation.projectId)
    if (!project) {
      return true
    }

    const shouldPromoteIdentity =
      project.primaryLocationId === locationId ||
      !project.identity?.repoRoot ||
      !project.identity?.gitCommonDir ||
      !project.identity?.remoteFingerprint
    const nextProject: ProjectConfig = shouldPromoteIdentity
      ? {
          ...project,
          rootPath: nextLocation.rootPath,
          updatedAt: timestamp,
          primaryLocationId: project.primaryLocationId ?? nextLocation.id,
          identity: {
            repoRoot: nextLocation.repoRoot ?? project.identity?.repoRoot ?? null,
            gitCommonDir: nextLocation.gitCommonDir ?? project.identity?.gitCommonDir ?? null,
            remoteFingerprint:
              nextLocation.remoteFingerprint ??
              project.identity?.remoteFingerprint ??
              null,
          },
        }
      : project

    if (nextProject !== project) {
      this.projects.set(project.id, nextProject)
    }

    return true
  }

  private async attachProjectContextBootstrap(sessionId: string): Promise<void> {
    const config = this.configs.get(sessionId)
    if (!config || !this.terminals.has(sessionId)) {
      return
    }

    const project = this.projects.get(config.projectId)
    if (!project) {
      return
    }

    const location = config.locationId
      ? this.locations.get(config.locationId) ?? null
      : null
    const context = await this.projectMemory.assembleContext({
      project,
      location,
    })
    if (!context.bootstrapMessage?.trim()) {
      return
    }

    const nextConfig: SessionConfig = {
      ...config,
      projectContextAttachedAt: context.generatedAt,
    }
    this.configs.set(sessionId, nextConfig)
    this.persist()
    this.events.onConfig({
      sessionId,
      config: nextConfig,
    })
    this.writeToSessionInternal(sessionId, `${context.bootstrapMessage}\r`, 'system')
    this.pendingQueryBootstrapSessions.add(sessionId)
  }

  private scheduleDeferredQueryBootstrap(sessionId: string, query: string): void {
    if (!this.pendingQueryBootstrapSessions.delete(sessionId)) {
      return
    }

    setTimeout(() => {
      void this.attachDeferredQueryBootstrap(sessionId, query)
    }, 80)
  }

  private async attachDeferredQueryBootstrap(
    sessionId: string,
    query: string,
  ): Promise<void> {
    const config = this.configs.get(sessionId)
    if (!config?.projectContextAttachedAt || !this.terminals.has(sessionId)) {
      return
    }

    const project = this.projects.get(config.projectId)
    if (!project) {
      return
    }

    const location = config.locationId
      ? this.locations.get(config.locationId) ?? null
      : null
    const context = await this.projectMemory.assembleContext({
      project,
      location,
      query,
    })
    if (!context.bootstrapMessage?.trim()) {
      return
    }

    this.writeToSessionInternal(
      sessionId,
      `${context.bootstrapMessage}\r`,
      'system',
    )
  }

  private collectBackfillInputs(): Array<{
    project: ProjectConfig
    location: ProjectLocation | null
    session: SessionConfig
  }> {
    const orderedConfigs = this.getOrderedConfigs()
    const inactiveConfigs = orderedConfigs.filter(
      (config) => config.id !== this.activeSessionId,
    )
    const activeConfig = this.activeSessionId
      ? orderedConfigs.find((config) => config.id === this.activeSessionId) ?? null
      : null

    return [...inactiveConfigs, ...(activeConfig ? [activeConfig] : [])]
      .map((config) => {
        const project = this.projects.get(config.projectId)
        if (!project) {
          return null
        }

        return {
          project,
          location: config.locationId
            ? this.locations.get(config.locationId) ?? null
            : null,
          session: config,
        }
      })
      .filter((entry): entry is {
        project: ProjectConfig
        location: ProjectLocation | null
        session: SessionConfig
      } => entry !== null)
  }

  private async queueProjectMemoryCapture(
    config: SessionConfig,
  ): Promise<void> {
    const project = this.projects.get(config.projectId)
    if (!project) {
      return
    }

    await this.projectMemory.captureSession({
      project,
      location: config.locationId
        ? this.locations.get(config.locationId) ?? null
        : null,
      session: config,
    })
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
      locations: this.getOrderedLocations(project.id),
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
    const activeProjectId = this.activeSessionId
      ? this.configs.get(this.activeSessionId)?.projectId ?? null
      : null

    return Array.from(this.projects.values())
      .sort((left, right) => {
        if (activeProjectId) {
          if (left.id === activeProjectId) {
            return -1
          }
          if (right.id === activeProjectId) {
            return 1
          }
        }

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
        if (this.activeSessionId) {
          if (left.id === this.activeSessionId) {
            return -1
          }
          if (right.id === this.activeSessionId) {
            return 1
          }
        }

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

  private getProjectLocations(projectId: string): ProjectLocation[] {
    return Array.from(this.locations.values()).filter(
      (location) => location.projectId === projectId,
    )
  }

  private getOrderedLocations(projectId: string): ProjectLocation[] {
    const project = this.projects.get(projectId)
    const primaryLocationId = project?.primaryLocationId ?? null
    return this.getProjectLocations(projectId).sort((left, right) => {
      if (left.id === primaryLocationId) {
        return -1
      }
      if (right.id === primaryLocationId) {
        return 1
      }

      return (
        right.lastSeenAt.localeCompare(left.lastSeenAt) ||
        left.label.localeCompare(right.label)
      )
    })
  }

  private splitLegacyMultiLocationProjects(): boolean {
    let changed = false

    for (const project of Array.from(this.projects.values())) {
      const locations = this.getOrderedLocations(project.id)
      if (locations.length <= 1) {
        continue
      }

      const primaryLocation =
        (project.primaryLocationId
          ? this.locations.get(project.primaryLocationId)
          : null) ?? locations[0] ?? null
      if (!primaryLocation) {
        continue
      }

      const nextPrimaryProject: ProjectConfig = {
        ...project,
        rootPath: primaryLocation.rootPath,
        title: this.deriveLocationProjectTitle(project, primaryLocation),
        primaryLocationId: primaryLocation.id,
        identity: {
          repoRoot: primaryLocation.repoRoot ?? project.identity?.repoRoot ?? null,
          gitCommonDir:
            primaryLocation.gitCommonDir ?? project.identity?.gitCommonDir ?? null,
          remoteFingerprint:
            primaryLocation.remoteFingerprint ??
            project.identity?.remoteFingerprint ??
            null,
        },
      }
      this.projects.set(project.id, nextPrimaryProject)

      for (const location of locations) {
        if (location.id === primaryLocation.id) {
          continue
        }

        const nextProjectId = crypto.randomUUID()
        const nextProject: ProjectConfig = {
          id: nextProjectId,
          title: this.deriveLocationProjectTitle(project, location),
          rootPath: location.rootPath,
          createdAt: location.createdAt || project.createdAt,
          updatedAt: location.updatedAt || project.updatedAt,
          primaryLocationId: location.id,
          identity: {
            repoRoot: location.repoRoot ?? project.identity?.repoRoot ?? null,
            gitCommonDir: location.gitCommonDir ?? project.identity?.gitCommonDir ?? null,
            remoteFingerprint:
              location.remoteFingerprint ??
              project.identity?.remoteFingerprint ??
              null,
          },
        }

        this.projects.set(nextProject.id, nextProject)
        this.locations.set(location.id, {
          ...location,
          projectId: nextProject.id,
        })
        changed = true
      }
    }

    return changed
  }

  private deriveLocationProjectTitle(
    project: ProjectConfig,
    location: ProjectLocation,
  ): string {
    const derivedFromLocationRoot = deriveProjectTitle(undefined, location.rootPath)
    return derivedFromLocationRoot || project.title
  }

  private findProjectByRootPath(rootPath: string): ProjectConfig | undefined {
    const existingLocation = this.findLocationByRootPath(rootPath)
    return existingLocation ? this.projects.get(existingLocation.projectId) : undefined
  }

  private findLocationByRootPath(rootPath: string): ProjectLocation | undefined {
    const normalizedRootPath = this.normalizePath(rootPath)
    return Array.from(this.locations.values()).find(
      (location) => this.normalizePath(location.rootPath) === normalizedRootPath,
    )
  }

  private setProjectPrimaryLocation(
    projectId: string,
    locationId: string,
    timestamp: string,
  ): void {
    const project = this.projects.get(projectId)
    const location = this.locations.get(locationId)
    if (!project || !location) {
      return
    }

    this.projects.set(projectId, {
      ...project,
      rootPath: location.rootPath,
      primaryLocationId: location.id,
      updatedAt: timestamp,
      identity: {
        repoRoot: location.repoRoot ?? project.identity?.repoRoot ?? null,
        gitCommonDir: location.gitCommonDir ?? project.identity?.gitCommonDir ?? null,
        remoteFingerprint:
          location.remoteFingerprint ??
          project.identity?.remoteFingerprint ??
          null,
      },
    })
  }

  private upsertProjectLocation(
    projectId: string,
    inspectedLocation: ProjectLocationIdentity,
    timestamp: string,
    setPrimary: boolean,
  ): ProjectLocation {
    const existingLocation = this.findLocationByRootPath(inspectedLocation.rootPath)
    if (existingLocation) {
      if (existingLocation.projectId !== projectId) {
        throw new Error(
          `Location ${inspectedLocation.rootPath} is already assigned to another project.`,
        )
      }

      const nextLocation: ProjectLocation = {
        ...existingLocation,
        rootPath: inspectedLocation.rootPath,
        label: inspectedLocation.label,
        repoRoot: inspectedLocation.repoRoot,
        gitCommonDir: inspectedLocation.gitCommonDir,
        remoteFingerprint: inspectedLocation.remoteFingerprint,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
      }
      this.locations.set(nextLocation.id, nextLocation)

      if (setPrimary || !this.projects.get(projectId)?.primaryLocationId) {
        this.setProjectPrimaryLocation(projectId, nextLocation.id, timestamp)
      }

      return nextLocation
    }

    const location: ProjectLocation = {
      id: crypto.randomUUID(),
      projectId,
      rootPath: inspectedLocation.rootPath,
      repoRoot: inspectedLocation.repoRoot,
      gitCommonDir: inspectedLocation.gitCommonDir,
      remoteFingerprint: inspectedLocation.remoteFingerprint,
      label: inspectedLocation.label,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    }
    this.locations.set(location.id, location)

    if (setPrimary || !this.projects.get(projectId)?.primaryLocationId) {
      this.setProjectPrimaryLocation(projectId, location.id, timestamp)
    }

    return location
  }

  private persist(): void {
    this.store.set({
      projects: Array.from(this.projects.values()),
      locations: Array.from(this.locations.values()),
      sessions: Array.from(this.configs.values()),
      runtimes: Array.from(this.runtimes.values()).map((runtime) => ({
        sessionId: runtime.sessionId,
        lastActiveAt: runtime.lastActiveAt,
      })),
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
