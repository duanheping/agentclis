import { readFileSync, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import Store from 'electron-store'

import type {
  GetSessionTranscriptPageInput,
  ProjectArchitectureAnalysisResult,
  ProjectSessionsAnalysisResult,
  SessionTranscriptPage,
  SessionTerminalReplay,
  UpdateSessionTerminalSnapshotInput,
} from '../src/shared/ipc'
import {
  buildRuntime,
  type CreateProjectInput,
  deriveProjectTitle,
  deriveSessionTitle,
  PROJECT_MEMORY_MODES,
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
  type SessionRestoreSnapshot,
  type SessionRuntime,
  type SessionRuntimeEvent,
  type SessionSnapshot,
} from '../src/shared/session'
import {
  extractTerminalAttentionFromText,
  reduceCodexAttentionState,
  reduceCopilotAwaitingResponseState,
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
  withCopilotAdditionalMcpConfig,
  withCopilotFullAccess,
} from './copilotCli'
import {
  buildCodexResumeCommand,
  extractCodexSessionMeta,
  supportsCodexSessionResume,
  withCodexDangerousBypass,
} from './codexCli'
import {
  injectCodexInstructions,
  removeCodexInstructions,
} from './codexInstructions'
import {
  injectCodexMcpConfig,
  removeCodexMcpConfig,
} from './codexMcpConfig'
import {
  injectCopilotInstructions,
  removeCopilotInstructions,
} from './copilotInstructions'
import {
  injectCopilotMempalaceMcpConfig,
  removeCopilotMempalaceMcpConfig,
} from './copilotMcpConfig'
import type { ProjectLocationIdentity } from './projectIdentity'
import type { ProjectMemoryService } from './projectMemoryService'
import { resolveProjectMemoryCapability } from './providerCapabilityResolver'
import { createProjectSessionWorktree } from './projectWorktree'
import {
  applyRuntimeToSessionRestoreSnapshot,
  applyTerminalReplayToSessionRestoreSnapshot,
  applyTranscriptEventToSessionRestoreSnapshot,
  buildSessionRestoreSnapshot,
  normalizeSessionRestoreSnapshot,
  sessionRestoreSnapshotsEqual,
} from './sessionRestoreSnapshot'
import type { TranscriptStore } from './transcriptStore'
import type { TerminalSnapshotStore } from './terminalSnapshotStore'
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
const EXTERNAL_SESSION_DISCOVERY_LOOKBACK_MS = 5_000
const COPILOT_SESSION_DISCOVERY_RETRY_DELAYS_MS = Array.from(
  { length: 23 },
  () => 750,
)
const CODEX_SESSION_DISCOVERY_RETRY_DELAYS_MS = [
  750,
  750,
  1_500,
  3_000,
  5_000,
  8_000,
  12_000,
  15_000,
  15_000,
  15_000,
  15_000,
  15_000,
  15_000,
  15_000,
  15_000,
  15_000,
]
const CODEX_SESSION_DISCOVERY_FILE_LIMIT = 32
const HISTORICAL_EXTERNAL_SESSION_FILE_LIMIT = 256
const EXTERNAL_SESSION_MATCH_START_TOLERANCE_MS = 1_000
const HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000
const HISTORICAL_EXTERNAL_SESSION_FALLBACK_DISTANCE_GAP_MS = 5 * 60 * 1_000
const EXTERNAL_SESSION_TITLE_SCAN_BYTES = 131_072
const FIRST_PROMPT_TITLE_LIMIT = 80
const BACKGROUND_IDENTITY_REFRESH_DELAY_MS = 1_500
const BACKGROUND_MEMORY_BACKFILL_DELAY_MS = 4_500
const EXTERNAL_ATTENTION_POLL_INTERVAL_MS = 1_500
const EXTERNAL_ATTENTION_RESOLUTION_RETRY_DELAYS_MS = [
  1_500,
  1_500,
  3_000,
  3_000,
  5_000,
  5_000,
  8_000,
  8_000,
  12_000,
  12_000,
]
const LIVE_ATTENTION_BUFFER_LIMIT = 4_096
const TOUCH_RUNTIME_DEBOUNCE_MS = 300
const INPUT_TRANSCRIPT_FLUSH_MS = 250
const SESSION_TERMINAL_REPLAY_MAX_BYTES = 2 * 1024 * 1024
const SESSION_TERMINAL_REPLAY_MAX_EVENTS = 5_000
const SESSION_RESTORE_BACKFILL_MAX_BYTES = 128 * 1024
const SESSION_RESTORE_BACKFILL_MAX_EVENTS = 80
const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'gu',
)
const EXTERNAL_ATTENTION_HISTORY_SCAN_BYTES = 512 * 1024

const require = createRequire(import.meta.url)
const nodePty = require('node-pty') as typeof import('node-pty')

function normalizeSessionTitleForComparison(title: string): string {
  return title.trim().toLowerCase()
}

function isPathLikeSessionTitle(title: string): boolean {
  const normalized = title.trim()
  if (!normalized) {
    return false
  }

  return (
    /^\/\S*$/u.test(normalized) ||
    /^[A-Za-z]:[\\/]\S*$/u.test(normalized) ||
    /^\\\\\S+$/u.test(normalized)
  )
}

function isMeaningfulSessionTitleCandidate(title: string): boolean {
  const normalized = title.trim()
  if (!normalized) {
    return false
  }

  if (isPathLikeSessionTitle(normalized)) {
    return false
  }

  return /[\p{L}\p{N}]/u.test(normalized)
}

function deriveLegacySessionDefaultTitle(startupCommand: string, cwd: string): string {
  const commandLabel = startupCommand.trim().split(/\s+/)[0]
  if (commandLabel) {
    return commandLabel
  }

  const normalizedPath = cwd.trim().replace(/[\\/]+$/, '')
  const pathParts = normalizedPath.split(/[\\/]/).filter(Boolean)
  return pathParts.at(-1) ?? 'New Session'
}

