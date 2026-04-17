// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { deriveMempalaceWing } from '../src/shared/memoryIndex'
import type { TranscriptEvent } from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import { MempalaceIndexer } from './mempalaceIndexer'

function buildProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: 'project-1',
    title: 'agentclis',
    rootPath: 'C:\\repo\\agentclis',
    createdAt: '2026-04-15T12:00:00.000Z',
    updatedAt: '2026-04-15T12:00:00.000Z',
    identity: {
      repoRoot: 'C:\\repo\\agentclis',
      gitCommonDir: 'C:\\repo\\agentclis\\.git',
      remoteFingerprint: 'github.com/duanheping/agentclis',
    },
    ...overrides,
  }
}

function buildSession(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    title: 'Codex',
    startupCommand: 'codex',
    pendingFirstPromptTitle: false,
    cwd: 'C:\\repo\\agentclis',
    shell: 'pwsh.exe',
    createdAt: '2026-04-15T12:00:00.000Z',
    updatedAt: '2026-04-15T12:00:00.000Z',
    ...overrides,
  }
}

function buildEvent(
  id: string,
  kind: TranscriptEvent['kind'],
  chunk: string,
  timestamp: string,
): TranscriptEvent {
  return {
    id,
    sessionId: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    timestamp,
    kind,
    source: kind === 'output' ? 'pty' : 'user',
    chunk,
  }
}

describe('MempalaceIndexer', () => {
  it('derives the wing from remote fingerprint before falling back to project id', () => {
    expect(
      deriveMempalaceWing(buildProject(), null),
    ).toBe('remote-github.com-duanheping-agentclis')

    expect(
      deriveMempalaceWing(
        buildProject({
          identity: {
            repoRoot: null,
            gitCommonDir: null,
            remoteFingerprint: null,
          },
        }),
        null,
      ),
    ).toBe('project-1')
  })

  it('builds deterministic transcript chunks with provenance metadata', () => {
    const indexer = new MempalaceIndexer({
      maxChunkChars: 120,
      maxEventsPerChunk: 2,
    })
    const transcript = [
      buildEvent('event-1', 'input', 'Summarize the restore bug.', '2026-04-15T12:00:01.000Z'),
      buildEvent('event-2', 'output', 'I checked sessionManager.ts.', '2026-04-15T12:00:02.000Z'),
      buildEvent('event-3', 'output', 'The historical match path needs a title gate.', '2026-04-15T12:00:03.000Z'),
      buildEvent('event-4', 'input', 'Add a regression test.', '2026-04-15T12:00:04.000Z'),
    ]

    const firstRun = indexer.buildTranscriptChunks({
      project: buildProject(),
      location: null,
      session: buildSession(),
      transcript,
    })
    const secondRun = indexer.buildTranscriptChunks({
      project: buildProject(),
      location: null,
      session: buildSession(),
      transcript,
    })

    expect(firstRun).toEqual(secondRun)
    expect(firstRun).toHaveLength(2)
    expect(firstRun[0]).toEqual(
      expect.objectContaining({
        drawerId: expect.any(String),
        content: expect.stringContaining('User: Summarize the restore bug.'),
        metadata: expect.objectContaining({
          projectId: 'project-1',
          sessionId: 'session-1',
          room: 'transcript-raw',
          sourceKind: 'transcript-raw',
          wing: 'remote-github.com-duanheping-agentclis',
          eventIds: ['event-1', 'event-2'],
          timestampStart: '2026-04-15T12:00:01.000Z',
          timestampEnd: '2026-04-15T12:00:02.000Z',
        }),
      }),
    )
    expect(firstRun[1]?.metadata.eventIds).toEqual(['event-3', 'event-4'])
  })

  it('skips empty events and keeps metadata-only runtime events', () => {
    const indexer = new MempalaceIndexer({
      maxChunkChars: 500,
      maxEventsPerChunk: 10,
    })
    const transcript: TranscriptEvent[] = [
      buildEvent('event-1', 'input', '   ', '2026-04-15T12:00:01.000Z'),
      {
        id: 'event-2',
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-04-15T12:00:02.000Z',
        kind: 'runtime',
        source: 'system',
        metadata: {
          event: 'session-resumed',
          pid: 4120,
        },
      },
    ]

    const chunks = indexer.buildTranscriptChunks({
      project: buildProject(),
      location: null,
      session: buildSession(),
      transcript,
    })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.content).toContain('Runtime:')
    expect(chunks[0]?.metadata.eventIds).toEqual(['event-2'])
  })
})
