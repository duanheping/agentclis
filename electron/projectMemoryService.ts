import Store from 'electron-store'

import type {
  AssembledProjectContext,
  ProjectLocation,
} from '../src/shared/projectMemory'
import type {
  ProjectConfig,
  SessionConfig,
} from '../src/shared/session'
import type {
  ProjectMemoryDiagnosticEntry,
  ProjectMemoryDiagnosticReporter,
  ProjectMemoryManager,
} from './projectMemoryManager'
import type { TranscriptStore } from './transcriptStore'

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
  private readonly transcriptStore: Pick<TranscriptStore, 'readEvents' | 'readIndex'>
  private readonly lowPriorityDelayMs: number
  private readonly retryDelayMs: number
  private readonly maxAttempts: number

  private state: PersistedProjectMemoryState
  private drainTimer: NodeJS.Timeout | null = null
  private processing = false
  private disposed = false
  private blockedByMissingLibraryRoot = false

  constructor(
    manager: ProjectMemoryManager,
    transcriptStore: Pick<TranscriptStore, 'readEvents' | 'readIndex'>,
    options: ProjectMemoryServiceOptions = {},
  ) {
    this.manager = manager
    this.transcriptStore = transcriptStore
    this.lowPriorityDelayMs = options.lowPriorityDelayMs ?? 3_000
    this.retryDelayMs = options.retryDelayMs ?? 4_000
    this.maxAttempts = options.maxAttempts ?? 3
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
    this.enqueueJob('capture-session', 'high', input)
  }

  scheduleBackfillSessions(inputs: ProjectMemoryJobPayload[]): void {
    for (const input of inputs) {
      this.enqueueJob('backfill-session', 'low', input)
    }
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

    if (!this.manager.isEnabled()) {
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

    if (!this.disposed && this.state.jobs.length > 0 && this.manager.isEnabled()) {
      this.scheduleDrain(this.retryDelayMs)
    }
  }

  private async processJob(job: ProjectMemoryJob): Promise<boolean> {
    try {
      if (job.type === 'backfill-session') {
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
      await this.manager.captureSession({
        ...job.payload,
        transcript,
      })
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
}
