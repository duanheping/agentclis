// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectLocation,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'

const storeState = vi.hoisted(() => {
  let persistedState: unknown = null
  return {
    get: () => persistedState,
    set: (value: unknown) => {
      persistedState = structuredClone(value)
    },
    reset: () => {
      persistedState = null
    },
  }
})

vi.mock('electron-store', () => {
  return {
    default: class StoreMock<T> {
      store: T

      constructor(options?: { defaults?: T }) {
        const initial = storeState.get() ?? options?.defaults ?? {}
        this.store = structuredClone(initial) as T
      }

      set(value: T): void {
        this.store = structuredClone(value)
        storeState.set(this.store)
      }
    },
  }
})

import { ProjectMemoryService } from './projectMemoryService'

function buildProject(): ProjectConfig {
  return {
    id: 'project-1',
    title: 'agenclis',
    rootPath: 'C:\\repo\\agenclis',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    primaryLocationId: 'location-1',
    identity: {
      repoRoot: 'C:\\repo\\agenclis',
      gitCommonDir: 'C:\\repo\\agenclis\\.git',
      remoteFingerprint: 'github.com/openai/agenclis',
    },
  }
}

function buildLocation(): ProjectLocation {
  return {
    id: 'location-1',
    projectId: 'project-1',
    rootPath: 'C:\\repo\\agenclis',
    repoRoot: 'C:\\repo\\agenclis',
    gitCommonDir: 'C:\\repo\\agenclis\\.git',
    remoteFingerprint: 'github.com/openai/agenclis',
    label: 'agenclis',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
    lastSeenAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildSession(): SessionConfig {
  return {
    id: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    title: 'Codex',
    startupCommand: 'codex',
    pendingFirstPromptTitle: false,
    cwd: 'C:\\repo\\agenclis',
    shell: 'pwsh.exe',
    createdAt: '2026-03-22T12:00:00.000Z',
    updatedAt: '2026-03-22T12:00:00.000Z',
  }
}

function buildTranscriptStore(
  overrides: Record<string, unknown> = {},
) {
  return {
    getBaseRoot: vi.fn(() => 'C:\\transcripts'),
    getIndexPath: vi.fn((sessionId: string) => `C:\\transcripts\\${sessionId}.index.json`),
    getTranscriptPath: vi.fn((sessionId: string) => `C:\\transcripts\\${sessionId}.jsonl`),
    readIndex: vi.fn(async () => ({
      eventCount: 1,
      lastEventAt: '2026-03-22T12:00:05.000Z',
      projectId: 'project-1',
      locationId: 'location-1',
    })),
    readEvents: vi.fn(async () => []),
    ...overrides,
  }
}

describe('ProjectMemoryService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storeState.reset()
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  it('returns a lightweight warning context when project memory is disabled', async () => {
    const manager = {
      isEnabled: vi.fn(() => false),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(),
      captureSession: vi.fn(),
    }
    const transcriptStore = buildTranscriptStore()
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
    )

    const context = await service.assembleContext({
      project: buildProject(),
      location: buildLocation(),
    })

    expect(context.bootstrapMessage).toContain('Project memory is unavailable')
    expect(manager.assembleContext).not.toHaveBeenCalled()
    service.dispose()
  })

  it('uses the bootstrap composer even when the legacy library root is disabled', async () => {
    const manager = {
      isEnabled: vi.fn(() => false),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(),
      captureSession: vi.fn(),
    }
    const bootstrapComposer = {
      composeContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:00.000Z',
        bootstrapMessage: 'Bootstrap from MemPalace cards.',
        fileReferences: [],
        summaryExcerpt: 'MemPalace summary',
      })),
    }
    const transcriptStore = buildTranscriptStore()
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
      {
        bootstrapComposer,
      },
    )

    const context = await service.assembleContext({
      project: buildProject(),
      location: buildLocation(),
    })

    expect(context.bootstrapMessage).toBe('Bootstrap from MemPalace cards.')
    expect(bootstrapComposer.composeContext).toHaveBeenCalledTimes(1)
    expect(manager.assembleContext).not.toHaveBeenCalled()
    service.dispose()
  })

  it('keeps MemPalace as the authoritative bootstrap source when the composer returns no message', async () => {
    const manager = {
      isEnabled: vi.fn(() => true),
      assembleContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:00.000Z',
        bootstrapMessage: 'Legacy bootstrap should not be used.',
        fileReferences: ['C:\\memory\\memory.md'],
        summaryExcerpt: 'Legacy summary',
      })),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(),
      captureSession: vi.fn(),
    }
    const bootstrapComposer = {
      composeContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:00.000Z',
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
        architectureExcerpt: null,
      })),
    }
    const transcriptStore = buildTranscriptStore()
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
      {
        bootstrapComposer,
      },
    )

    const context = await service.assembleContext({
      project: buildProject(),
      location: buildLocation(),
    })

    expect(context.bootstrapMessage).toBeNull()
    expect(bootstrapComposer.composeContext).toHaveBeenCalledTimes(1)
    expect(manager.assembleContext).not.toHaveBeenCalled()
    service.dispose()
  })

  it('deduplicates low-priority backfill when a high-priority capture arrives for the same session', async () => {
    const manager = {
      isEnabled: vi.fn(() => true),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(async () => false),
      captureSession: vi.fn(async () => undefined),
    }
    const transcriptStore = buildTranscriptStore({
      readIndex: vi.fn(async () => ({
        eventCount: 3,
        lastEventAt: '2026-03-22T12:00:05.000Z',
        projectId: 'project-1',
        locationId: 'location-1',
      })),
      readEvents: vi.fn(async (): Promise<TranscriptEvent[]> => [
        {
          id: 'event-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          locationId: 'location-1',
          timestamp: '2026-03-22T12:00:00.000Z',
          kind: 'input',
          source: 'user',
          chunk: 'Capture durable workflow memory',
        },
      ]),
    })
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
    )
    const input = {
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
    }

    service.scheduleBackfillSessions([input])
    await service.captureSession(input)
    await vi.runOnlyPendingTimersAsync()

    expect(transcriptStore.readEvents).toHaveBeenCalledTimes(1)
    expect(manager.captureSession).toHaveBeenCalledTimes(1)
    expect(manager.captureSession).toHaveBeenCalledWith({
      ...input,
      transcript: expect.any(Array),
    })
    service.dispose()
  })


  it('keeps queued work pending until memory storage is configured, then resumes processing', async () => {
    let enabled = false
    const manager = {
      isEnabled: vi.fn(() => enabled),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(async () => false),
      captureSession: vi.fn(async () => undefined),
    }
    const transcriptStore = buildTranscriptStore()
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
    )

    await service.captureSession({
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
    })
    await vi.runOnlyPendingTimersAsync()

    expect(manager.captureSession).not.toHaveBeenCalled()

    enabled = true
    service.resume()
    await vi.runOnlyPendingTimersAsync()

    expect(manager.captureSession).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('indexes transcripts through MemPalace even when legacy project memory is disabled', async () => {
    const manager = {
      isEnabled: vi.fn(() => false),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(),
      captureSession: vi.fn(),
    }
    const memoryBackend = {
      indexSessionTranscript: vi.fn(async () => ({
        status: 'indexed' as const,
        sessionId: 'session-1',
        indexedCount: 1,
        skippedCount: 0,
        warning: null,
      })),
    }
    const transcriptStore = buildTranscriptStore({
      readEvents: vi.fn(async (): Promise<TranscriptEvent[]> => [
        {
          id: 'event-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          locationId: 'location-1',
          timestamp: '2026-03-22T12:00:00.000Z',
          kind: 'input',
          source: 'user',
          chunk: 'Index this transcript',
        },
      ]),
    })
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
      {
        memoryBackend,
      },
    )

    await service.captureSession({
      project: buildProject(),
      location: buildLocation(),
      session: buildSession(),
    })
    await vi.runOnlyPendingTimersAsync()

    expect(memoryBackend.indexSessionTranscript).toHaveBeenCalledTimes(1)
    expect(manager.captureSession).not.toHaveBeenCalled()
    service.dispose()
  })

  it('truncates oversized diagnostic messages before persisting and logging them', () => {
    const manager = {
      isEnabled: vi.fn(() => true),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(),
      captureSession: vi.fn(),
    }
    const transcriptStore = buildTranscriptStore()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
    )

    service.recordDiagnostic({
      timestamp: '2026-03-22T12:00:00.000Z',
      level: 'error',
      code: 'extractor-failed',
      message: 'x'.repeat(12_000),
      projectId: 'project-1',
      sessionId: 'session-1',
    })

    const persistedState = storeState.get() as { diagnostics: Array<{ message: string }> }
    expect(persistedState.diagnostics).toHaveLength(1)
    expect(persistedState.diagnostics[0]?.message.length).toBeLessThan(4_100)
    expect(persistedState.diagnostics[0]?.message).toContain('[truncated')
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[agenclis project memory] extractor-failed:'),
    )

    errorSpy.mockRestore()
    service.dispose()
  })

  it('groups stored sessions by project before historical sessions analysis', async () => {
    const manager = {
      isEnabled: vi.fn(() => true),
      assembleContext: vi.fn(),
      setDiagnosticReporter: vi.fn(),
      hasSessionSummary: vi.fn(),
      captureSession: vi.fn(),
      analyzeHistoricalSessions: vi.fn(async () => ({
        analyzedProjectCount: 1,
        analyzedSessionCount: 1,
      })),
    }
    const transcriptStore = buildTranscriptStore({
      readIndex: vi
        .fn()
        .mockResolvedValueOnce({
          eventCount: 5,
          lastEventAt: '2026-03-22T12:00:05.000Z',
          projectId: 'project-1',
          locationId: 'location-1',
        })
        .mockResolvedValueOnce({
          eventCount: 0,
          lastEventAt: null,
          projectId: 'project-1',
          locationId: 'location-1',
        }),
    })
    const service = new ProjectMemoryService(
      manager as never,
      transcriptStore,
      {
        lowPriorityDelayMs: 0,
        retryDelayMs: 0,
      },
    )
    const firstSession = buildSession()
    const secondSession = {
      ...buildSession(),
      id: 'session-2',
      updatedAt: '2026-03-22T12:10:00.000Z',
    }

    await expect(
      service.analyzeHistoricalSessions([
        {
          project: buildProject(),
          location: buildLocation(),
          session: firstSession,
        },
        {
          project: buildProject(),
          location: buildLocation(),
          session: secondSession,
        },
      ]),
    ).resolves.toEqual({
      analyzedProjectCount: 1,
      analyzedSessionCount: 1,
      skippedSessionCount: 1,
    })

    expect(manager.analyzeHistoricalSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        project: expect.objectContaining({
          id: 'project-1',
        }),
        transcriptBaseRoot: 'C:\\transcripts',
        sessions: [
          expect.objectContaining({
            session: expect.objectContaining({
              id: 'session-1',
            }),
            transcriptEventCount: 5,
            transcriptPath: 'C:\\transcripts\\session-1.jsonl',
            transcriptIndexPath: 'C:\\transcripts\\session-1.index.json',
          }),
        ],
      }),
    ])

    service.dispose()
  })
})