function isLowSignalSessionTitle(
  title: string,
  startupCommand: string,
  cwd: string,
): boolean {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    return true
  }

  if (!isMeaningfulSessionTitleCandidate(normalizedTitle)) {
    return true
  }

  const comparableTitle = normalizeSessionTitleForComparison(normalizedTitle)
  return (
    comparableTitle === normalizeSessionTitleForComparison(
      deriveSessionTitle(undefined, startupCommand, cwd),
    ) ||
    comparableTitle === normalizeSessionTitleForComparison(
      deriveLegacySessionDefaultTitle(startupCommand, cwd),
    )
  )
}

function getSessionTitleMatchTerms(title: string): string[] {
  const normalizedTitle = normalizeSessionTitleForComparison(title)
  if (!normalizedTitle) {
    return []
  }

  const terms = [normalizedTitle]
  if (normalizedTitle.endsWith('...')) {
    const truncatedPrefix = normalizedTitle.slice(0, -3).trimEnd()
    if (truncatedPrefix) {
      terms.push(truncatedPrefix)
    }
  }

  return Array.from(new Set(terms))
}

interface PersistedSessionState {
  projects: ProjectConfig[]
  locations: ProjectLocation[]
  sessions: StoredSessionConfig[]
  runtimes: Array<Pick<SessionRuntime, 'sessionId' | 'lastActiveAt'>>
  restoreSnapshots?: Record<string, SessionRestoreSnapshot>
  copilotInstructionSnapshots?: Record<string, string>
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
  transcriptStore?: Pick<TranscriptStore, 'append'> &
    Partial<Pick<TranscriptStore, 'readTailEvents' | 'readEventsPage'>>
  terminalSnapshots?: Pick<TerminalSnapshotStore, 'read' | 'write' | 'delete'>
  projectMemory?: Pick<
    ProjectMemoryService,
    | 'analyzeHistoricalArchitecture'
    | 'analyzeHistoricalSessions'
    | 'assembleContext'
    | 'captureSession'
    | 'scheduleBackfillSessions'
    | 'dispose'
    | 'getMemoryBackendStatus'
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
  readTailEvents: async () => [],
  readEventsPage: async () => ({
    events: [],
    nextCursor: null,
  }),
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
  getMemoryBackendStatus: async () => null,
}

