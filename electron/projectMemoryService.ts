import Store from 'electron-store'

import type {
  AssembledProjectContext,
  ProjectLocation,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type {
  ProjectConfig,
  SessionConfig,
} from '../src/shared/session'
import type {
  HistoricalProjectSessionAnalysisInput,
  ProjectArchitectureAnalysisResult,
  ProjectMemoryDiagnosticEntry,
  ProjectMemoryDiagnosticReporter,
  ProjectMemoryManager,
  ProjectMemoryRefreshResult,
  ProjectSessionsAnalysisResult,
} from './projectMemoryManager'
import type { HistoricalProjectSessionDescriptor } from './projectSessionHistoryAgent'
import type { PreparedStructuredAgent } from './structuredAgentRunner'
import type { TranscriptStore } from './transcriptStore'
import type { MempalaceSessionIndexResult } from '../src/shared/memoryIndex'
import type { MemoryReindexResult } from '../src/shared/memorySearch'

type ProjectMemoryJobType = 'capture-session' | 'backfill-session'
type ProjectMemoryJobPriority = 'high' | 'low'

interface ProjectMemoryJobPayload {
  project: ProjectConfig
  location: ProjectLocation | null
  session: SessionConfig
}

interface ProjectMemoryJob {
  id: string
  type: ProjectMemoryJobType
  priority: ProjectMemoryJobPriority
  dedupeKey: string
  queuedAt: string
  attempts: number
  lastAttemptAt?: string
  lastError?: string
  payload: ProjectMemoryJobPayload
}

interface PersistedProjectMemoryState {
  jobs: ProjectMemoryJob[]
  diagnostics: ProjectMemoryDiagnosticEntry[]
}

interface ProjectMemoryServiceOptions {
  lowPriorityDelayMs?: number
  retryDelayMs?: number
  maxAttempts?: number
}

interface ProjectMemoryServiceDependencies {
  memoryBackend?: {
    indexSessionTranscript(input: ProjectMemoryJobPayload & {
      transcript: TranscriptEvent[]
      transcriptPath: string
    }): Promise<MempalaceSessionIndexResult>
  }
}

const MAX_DIAGNOSTICS = 80
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 4_000

function truncateDiagnosticText(
  value: string,
  maxLength = MAX_DIAGNOSTIC_MESSAGE_LENGTH,
): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  const suffix = `... [truncated ${normalized.length - maxLength} chars]`
  const sliceLength = Math.max(0, maxLength - suffix.length)
  return `${normalized.slice(0, sliceLength).trimEnd()}${suffix}`
}

function normalizeDiagnostic(
  diagnostic: ProjectMemoryDiagnosticEntry,
): ProjectMemoryDiagnosticEntry {
  return {
    timestamp: diagnostic.timestamp || new Date().toISOString(),
    level: diagnostic.level === 'error' ? 'error' : 'warning',
    code: diagnostic.code.trim() || 'unknown',
    message: truncateDiagnosticText(
      diagnostic.message.trim() || 'Unknown diagnostic.',
    ),
    projectId: diagnostic.projectId?.trim() || undefined,
    sessionId: diagnostic.sessionId?.trim() || undefined,
  }
}

function isValidJobType(value: unknown): value is ProjectMemoryJobType {
  return value === 'capture-session' || value === 'backfill-session'
}

function isValidPriority(value: unknown): value is ProjectMemoryJobPriority {
  return value === 'high' || value === 'low'
}

function normalizeJob(
  value: unknown,
): ProjectMemoryJob | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ProjectMemoryJob>
  if (
    !candidate.id ||
    !isValidJobType(candidate.type) ||
    !isValidPriority(candidate.priority) ||
    !candidate.dedupeKey ||
    !candidate.queuedAt ||
    !candidate.payload?.project ||
    !candidate.payload?.session
  ) {
    return null
  }

  return {
    id: candidate.id,
    type: candidate.type,
    priority: candidate.priority,
    dedupeKey: candidate.dedupeKey,
    queuedAt: candidate.queuedAt,
    attempts:
      typeof candidate.attempts === 'number' && candidate.attempts >= 0
        ? candidate.attempts
        : 0,
    lastAttemptAt:
      typeof candidate.lastAttemptAt === 'string' ? candidate.lastAttemptAt : undefined,
    lastError:
      typeof candidate.lastError === 'string'
        ? truncateDiagnosticText(candidate.lastError)
        : undefined,
    payload: structuredClone(candidate.payload),
  }
}

function normalizePersistedState(
  value: unknown,
): PersistedProjectMemoryState {
  const candidate = (value ?? {}) as Partial<PersistedProjectMemoryState>
  return {
    jobs: Array.isArray(candidate.jobs)
      ? candidate.jobs
          .map((job) => normalizeJob(job))
          .filter((job): job is ProjectMemoryJob => job !== null)
      : [],
    diagnostics: Array.isArray(candidate.diagnostics)
      ? candidate.diagnostics
          .filter((entry): entry is ProjectMemoryDiagnosticEntry => Boolean(entry))
          .map((entry) => normalizeDiagnostic(entry))
          .slice(-MAX_DIAGNOSTICS)
      : [],
  }
}

function compareJobs(left: ProjectMemoryJob, right: ProjectMemoryJob): number {
  if (left.priority !== right.priority) {
    return left.priority === 'high' ? -1 : 1
  }

  return left.queuedAt.localeCompare(right.queuedAt)
}

function dedupeKeyForSession(sessionId: string): string {
  return `session:${sessionId}`
}

export class ProjectMemoryService {
  private readonly store = new Store<PersistedProjectMemoryState>({
    name: 'agenclis-project-memory',
    defaults: {
      jobs: [],
      diagnostics: [],
    },
  })

  private readonly manager: ProjectMemoryManager
  private readonly transcriptStore: Pick<
    TranscriptStore,
    'getBaseRoot' | 'getIndexPath' | 'getTranscriptPath' | 'readEvents' | 'readIndex'
  >
  private readonly lowPriorityDelayMs: number
  private readonly retryDelayMs: number
  private readonly maxAttempts: number
  private readonly memoryBackend?: ProjectMemoryServiceDependencies['memoryBackend']

  private state: PersistedProjectMemoryState
  private drainTimer: NodeJS.Timeout | null = null
  private processing = false
  private disposed = false
  private blockedByMissingLibraryRoot = false

  constructor(
    manager: ProjectMemoryManager,
    transcriptStore: Pick<
      TranscriptStore,
      'getBaseRoot' | 'getIndexPath' | 'getTranscriptPath' | 'readEvents' | 'readIndex'
    >,
    options: ProjectMemoryServiceOptions = {},
    dependencies: ProjectMemoryServiceDependencies = {},
  ) {
    this.manager = manager
    this.transcriptStore = transcriptStore
    this.lowPriorityDelayMs = options.lowPriorityDelayMs ?? 3_000
    this.retryDelayMs = options.retryDelayMs ?? 4_000
    this.maxAttempts = options.maxAttempts ?? 3
    this.memoryBackend = dependencies.memoryBackend
    this.state = normalizePersistedState(this.store.store)
    this.store.set(structuredClone(this.state))

    const reporter: ProjectMemoryDiagnosticReporter = (entry) => {
      this.recordDiagnostic(entry)
    }
    this.manager.setDiagnosticReporter(reporter)

    if (this.state.jobs.length > 0) {
      this.scheduleDrain(this.lowPriorityDelayMs)
    }
  }