const noopTerminalSnapshotStore: NonNullable<SessionManagerServices['terminalSnapshots']> = {
  read: async () => null,
  write: async () => undefined,
  delete: async () => undefined,
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
  private readonly restoreSnapshots = new Map<string, SessionRestoreSnapshot>()
  private readonly terminals = new Map<string, IPty>()
  private readonly pendingFirstPromptBuffers = new Map<string, string>()
  private readonly liveAttentionBuffers = new Map<string, string>()
  private readonly claimedExternalSessions = new Map<string, string>()
  private readonly pendingExternalSessionDetections = new Map<string, NodeJS.Timeout>()
  private readonly pendingExternalSessionAttentionResolutions = new Map<
    string,
    NodeJS.Timeout
  >()
  private readonly externalSessionAttentionTrackers = new Map<
    string,
    ExternalSessionAttentionTracker
  >()
  private readonly historicalExternalSessionRecovery = new Set<string>()
  private readonly suppressedExit = new Set<string>()
  private readonly copilotInstructionsState = new Map<string, { cwd: string }>()
  private readonly copilotInstructionsCwdRefs = new Map<string, { count: number, created: boolean }>()
  private readonly copilotInstructionSnapshots = new Map<string, string>()
  private readonly copilotMcpConfigState = new Map<string, { cwd: string }>()
  private readonly copilotMcpConfigCwdRefs = new Map<string, { count: number }>()
  private readonly codexMcpConfigState = new Map<string, { cwd: string }>()
  private readonly codexMcpConfigCwdRefs = new Map<string, { count: number, created: boolean }>()
  private readonly codexInstructionsState = new Map<string, { cwd: string }>()
  private readonly codexInstructionsCwdRefs = new Map<string, { count: number, created: boolean }>()
  private readonly touchRuntimeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inputTranscriptBuffers = new Map<string, string[]>()
  private readonly inputTranscriptTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingSessionStartTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private readonly events: SessionManagerEvents
  private readonly identityResolver: NonNullable<SessionManagerServices['identityResolver']>
  private readonly transcriptStore: NonNullable<SessionManagerServices['transcriptStore']>
  private readonly terminalSnapshots: NonNullable<SessionManagerServices['terminalSnapshots']>
  private readonly projectMemory: NonNullable<SessionManagerServices['projectMemory']>

  private activeSessionId: string | null
  private restored = false
  private restoreSnapshotBackfillStarted = false
  private identityRefreshTimer: NodeJS.Timeout | null = null
  private memoryBackfillTimer: NodeJS.Timeout | null = null

  constructor(events: SessionManagerEvents, services: SessionManagerServices = {}) {
    this.events = events
    this.identityResolver = services.identityResolver ?? defaultIdentityResolver
    this.transcriptStore = services.transcriptStore ?? noopTranscriptStore
    this.terminalSnapshots =
      services.terminalSnapshots ?? noopTerminalSnapshotStore
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
      const hydratedRuntime = buildRuntime(
        hydratedConfig.id,
        'exited',
        restoredLastActiveAt,
      )
      this.runtimes.set(hydratedConfig.id, hydratedRuntime)
      const normalizedRestoreSnapshot = normalizeSessionRestoreSnapshot(
        persisted.restoreSnapshots?.[hydratedConfig.id],
        hydratedRuntime,
      )
      this.restoreSnapshots.set(hydratedConfig.id, normalizedRestoreSnapshot)
      this.claimExternalSession(hydratedConfig)
      this.trackHistoricalExternalSessionRecovery(hydratedConfig)

      if (
        !sessionRestoreSnapshotsEqual(
          persisted.restoreSnapshots?.[hydratedConfig.id],
          normalizedRestoreSnapshot,
        ) ||
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

    for (const [sessionId, snapshot] of Object.entries(
      persisted.copilotInstructionSnapshots ?? {},
    )) {
      const normalizedSnapshot = snapshot.trim()
      if (!normalizedSnapshot || !this.configs.has(sessionId)) {
        shouldPersist = true
        continue
      }

      this.copilotInstructionSnapshots.set(sessionId, normalizedSnapshot)
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
      if (!this.restoreSnapshotBackfillStarted) {
        this.restoreSnapshotBackfillStarted = true
        void this.backfillRestoreSnapshotsFromTranscriptTail().catch(() => undefined)
      }

      if (this.activeSessionId) {
        this.scheduleSessionStart(this.activeSessionId)
      }
    }

    return this.listSessions()
  }

  async getSessionTerminalReplay(id: string): Promise<SessionTerminalReplay> {
    this.requireConfig(id)

    const snapshot = await this.terminalSnapshots.read(id)
    const serializedSnapshot = snapshot?.serialized?.trim()
    const plainTextSnapshot = snapshot?.text.trim()
    if (snapshot && (serializedSnapshot || plainTextSnapshot)) {
      const snapshotContent = serializedSnapshot ? snapshot.serialized! : snapshot.text
      const deltaEvents =
        (await this.transcriptStore.readTailEvents?.(id, {
          kinds: ['output'],
          maxBytes: SESSION_TERMINAL_REPLAY_MAX_BYTES,
          maxEvents: SESSION_TERMINAL_REPLAY_MAX_EVENTS,
          requireChunk: true,
          afterTimestamp: snapshot.capturedAt,
        })) ?? []

      return {
        chunks: deltaEvents.flatMap((event) => (event.chunk ? [event.chunk] : [])),
        source: 'snapshot',
        snapshot: {
          format: serializedSnapshot ? 'serialized' : 'text',
          cols: snapshot.cols,
          rows: snapshot.rows,
          content: snapshotContent,
        },
      }
    }

    const events =
      (await this.transcriptStore.readTailEvents?.(id, {
        kinds: ['output'],
        maxBytes: SESSION_TERMINAL_REPLAY_MAX_BYTES,
        maxEvents: SESSION_TERMINAL_REPLAY_MAX_EVENTS,
        requireChunk: true,
      })) ?? []

    return {
      chunks: events.flatMap((event) => (event.chunk ? [event.chunk] : [])),
      source: 'transcript',
    }
  }

  async getSessionTranscriptPage(
    input: GetSessionTranscriptPageInput,
  ): Promise<SessionTranscriptPage> {
    this.requireConfig(input.sessionId)
    return await this.transcriptStore.readEventsPage?.(input.sessionId, {
      cursor: input.cursor,
      limit: input.limit,
      kinds: input.kinds,
      search: input.search,
    }) ?? {
      events: [],
      nextCursor: null,
    }
  }

  async updateTerminalSnapshot(
    input: UpdateSessionTerminalSnapshotInput,
  ): Promise<void> {
    if (!this.configs.has(input.sessionId)) {
      return
    }

    await this.terminalSnapshots.write(input)
    this.updateRestoreSnapshot(
      input.sessionId,
      (current) =>
        applyTerminalReplayToSessionRestoreSnapshot(current, input.capturedAt),
    )
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
    const projectMemoryCapability = input.attachProjectContext
      ? resolveProjectMemoryCapability(input.startupCommand)
      : null
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
      projectMemoryMode: projectMemoryCapability?.mode ?? 'disabled',
      projectMemoryFallbackReason:
        projectMemoryCapability?.fallbackReason ?? null,
      createdAt: now,
      updatedAt: now,
    }

    this.configs.set(id, config)
    const initialRuntime = buildRuntime(id)
    this.runtimes.set(id, initialRuntime)
    this.restoreSnapshots.set(id, buildSessionRestoreSnapshot(initialRuntime))
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
    this.scheduleSessionStart(id)
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
    this.cancelDebouncedTouchRuntime(id)
    this.flushInputTranscript(id)
    this.pendingFirstPromptBuffers.delete(id)
    this.cleanupCopilotInstructions(id)
    this.cleanupCopilotMcpConfig(id)
    this.cleanupCodexMcpConfig(id)
    this.cleanupCodexInstructions(id)
    this.cancelScheduledSessionStart(id)
    this.historicalExternalSessionRecovery.delete(id)
    this.releaseExternalSession(closingConfig)
    this.copilotInstructionSnapshots.delete(id)
    this.restoreSnapshots.delete(id)
    this.configs.delete(id)
    this.runtimes.delete(id)
    await this.terminalSnapshots.delete(id)

    if (this.activeSessionId === id) {
      this.activeSessionId =
        orderedIds[closingIndex + 1] ??
        orderedIds[closingIndex - 1] ??
        null
    }

    const nextActiveSessionId = this.activeSessionId
    this.persist()

    if (nextActiveSessionId) {
      this.scheduleSessionStart(nextActiveSessionId)
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

    for (const sessionId of Array.from(
      this.pendingExternalSessionAttentionResolutions.keys(),
    )) {
      this.stopExternalSessionAttentionTracking(sessionId)
    }

    for (const id of Array.from(this.terminals.keys())) {
      this.stopSession(id, true)
    }

    for (const id of Array.from(this.touchRuntimeTimers.keys())) {
      this.cancelDebouncedTouchRuntime(id)
    }

    for (const id of Array.from(this.inputTranscriptTimers.keys())) {
      this.flushInputTranscript(id)
    }

    this.projectMemory.dispose()

    for (const timer of this.pendingSessionStartTimers.values()) {
      clearTimeout(timer)
    }
    this.pendingSessionStartTimers.clear()

    for (const sessionId of this.copilotInstructionsState.keys()) {
      this.cleanupCopilotInstructions(sessionId)
    }

    for (const sessionId of this.copilotMcpConfigState.keys()) {
      this.cleanupCopilotMcpConfig(sessionId)
    }

    for (const sessionId of this.codexMcpConfigState.keys()) {
      this.cleanupCodexMcpConfig(sessionId)
    }

    for (const sessionId of this.codexInstructionsState.keys()) {
      this.cleanupCodexInstructions(sessionId)
    }
  }

  private async startSession(config: SessionConfig): Promise<void> {
    this.cancelScheduledSessionStart(config.id)
    this.stopSession(config.id, true)
    this.cancelExternalSessionDetection(config.id)
    this.stopExternalSessionAttentionTracking(config.id)
    this.cancelDebouncedTouchRuntime(config.id)
    this.flushInputTranscript(config.id)
    this.pendingFirstPromptBuffers.delete(config.id)
    this.cleanupCopilotInstructions(config.id)
    this.cleanupCopilotMcpConfig(config.id)
    this.cleanupCodexMcpConfig(config.id)
    this.cleanupCodexInstructions(config.id)
    this.clearLiveAttentionBuffer(config.id)
    this.setRuntime(config.id, {
      attention: null,
      awaitingResponse: false,
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

      normalizedConfig =
        await this.prepareManagedSessionLaunchConfig(normalizedConfig)

      const launchCommand = await this.resolveStartupCommand(normalizedConfig)
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
          awaitingResponse: false,
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
        awaitingResponse: false,
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
    this.cancelScheduledSessionStart(id)

    if (this.terminals.has(id)) {
      return
    }

    if (this.runtimes.get(id)?.status === 'starting') {
      return
    }

    await this.startSession(this.requireConfig(id))
  }

  private scheduleSessionStart(id: string, delayMs = 0): void {
    if (this.pendingSessionStartTimers.has(id)) {
      return
    }

    const timer = setTimeout(() => {
      this.pendingSessionStartTimers.delete(id)
      void this.ensureSessionStarted(id).catch(() => undefined)
    }, Math.max(0, delayMs))

    this.pendingSessionStartTimers.set(id, timer)
  }

  private cancelScheduledSessionStart(id: string): void {
    const timer = this.pendingSessionStartTimers.get(id)
    if (!timer) {
      return
    }

    clearTimeout(timer)
    this.pendingSessionStartTimers.delete(id)
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

  private async resolveStartupCommand(config: SessionConfig): Promise<string> {
    let command = config.startupCommand

    // Apply permission flags before resume so that withCopilotFullAccess
    // does not strip the --resume flag added by buildCopilotResumeCommand.
    command = this.applyPermissionFlags(command, config)

    if (config.externalSession?.provider === 'codex') {
      command =
        buildCodexResumeCommand(
          command,
          config.externalSession.sessionId,
        ) ?? command
    } else if (config.externalSession?.provider === 'copilot') {
      command =
        buildCopilotResumeCommand(
          command,
          config.externalSession.sessionId,
        ) ?? command
    }

    // Inject project memory via provider-native mechanisms
    command = await this.applyProjectMemoryInjection(command, config)

    return command
  }

  private async applyProjectMemoryInjection(
    command: string,
    config: SessionConfig,
  ): Promise<string> {
    const mode = config.projectMemoryMode
    if (!mode || mode === 'disabled') return command

    const location = config.locationId
      ? this.locations.get(config.locationId) ?? null
      : null
    const project = this.projects.get(config.projectId)
    if (!project) return command

    try {
      const memoryText = await this.resolveProjectMemoryInjectionText(
        config,
        project,
        location,
      )
      if (!memoryText) return command

      if (mode === 'codex-developer-instructions') {
        const normalizedCwd = this.normalizePath(config.cwd)
        const existing = this.codexInstructionsCwdRefs.get(normalizedCwd)
        const result = injectCodexInstructions(config.cwd, memoryText)
        this.codexInstructionsState.set(config.id, { cwd: config.cwd })
        this.codexInstructionsCwdRefs.set(normalizedCwd, {
          count: (existing?.count ?? 0) + 1,
          created: existing ? existing.created : result.created,
        })

        if (!config.externalSession) {
          const status = await this.projectMemory.getMemoryBackendStatus()
          if (status?.installState === 'installed' && status.pythonPath?.trim()) {
            const mcpExisting = this.codexMcpConfigCwdRefs.get(normalizedCwd)
            const configResult = injectCodexMcpConfig(config.cwd, status)
            this.codexMcpConfigState.set(config.id, { cwd: config.cwd })
            this.codexMcpConfigCwdRefs.set(normalizedCwd, {
              count: (mcpExisting?.count ?? 0) + 1,
              created: mcpExisting ? mcpExisting.created : configResult.created,
            })
          }
        }

        return command
      }

      if (mode === 'copilot-instructions') {
        const normalizedCwd = this.normalizePath(config.cwd)
        const existing = this.copilotInstructionsCwdRefs.get(normalizedCwd)
        const result = injectCopilotInstructions(config.cwd, memoryText)
        this.copilotInstructionsState.set(config.id, { cwd: config.cwd })
        this.copilotInstructionsCwdRefs.set(normalizedCwd, {
          count: (existing?.count ?? 0) + 1,
          // Only treat as "created" if the very first session created it
          created: existing ? existing.created : result.created,
        })

        if (!config.externalSession) {
          const status = await this.projectMemory.getMemoryBackendStatus()
          if (status?.installState === 'installed' && status.pythonPath?.trim()) {
            const mcpExisting = this.copilotMcpConfigCwdRefs.get(normalizedCwd)
            const configResult = injectCopilotMempalaceMcpConfig(config.cwd, status)
            command = withCopilotAdditionalMcpConfig(command, configResult.filePath) ?? command
            this.copilotMcpConfigState.set(config.id, { cwd: config.cwd })
            this.copilotMcpConfigCwdRefs.set(normalizedCwd, {
              count: (mcpExisting?.count ?? 0) + 1,
            })
          }
        }

        return command
      }
    } catch (err) {
      console.warn(
        `[project-memory] Failed to inject memory for session ${config.id}:`,
        err,
      )
    }

    return command
  }

  private async resolveProjectMemoryInjectionText(
    config: SessionConfig,
    project: ProjectConfig,
    location: ProjectLocation | null,
  ): Promise<string | null> {
    if (config.projectMemoryMode === 'copilot-instructions') {
      const storedSnapshot = this.copilotInstructionSnapshots.get(config.id)?.trim()
      if (config.externalSession?.provider === 'copilot') {
        return storedSnapshot || null
      }
    }

    const context = await this.projectMemory.assembleContext({
      project,
      location,
    })
    const memoryText = context.bootstrapMessage?.trim()
    if (!memoryText) {
      return null
    }

    if (config.projectMemoryMode === 'copilot-instructions') {
      this.storeCopilotInstructionSnapshot(config.id, memoryText)
    }

    return memoryText
  }

  private storeCopilotInstructionSnapshot(
    sessionId: string,
    memoryText: string,
  ): void {
    const normalizedMemoryText = memoryText.trim()
    if (!normalizedMemoryText) {
      return
    }

    if (this.copilotInstructionSnapshots.get(sessionId) === normalizedMemoryText) {
      return
    }

    this.copilotInstructionSnapshots.set(sessionId, normalizedMemoryText)
    this.persist()
  }

  private cleanupCopilotInstructions(sessionId: string): void {
    const state = this.copilotInstructionsState.get(sessionId)
    if (!state) return
    this.copilotInstructionsState.delete(sessionId)

    const normalizedCwd = this.normalizePath(state.cwd)
    const ref = this.copilotInstructionsCwdRefs.get(normalizedCwd)
    if (!ref) return

    ref.count -= 1
    if (ref.count > 0) return

    // Last session for this CWD — clean up the file
    this.copilotInstructionsCwdRefs.delete(normalizedCwd)
    try {
      removeCopilotInstructions(state.cwd, ref.created)
    } catch (err) {
      console.warn(
        `[project-memory] Failed to clean up Copilot instructions for session ${sessionId}:`,
        err,
      )
    }
  }

  private cleanupCopilotMcpConfig(sessionId: string): void {
    const state = this.copilotMcpConfigState.get(sessionId)
    if (!state) return
    this.copilotMcpConfigState.delete(sessionId)

    const normalizedCwd = this.normalizePath(state.cwd)
    const ref = this.copilotMcpConfigCwdRefs.get(normalizedCwd)
    if (!ref) return

    ref.count -= 1
    if (ref.count > 0) return

    this.copilotMcpConfigCwdRefs.delete(normalizedCwd)
    try {
      removeCopilotMempalaceMcpConfig(state.cwd)
    } catch (err) {
      console.warn(
        `[project-memory] Failed to clean up Copilot MemPalace MCP config for session ${sessionId}:`,
        err,
      )
    }
  }

  private cleanupCodexMcpConfig(sessionId: string): void {
    const state = this.codexMcpConfigState.get(sessionId)
    if (!state) return
    this.codexMcpConfigState.delete(sessionId)

    const normalizedCwd = this.normalizePath(state.cwd)
    const ref = this.codexMcpConfigCwdRefs.get(normalizedCwd)
    if (!ref) return

    ref.count -= 1
    if (ref.count > 0) return

    this.codexMcpConfigCwdRefs.delete(normalizedCwd)
    try {
      removeCodexMcpConfig(state.cwd, ref.created)
    } catch (err) {
      console.warn(
        `[project-memory] Failed to clean up Codex MemPalace MCP config for session ${sessionId}:`,
        err,
      )
    }
  }

  private cleanupCodexInstructions(sessionId: string): void {
    const state = this.codexInstructionsState.get(sessionId)
    if (!state) return
    this.codexInstructionsState.delete(sessionId)

    const normalizedCwd = this.normalizePath(state.cwd)
    const ref = this.codexInstructionsCwdRefs.get(normalizedCwd)
    if (!ref) return

    ref.count -= 1
    if (ref.count > 0) return

    this.codexInstructionsCwdRefs.delete(normalizedCwd)
    try {
      removeCodexInstructions(state.cwd, ref.created)
    } catch (err) {
      console.warn(
        `[project-memory] Failed to clean up Codex instructions for session ${sessionId}:`,
        err,
      )
    }
  }

  private applyPermissionFlags(
    command: string,
    config: SessionConfig,
  ): string {
    if (config.permissionLevel !== 'full-access') {
      return command
    }

    const provider = this.detectResumableProvider(command)
    if (provider === 'copilot') {
      return withCopilotFullAccess(command) ?? command
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

  private async prepareManagedSessionLaunchConfig(
    config: SessionConfig,
  ): Promise<SessionConfig> {
    let nextConfig = config

    if (nextConfig.externalSession) {
      const storedSessionState =
        await this.inspectStoredExternalSession(nextConfig)
      if (storedSessionState !== 'valid') {
        const staleExternalSession = nextConfig.externalSession
        if (storedSessionState === 'ineligible') {
          this.releaseExternalSession(nextConfig)
          nextConfig = {
            ...nextConfig,
            externalSession: undefined,
          }
          this.configs.set(nextConfig.id, nextConfig)
          this.trackHistoricalExternalSessionRecovery(nextConfig)
          this.persist()
          this.events.onConfig({
            sessionId: nextConfig.id,
            config: nextConfig,
          })
        }

        const recoveredSession = await this.findHistoricalExternalSession(
          nextConfig,
          staleExternalSession.provider,
          {
            allowTitleMismatchFallback: true,
          },
        )
        if (!recoveredSession) {
          throw new Error(
            this.buildExternalSessionRecoveryFailureMessage(
              staleExternalSession.provider,
              nextConfig,
            ),
          )
        }

        this.attachExternalSession(nextConfig, recoveredSession)
        nextConfig = this.requireConfig(config.id)
      }
    }

    const resumableProvider =
      nextConfig.externalSession === undefined &&
      this.historicalExternalSessionRecovery.has(nextConfig.id) &&
      !this.isExplicitResumeCommand(nextConfig.startupCommand)
        ? this.detectResumableProvider(nextConfig.startupCommand)
        : null
    if (!resumableProvider) {
      return nextConfig
    }

    const historicalSession = await this.findHistoricalExternalSession(
      nextConfig,
      resumableProvider,
    )
    if (!historicalSession) {
      throw new Error(
        this.buildExternalSessionRecoveryFailureMessage(
          resumableProvider,
          nextConfig,
        ),
      )
    }

    this.attachExternalSession(nextConfig, historicalSession)
    return this.requireConfig(config.id)
  }

  private buildExternalSessionRecoveryFailureMessage(
    provider: 'codex' | 'copilot',
    config: SessionConfig,
  ): string {
    return `Unable to recover the previous ${provider} session for "${config.title}". Create a new session to start over.`
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

    const nextDelayMs = this.getExternalSessionDiscoveryRetryDelayMs(
      provider,
      attempt,
    )
    if (nextDelayMs === null) {
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
    }, nextDelayMs)
    this.pendingExternalSessionDetections.set(sessionId, timer)
  }

  private getExternalSessionDiscoveryRetryDelayMs(
    provider: 'codex' | 'copilot',
    attempt: number,
  ): number | null {
    const retryDelays =
      provider === 'codex'
        ? CODEX_SESSION_DISCOVERY_RETRY_DELAYS_MS
        : COPILOT_SESSION_DISCOVERY_RETRY_DELAYS_MS

    return retryDelays[attempt] ?? null
  }

  private async findMatchingExternalSession(
    config: SessionConfig,
    provider: 'codex' | 'copilot',
    startedAt: number,
  ): Promise<DetectedExternalSession | null> {
    const candidates = await this.listRecentExternalSessions(
      provider,
      startedAt - EXTERNAL_SESSION_DISCOVERY_LOOKBACK_MS,
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
    options: {
      allowTitleMismatchFallback?: boolean
    } = {},
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
      if (!options.allowTitleMismatchFallback) {
        return null
      }

      const secondBest = sorted[1]
      if (
        secondBest &&
        secondBest.distance - best.distance <
          HISTORICAL_EXTERNAL_SESSION_FALLBACK_DISTANCE_GAP_MS
      ) {
        return null
      }
    }

    return best.candidate
  }

  private async inspectStoredExternalSession(
    config: SessionConfig,
  ): Promise<'valid' | 'missing' | 'ineligible'> {
    if (!config.externalSession) {
      return 'valid'
    }

    const candidate = await this.findRecentExternalSessionById(
      config.externalSession.provider,
      config.externalSession.sessionId,
      this.getExternalSessionReferenceTimes(config),
    )

    if (!candidate) {
      return 'missing'
    }

    return this.isEligibleExternalSessionCandidate(candidate)
      ? 'valid'
      : 'ineligible'
  }

  private async findRecentExternalSessionById(
    provider: 'codex' | 'copilot',
    sessionId: string,
    referenceTimestamps: number[],
  ): Promise<DetectedExternalSession | null> {
    if (referenceTimestamps.length === 0) {
      return null
    }

    if (provider === 'copilot') {
      return (
        await this.readCopilotSessionMeta(
          path.join(COPILOT_SESSIONS_ROOT, sessionId, 'workspace.yaml'),
        )
      )
    }

    const sinceMs = Math.max(
      0,
      Math.min(...referenceTimestamps) - HISTORICAL_EXTERNAL_SESSION_LOOKBACK_MS,
    )
    const dayDirectories = this.getCodexSessionDayDirectories(sinceMs)

    for (const dayDirectory of dayDirectories) {
      let entries: Dirent[] = []
      try {
        entries = await readdir(dayDirectory, { withFileTypes: true })
      } catch {
        continue
      }

      const matchingEntry = entries.find(
        (entry) =>
          entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`),
      )
      if (!matchingEntry) {
        continue
      }

      return await this.readCodexSessionMeta(
        path.join(dayDirectory, matchingEntry.name),
      )
    }

    return null
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
    const matchTerms = getSessionTitleMatchTerms(normalizedTitle)
    if (matchTerms.length === 0) {
      return false
    }

    if (candidate.summary) {
      const normalizedSummary = candidate.summary.trim().toLowerCase()
      if (
        matchTerms.some(
          (term) =>
            normalizedSummary.includes(term) || term.includes(normalizedSummary),
        )
      ) {
        return true
      }
    }

    if (candidate.provider === 'copilot') {
      const transcriptPrefix = await this.readFilePrefix(
        path.join(COPILOT_SESSIONS_ROOT, candidate.sessionId, 'events.jsonl'),
        EXTERNAL_SESSION_TITLE_SCAN_BYTES,
      )
      if (!transcriptPrefix) {
        return false
      }

      const normalizedTranscriptPrefix = transcriptPrefix.toLowerCase()
      return matchTerms.some((term) => normalizedTranscriptPrefix.includes(term))
    }

    if (!candidate.sourcePath) {
      return false
    }

    const prefix = await this.readFilePrefix(
      candidate.sourcePath,
      EXTERNAL_SESSION_TITLE_SCAN_BYTES,
    )
    if (!prefix) {
      return false
    }

    const normalizedPrefix = prefix.toLowerCase()
    return matchTerms.some((term) => normalizedPrefix.includes(term))
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
      const eventsFilePath = path.join(
        COPILOT_SESSIONS_ROOT,
        entry.name,
        'events.jsonl',
      )

      let workspaceDetails
      try {
        workspaceDetails = await stat(workspaceFilePath)
      } catch {
        continue
      }

      let modifiedAt = workspaceDetails.mtimeMs
      try {
        const eventsDetails = await stat(eventsFilePath)
        modifiedAt = Math.max(modifiedAt, eventsDetails.mtimeMs)
      } catch {
        // Ignore missing Copilot event logs and fall back to the workspace file.
      }

      if (modifiedAt < sinceMs) {
        continue
      }

      candidates.push({
        workspaceFilePath,
        modifiedAt,
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
    resolutionAttempt = 0,
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
      this.scheduleExternalSessionAttentionResolutionRetry(
        config,
        resolutionAttempt,
      )
      return
    }

    this.cancelExternalSessionAttentionResolution(config.id)

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
    let initialRuntimeState: Pick<
      SessionRuntime,
      'attention' | 'awaitingResponse'
    > = {
      attention: null,
      awaitingResponse: false,
    }
    try {
      const details = await stat(filePath)
      initialOffset = details.size
      initialRuntimeState = await this.readPersistedExternalSessionState(
        config.externalSession.provider,
        filePath,
      )
    } catch {
      this.scheduleExternalSessionAttentionResolutionRetry(
        config,
        resolutionAttempt,
      )
      return
    }

    this.stopExternalSessionAttentionTracking(config.id)
    const currentRuntime = this.runtimes.get(config.id) ?? buildRuntime(config.id)
    if (
      currentRuntime.attention !== initialRuntimeState.attention ||
      (currentRuntime.awaitingResponse ?? false) !==
        initialRuntimeState.awaitingResponse
    ) {
      this.setRuntime(config.id, initialRuntimeState)
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

  private async readPersistedExternalSessionState(
    provider: 'codex' | 'copilot',
    filePath: string,
  ): Promise<Pick<SessionRuntime, 'attention' | 'awaitingResponse'>> {
    const content = await this.readFileTail(
      filePath,
      EXTERNAL_ATTENTION_HISTORY_SCAN_BYTES,
    )
    if (!content) {
      return {
        attention: null,
        awaitingResponse: false,
      }
    }

    let attention: SessionAttentionKind | null = null
    let awaitingResponse = false
    const lines = content.split(/\r?\n/u)
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }

      if (provider === 'codex') {
        attention = reduceCodexAttentionState(attention, line)
        continue
      }

      attention = reduceCopilotAttentionState(attention, line)
      awaitingResponse = reduceCopilotAwaitingResponseState(
        awaitingResponse,
        line,
      )
    }

    return {
      attention,
      awaitingResponse,
    }
  }

  private stopExternalSessionAttentionTracking(sessionId: string): void {
    this.cancelExternalSessionAttentionResolution(sessionId)

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
        await stat(filePath)
        return filePath
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

  private scheduleExternalSessionAttentionResolutionRetry(
    config: SessionConfig,
    attempt: number,
  ): void {
    const delayMs = EXTERNAL_ATTENTION_RESOLUTION_RETRY_DELAYS_MS[attempt]
    if (delayMs === undefined || !config.externalSession) {
      return
    }

    this.cancelExternalSessionAttentionResolution(config.id)
    const provider = config.externalSession.provider
    const externalSessionId = config.externalSession.sessionId
    const timer = setTimeout(() => {
      this.pendingExternalSessionAttentionResolutions.delete(config.id)
      const latestConfig = this.configs.get(config.id)
      if (
        !latestConfig?.externalSession ||
        latestConfig.externalSession.provider !== provider ||
        latestConfig.externalSession.sessionId !== externalSessionId
      ) {
        return
      }

      void this.ensureExternalSessionAttentionTracking(
        latestConfig,
        undefined,
        attempt + 1,
      )
    }, delayMs)
    this.pendingExternalSessionAttentionResolutions.set(config.id, timer)
  }

  private cancelExternalSessionAttentionResolution(sessionId: string): void {
    const timer = this.pendingExternalSessionAttentionResolutions.get(sessionId)
    if (!timer) {
      return
    }

    clearTimeout(timer)
    this.pendingExternalSessionAttentionResolutions.delete(sessionId)
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

    const currentRuntime = this.runtimes.get(sessionId) ?? buildRuntime(sessionId)
    const currentAttention = currentRuntime.attention ?? null
    const nextAttention =
      provider === 'codex'
        ? reduceCodexAttentionState(currentAttention, line)
        : reduceCopilotAttentionState(currentAttention, line)
    const currentAwaitingResponse = currentRuntime.awaitingResponse ?? false
    const nextAwaitingResponse =
      provider === 'copilot'
        ? reduceCopilotAwaitingResponseState(currentAwaitingResponse, line)
        : currentAwaitingResponse

    if (
      nextAttention === currentAttention &&
      nextAwaitingResponse === currentAwaitingResponse
    ) {
      return
    }

    this.setRuntime(sessionId, {
      attention: nextAttention,
      awaitingResponse: nextAwaitingResponse,
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

    const projectMemoryMode = PROJECT_MEMORY_MODES.includes(
      config.projectMemoryMode as typeof PROJECT_MEMORY_MODES[number],
    )
      ? (config.projectMemoryMode as typeof PROJECT_MEMORY_MODES[number])
      : 'disabled'

    return {
      ...config,
      projectId: project.id,
      locationId: location.id,
      title,
      pendingFirstPromptTitle: this.inferPendingFirstPromptTitle(config, cwd, title),
      cwd,
      shell: resolveShellCommand(config.shell),
      projectMemoryMode,
      projectMemoryFallbackReason: config.projectMemoryFallbackReason ?? null,
    }
  }

  private resolveHydratedSessionTitle(
    config: StoredSessionConfig,
    cwd: string,
  ): string {
    const title = isLowSignalSessionTitle(config.title, config.startupCommand, cwd)
      ? deriveSessionTitle(undefined, config.startupCommand, cwd)
      : deriveSessionTitle(config.title, config.startupCommand, cwd)
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

    return isLowSignalSessionTitle(title, config.startupCommand, cwd)
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

    return isLowSignalSessionTitle(title, config.startupCommand, cwd)
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
    this.updateRestoreSnapshot(
      id,
      (current) => applyRuntimeToSessionRestoreSnapshot(current, nextRuntime),
    )
    if (Object.keys(patch).length > 0) {
      this.appendTranscriptEvent({
        sessionId: id,
        kind: 'runtime',
        source: 'system',
        metadata: {
          attention: nextRuntime.attention ?? null,
          awaitingResponse: nextRuntime.awaitingResponse ?? false,
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
      const config = this.configs.get(id)
      const currentRuntime = this.runtimes.get(id) ?? buildRuntime(id)
      const runtimePatch: Partial<Omit<SessionRuntime, 'sessionId'>> = {}

      if (currentRuntime.attention !== null) {
        runtimePatch.attention = null
      }

      if (
        config &&
        /[\r\n]/u.test(data) &&
        (config.externalSession?.provider === 'copilot' ||
          supportsCopilotSessionResume(config.startupCommand)) &&
        currentRuntime.awaitingResponse !== true
      ) {
        runtimePatch.awaitingResponse = true
      }

      this.capturePendingFirstPromptTitle(id, data)

      if (Object.keys(runtimePatch).length > 0) {
        this.cancelDebouncedTouchRuntime(id)
        this.setRuntime(id, runtimePatch)
      } else {
        this.debouncedTouchRuntime(id)
      }

      this.appendInputTranscriptBatched(id, data)
    } else {
      this.appendTranscriptEvent({
        sessionId: id,
        kind: 'input',
        source,
        chunk: data,
      })
    }

    this.writeToTerminal(id, data)
  }

  private writeToTerminal(id: string, data: string): void {
    this.terminals.get(id)?.write(data)
  }

  private debouncedTouchRuntime(id: string): void {
    const current = this.runtimes.get(id)
    if (current) {
      current.lastActiveAt = new Date().toISOString()
    }

    if (this.touchRuntimeTimers.has(id)) {
      return
    }

    this.touchRuntimeTimers.set(
      id,
      setTimeout(() => {
        this.touchRuntimeTimers.delete(id)
        const runtime = this.runtimes.get(id)
        if (runtime) {
          runtime.lastActiveAt = new Date().toISOString()
          this.events.onRuntime({ sessionId: id, runtime })
        }
      }, TOUCH_RUNTIME_DEBOUNCE_MS),
    )
  }

  private cancelDebouncedTouchRuntime(id: string): void {
    const timer = this.touchRuntimeTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.touchRuntimeTimers.delete(id)
    }
  }

  private appendInputTranscriptBatched(id: string, chunk: string): void {
    const buffer = this.inputTranscriptBuffers.get(id)
    if (buffer) {
      buffer.push(chunk)
    } else {
      this.inputTranscriptBuffers.set(id, [chunk])
    }

    if (/[\r\n]/u.test(chunk)) {
      this.flushInputTranscript(id)
      return
    }

    if (!this.inputTranscriptTimers.has(id)) {
      this.inputTranscriptTimers.set(
        id,
        setTimeout(() => {
          this.flushInputTranscript(id)
        }, INPUT_TRANSCRIPT_FLUSH_MS),
      )
    }
  }

  private flushInputTranscript(id: string): void {
    const timer = this.inputTranscriptTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.inputTranscriptTimers.delete(id)
    }

    const chunks = this.inputTranscriptBuffers.get(id)
    if (!chunks?.length) {
      return
    }

    this.inputTranscriptBuffers.delete(id)
    this.appendTranscriptEvent({
      sessionId: id,
      kind: 'input',
      source: 'user',
      chunk: chunks.join(''),
    })
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
    const event: TranscriptEvent = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      projectId,
      locationId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      chunk: input.chunk,
      metadata: input.metadata,
    }
    return this.transcriptStore.append(event).then(() => {
      this.updateRestoreSnapshot(
        input.sessionId,
        (current) => applyTranscriptEventToSessionRestoreSnapshot(current, event),
      )
    })
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
      restore: this.restoreSnapshots.get(id),
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
      restoreSnapshots: Object.fromEntries(
        Array.from(this.restoreSnapshots.entries()).filter(([sessionId]) =>
          this.configs.has(sessionId),
        ),
      ),
      copilotInstructionSnapshots: Object.fromEntries(
        Array.from(this.copilotInstructionSnapshots.entries()).filter(
          ([sessionId, snapshot]) =>
            this.configs.has(sessionId) && snapshot.trim().length > 0,
        ),
      ),
      activeSessionId: this.activeSessionId,
    })
  }

  private normalizePath(value: string): string {
    return value.trim().replace(/[\\/]+$/, '').toLowerCase()
  }

  private shouldBackfillRestoreSnapshot(id: string): boolean {
    const restore = this.restoreSnapshots.get(id)
    if (!restore) {
      return true
    }

    return (
      !restore.blockedReason &&
      !restore.lastError &&
      !restore.resultSummary &&
      !restore.lastMeaningfulReply &&
      !restore.hasTranscript
    )
  }

  private async backfillRestoreSnapshotsFromTranscriptTail(): Promise<void> {
    let shouldPersist = false

    for (const config of this.configs.values()) {
      if (!this.shouldBackfillRestoreSnapshot(config.id)) {
        continue
      }

      const runtime = this.runtimes.get(config.id) ?? buildRuntime(config.id)
      let tailEvents: TranscriptEvent[] = []
      try {
        tailEvents =
          (await this.transcriptStore.readTailEvents?.(config.id, {
            maxBytes: SESSION_RESTORE_BACKFILL_MAX_BYTES,
            maxEvents: SESSION_RESTORE_BACKFILL_MAX_EVENTS,
          })) ?? []
      } catch {
        continue
      }
      if (tailEvents.length === 0) {
        continue
      }

      let nextRestoreSnapshot =
        this.restoreSnapshots.get(config.id) ??
        buildSessionRestoreSnapshot(runtime)

      for (const event of tailEvents) {
        nextRestoreSnapshot = applyTranscriptEventToSessionRestoreSnapshot(
          nextRestoreSnapshot,
          event,
        )
      }

      nextRestoreSnapshot = normalizeSessionRestoreSnapshot(
        nextRestoreSnapshot,
        runtime,
      )
      const currentRestoreSnapshot = this.restoreSnapshots.get(config.id)
      if (sessionRestoreSnapshotsEqual(currentRestoreSnapshot, nextRestoreSnapshot)) {
        continue
      }

      this.restoreSnapshots.set(config.id, nextRestoreSnapshot)
      shouldPersist = true
    }

    if (shouldPersist) {
      this.persist()
    }
  }

  private updateRestoreSnapshot(
    id: string,
    updater: (current: SessionRestoreSnapshot) => SessionRestoreSnapshot,
    persist = true,
  ): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) {
      return
    }

    const current =
      this.restoreSnapshots.get(id) ?? buildSessionRestoreSnapshot(runtime)
    const next = normalizeSessionRestoreSnapshot(updater(current), runtime)
    if (sessionRestoreSnapshotsEqual(current, next)) {
      return
    }

    this.restoreSnapshots.set(id, next)
    if (persist && this.configs.has(id)) {
      this.persist()
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return 'Unknown error'
  }
}