  async assembleContext(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    query?: string
  }): Promise<AssembledProjectContext> {
    if (this.manager.isEnabled()) {
      return await this.manager.assembleContext(input)
    }

    return {
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: new Date().toISOString(),
      bootstrapMessage:
        '[agenclis] Project memory is unavailable until the Skill Library root is configured.',
      fileReferences: [],
      summaryExcerpt: null,
    }
  }

  async captureSession(input: ProjectMemoryJobPayload): Promise<void> {
    if (this.disposed) {
      return
    }
    this.enqueueJob('capture-session', 'high', input)
  }

  scheduleBackfillSessions(inputs: ProjectMemoryJobPayload[]): void {
    if (this.disposed) {
      return
    }
    for (const input of inputs) {
      this.enqueueJob('backfill-session', 'low', input)
    }
  }

  async refreshHistoricalImport(
    projects: ProjectConfig[],
    options?: {
      regenerateArchitecture?: boolean
    },
  ): Promise<ProjectMemoryRefreshResult> {
    return await this.manager.refreshHistoricalImport(projects, options)
  }

  async analyzeHistoricalArchitecture(
    projects: ProjectConfig[],
  ): Promise<ProjectArchitectureAnalysisResult> {
    return await this.manager.analyzeHistoricalArchitecture(projects)
  }

  async analyzeHistoricalSessions(
    inputs: ProjectMemoryJobPayload[],
  ): Promise<ProjectSessionsAnalysisResult & { skippedSessionCount: number }> {
    const groupedByProject = new Map<string, HistoricalProjectSessionAnalysisInput>()
    let skippedSessionCount = 0

    for (const input of inputs) {
      const transcriptIndex = await this.transcriptStore.readIndex(input.session.id)
      if (transcriptIndex.eventCount === 0) {
        skippedSessionCount += 1
        continue
      }

      const existing = groupedByProject.get(input.project.id)
      const sessionDescriptor = {
        session: input.session,
        location: input.location,
        transcriptEventCount: transcriptIndex.eventCount,
        lastTranscriptEventAt: transcriptIndex.lastEventAt,
        transcriptPath: this.transcriptStore.getTranscriptPath(input.session.id),
        transcriptIndexPath: this.transcriptStore.getIndexPath(input.session.id),
      }

      if (!existing) {
        groupedByProject.set(input.project.id, {
          project: input.project,
          transcriptBaseRoot: this.transcriptStore.getBaseRoot(),
          sessions: [sessionDescriptor],
        })
        continue
      }

      existing.sessions.push(sessionDescriptor)
    }

    const result = await this.manager.analyzeHistoricalSessions(
      Array.from(groupedByProject.values()),
    )

    return {
      ...result,
      skippedSessionCount,
    }
  }

  async prepareArchitectureAnalysis(
    projects: ProjectConfig[],
  ): Promise<{
    project: ProjectConfig
    prepared: PreparedStructuredAgent
  }[]> {
    return await this.manager.prepareArchitectureAnalysis(projects)
  }

  async finalizeArchitectureAnalysis(
    project: ProjectConfig,
    rawOutput: string,
  ): Promise<ProjectArchitectureAnalysisResult> {
    return await this.manager.finalizeArchitectureAnalysis(project, rawOutput)
  }

  async prepareSessionsAnalysis(
    inputs: ProjectMemoryJobPayload[],
  ): Promise<{
    project: ProjectConfig
    sessions: HistoricalProjectSessionDescriptor[]
    prepared: PreparedStructuredAgent
  }[]> {
    const groupedByProject = new Map<string, HistoricalProjectSessionAnalysisInput>()

    for (const input of inputs) {
      const transcriptIndex = await this.transcriptStore.readIndex(input.session.id)
      if (transcriptIndex.eventCount === 0) {
        continue
      }

      const existing = groupedByProject.get(input.project.id)
      const sessionDescriptor = {
        session: input.session,
        location: input.location,
        transcriptEventCount: transcriptIndex.eventCount,
        lastTranscriptEventAt: transcriptIndex.lastEventAt,
        transcriptPath: this.transcriptStore.getTranscriptPath(input.session.id),
        transcriptIndexPath: this.transcriptStore.getIndexPath(input.session.id),
      }

      if (!existing) {
        groupedByProject.set(input.project.id, {
          project: input.project,
          transcriptBaseRoot: this.transcriptStore.getBaseRoot(),
          sessions: [sessionDescriptor],
        })
        continue
      }

      existing.sessions.push(sessionDescriptor)
    }

    return await this.manager.prepareSessionsAnalysis(
      Array.from(groupedByProject.values()),
    )
  }

  async finalizeSessionsAnalysis(
    project: ProjectConfig,
    sessions: HistoricalProjectSessionDescriptor[],
    rawOutput: string,
  ): Promise<ProjectSessionsAnalysisResult> {
    return await this.manager.finalizeSessionsAnalysis(
      project,
      sessions,
      rawOutput,
    )
  }

  resume(): void {
    this.blockedByMissingLibraryRoot = false
    this.scheduleDrain(60)
  }

  dispose(): void {
    this.disposed = true
    if (this.drainTimer) {
      clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
  }

  recordDiagnostic(entry: ProjectMemoryDiagnosticEntry): void {
    const diagnostic = normalizeDiagnostic(entry)
    this.state = {
      ...this.state,
      diagnostics: [...this.state.diagnostics, diagnostic].slice(-MAX_DIAGNOSTICS),
    }
    this.persist()

    const message = `[agenclis project memory] ${diagnostic.code}: ${diagnostic.message}`
    if (diagnostic.level === 'error') {
      console.error(message)
      return
    }

    console.warn(message)
  }

  private enqueueJob(
    type: ProjectMemoryJobType,
    priority: ProjectMemoryJobPriority,
    payload: ProjectMemoryJobPayload,
  ): void {
    if (this.disposed) {
      return
    }

    const dedupeKey = dedupeKeyForSession(payload.session.id)
    const now = new Date().toISOString()
    const existingJob = this.state.jobs.find((job) => job.dedupeKey === dedupeKey)

    if (existingJob) {
      existingJob.type =
        existingJob.type === 'capture-session' || type === 'capture-session'
          ? 'capture-session'
          : 'backfill-session'
      existingJob.priority =
        existingJob.priority === 'high' || priority === 'high' ? 'high' : 'low'
      existingJob.queuedAt = now
      existingJob.attempts = 0
      existingJob.lastAttemptAt = undefined
      existingJob.lastError = undefined
      existingJob.payload = structuredClone(payload)
    } else {
      this.state.jobs.push({
        id: crypto.randomUUID(),
        type,
        priority,
        dedupeKey,
        queuedAt: now,
        attempts: 0,
        payload: structuredClone(payload),
      })
    }

    this.state.jobs.sort(compareJobs)
    this.persist()
    this.scheduleDrain(priority === 'high' ? 80 : this.lowPriorityDelayMs)
  }

  private scheduleDrain(delayMs: number): void {
    if (this.disposed || this.processing || this.drainTimer) {
      return
    }

    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      void this.drainQueue()
    }, Math.max(0, delayMs))
  }

  private async drainQueue(): Promise<void> {
    if (this.processing || this.disposed) {
      return
    }

    if (!this.manager.isEnabled() && !this.memoryBackend) {
      if (!this.blockedByMissingLibraryRoot) {
        this.blockedByMissingLibraryRoot = true
        this.recordDiagnostic({
          timestamp: new Date().toISOString(),
          level: 'warning',
          code: 'memory-disabled',
          message:
            'Queued project-memory work is paused because the Skill Library root is not configured.',
        })
      }
      return
    }

    this.blockedByMissingLibraryRoot = false
    this.processing = true

    try {
      while (!this.disposed) {
        const nextJob = this.state.jobs[0]
        if (!nextJob) {
          break
        }

        const shouldContinue = await this.processJob(nextJob)
        if (!shouldContinue) {
          break
        }
      }
    } finally {
      this.processing = false
    }

    if (!this.disposed && this.state.jobs.length > 0) {
      this.scheduleDrain(this.retryDelayMs)
    }
  }

  private async processJob(job: ProjectMemoryJob): Promise<boolean> {
    try {
      const managerEnabled = this.manager.isEnabled()

      if (job.type === 'backfill-session' && managerEnabled) {
        const hasSessionSummary = await this.manager.hasSessionSummary(
          job.payload.project,
          job.payload.session.id,
        )
        if (hasSessionSummary) {
          this.removeJob(job.id)
          return true
        }

        const transcriptIndex = await this.transcriptStore.readIndex(job.payload.session.id)
        if (transcriptIndex.eventCount === 0) {
          this.removeJob(job.id)
          return true
        }
      }

      const transcript = await this.transcriptStore.readEvents(job.payload.session.id)
      const transcriptPath = this.transcriptStore.getTranscriptPath(job.payload.session.id)

      let memoryBackendResult: MempalaceSessionIndexResult | null = null
      if (this.memoryBackend) {
        memoryBackendResult = await this.memoryBackend.indexSessionTranscript({
          ...job.payload,
          transcript,
          transcriptPath,
        })
      }

      if (managerEnabled) {
        await this.manager.captureSession({
          ...job.payload,
          transcript,
        })
      } else if (memoryBackendResult?.status === 'deferred') {
        return false
      }

      this.removeJob(job.id)
      return true
    } catch (error) {
      const nextAttempts = job.attempts + 1
      const message = truncateDiagnosticText(
        error instanceof Error ? error.message : 'Unknown project-memory job failure.',
      )
      const nextJob: ProjectMemoryJob = {
        ...job,
        attempts: nextAttempts,
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
      }

      if (nextAttempts >= this.maxAttempts) {
        this.removeJob(job.id)
        this.recordDiagnostic({
          timestamp: new Date().toISOString(),
          level: 'error',
          code: 'job-dropped',
          message: `Dropped ${job.type} for ${job.payload.session.id} after ${nextAttempts} failed attempts: ${message}`,
          projectId: job.payload.project.id,
          sessionId: job.payload.session.id,
        })
        return true
      }

      this.upsertJob(nextJob)
      this.recordDiagnostic({
        timestamp: new Date().toISOString(),
        level: 'warning',
        code: 'job-retry',
        message: `Retrying ${job.type} for ${job.payload.session.id}: ${message}`,
        projectId: job.payload.project.id,
        sessionId: job.payload.session.id,
      })
      return false
    }
  }

  private upsertJob(job: ProjectMemoryJob): void {
    const index = this.state.jobs.findIndex((entry) => entry.id === job.id)
    if (index === -1) {
      this.state.jobs.push(job)
    } else {
      this.state.jobs[index] = job
    }

    this.state.jobs.sort(compareJobs)
    this.persist()
  }

  private removeJob(jobId: string): void {
    this.state.jobs = this.state.jobs.filter((job) => job.id !== jobId)
    this.persist()
  }

  private persist(): void {
    this.store.set(structuredClone(this.state))
  }

  async reindexTranscriptMemory(
    inputs: ProjectMemoryJobPayload[],
  ): Promise<MemoryReindexResult> {
    if (!this.memoryBackend) {
      return {
        backend: 'mempalace',
        projectId: inputs.length === 1 ? inputs[0]?.project.id ?? null : null,
        sessionsScanned: inputs.length,
        sessionsIndexed: 0,
        sessionsDeferred: 0,
        sessionsSkipped: inputs.length,
        errorCount: 0,
        warning: 'MemPalace transcript indexing is not configured.',
      }
    }

    const projectId = inputs.length === 1 ? inputs[0]?.project.id ?? null : null
    const result: MemoryReindexResult = {
      backend: 'mempalace',
      projectId,
      sessionsScanned: inputs.length,
      sessionsIndexed: 0,
      sessionsDeferred: 0,
      sessionsSkipped: 0,
      errorCount: 0,
      warning: null,
    }

    for (const input of inputs) {
      try {
        const transcriptIndex = await this.transcriptStore.readIndex(input.session.id)
        if (transcriptIndex.eventCount === 0) {
          result.sessionsSkipped += 1
          continue
        }

        const transcript = await this.transcriptStore.readEvents(input.session.id)
        const indexResult = await this.memoryBackend.indexSessionTranscript({
          ...input,
          transcript,
          transcriptPath: this.transcriptStore.getTranscriptPath(input.session.id),
        })

        if (indexResult.status === 'indexed') {
          result.sessionsIndexed += 1
        } else if (indexResult.status === 'deferred') {
          result.sessionsDeferred += 1
          result.warning = indexResult.warning
        } else {
          result.sessionsSkipped += 1
        }
      } catch (error) {
        result.errorCount += 1
        result.warning = error instanceof Error ? error.message : String(error)
      }
    }

    return result
  }
}
