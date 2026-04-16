// @vitest-environment node

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MempalaceService } from './mempalaceService'
import type {
  ProjectMemoryCandidate,
  SessionSummary,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type { MempalaceLegacyImportBundle } from '../src/shared/memoryIndex'

const tempRoots: string[] = []

function buildStatus() {
  return {
    backend: 'mempalace' as const,
    repo: 'https://github.com/duanheping/mempalace.git',
    commit: '74e5bf6090cb239b1b48b5a015670842a99a2c8c',
    installState: 'installed' as const,
    runtimeState: 'running' as const,
    installRoot: 'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\tools\\mempalace\\74e5bf6090cb239b1b48b5a015670842a99a2c8c',
    palacePath: 'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\mempalace\\palace',
    pythonPath: 'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\tools\\mempalace\\74e5bf6090cb239b1b48b5a015670842a99a2c8c\\venv\\Scripts\\python.exe',
    module: 'mempalace.mcp_server',
    message: 'MemPalace runtime is running.',
    lastError: null,
  }
}

function buildLookupKey(wing: string, room: string, content: string): string {
  const hash = createHash('sha1')
  hash.update(wing)
  hash.update('\u0000')
  hash.update(room)
  hash.update('\u0000')
  hash.update(content)
  return hash.digest('hex')
}

describe('MempalaceService', () => {
  it('delegates runtime status and install calls', async () => {
    const status = buildStatus()
    const runtime = {
      getStatus: vi.fn().mockResolvedValue(status),
      installRuntime: vi.fn().mockResolvedValue({
        success: true,
        status,
      }),
    }
    const bridge = {
      search: vi.fn(),
      addDrawer: vi.fn(),
    }
    const service = new MempalaceService(runtime, bridge)

    await expect(service.getStatus()).resolves.toEqual(status)
    await expect(service.installRuntime()).resolves.toEqual({
      success: true,
      status,
    })
  })

  it('maps MemPalace search hits into renderer-safe search results', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)
    const runtime = {
      getStatus: vi.fn(),
      installRuntime: vi.fn(),
    }
    const bridge = {
      search: vi.fn().mockResolvedValue({
        query: 'workflow',
        results: [
          {
            text: 'Capture durable workflow memory after each session.',
            wing: 'project_alpha',
            room: 'workflow',
            source_file: 'session-1.jsonl',
            similarity: 0.91,
            distance: 0.09,
          },
        ],
      }),
      addDrawer: vi.fn(),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })

    const result = await service.search({
      query: 'workflow',
      projectId: 'project-1',
      limit: 5,
    })

    expect(bridge.search).toHaveBeenCalledWith({
      query: 'workflow',
      limit: 5,
      wing: 'project-1',
      room: null,
      context: null,
    })
    expect(result.hitCount).toBe(1)
    expect(result.hits[0]).toEqual(
      expect.objectContaining({
        backend: 'mempalace',
        wing: 'project_alpha',
        room: 'workflow',
        sourceLabel: 'session-1.jsonl',
        similarity: 0.91,
        distance: 0.09,
      }),
    )
  })

  it('returns a warning instead of throwing when backend search fails', async () => {
    const runtime = {
      getStatus: vi.fn(),
      installRuntime: vi.fn(),
    }
    const bridge = {
      search: vi.fn().mockRejectedValue(new Error('MemPalace bridge disconnected')),
      addDrawer: vi.fn(),
    }
    const service = new MempalaceService(runtime, bridge)

    const result = await service.search({
      query: 'decision',
    })

    expect(result.hitCount).toBe(0)
    expect(result.warning).toContain('MemPalace bridge disconnected')
  })

  it('indexes transcript chunks and enriches later search hits with provenance', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const transcript: TranscriptEvent[] = [
      {
        id: 'event-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-04-15T12:00:01.000Z',
        kind: 'input',
        source: 'user',
        chunk: 'Capture transcript memory',
      },
      {
        id: 'event-2',
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-04-15T12:00:02.000Z',
        kind: 'output',
        source: 'pty',
        chunk: 'Transcript memory captured.',
      },
    ]
    const bridge = {
      addDrawer: vi.fn().mockResolvedValue({
        success: true,
        drawer_id: 'drawer_project-1_transcript-raw_123',
      }),
      search: vi.fn().mockResolvedValue({
        results: [
          {
            text: 'User: Capture transcript memory\n\nAssistant: Transcript memory captured.',
            wing: 'project-1',
            room: 'transcript-raw',
            source_file: 'session-1.jsonl',
            similarity: 0.93,
            distance: 0.07,
          },
        ],
      }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })

    const indexResult = await service.indexSessionTranscript({
      project: {
        id: 'project-1',
        title: 'agentclis',
        rootPath: 'C:\\repo\\agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        identity: {
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: null,
        },
      },
      location: {
        id: 'location-1',
        projectId: 'project-1',
        rootPath: 'C:\\repo\\agentclis',
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: null,
        label: 'agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        lastSeenAt: '2026-04-15T12:00:00.000Z',
      },
      session: {
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
      },
      transcript,
      transcriptPath: 'C:\\transcripts\\session-1.jsonl',
    })

    expect(indexResult.status).toBe('indexed')
    expect(bridge.addDrawer).toHaveBeenCalledTimes(1)

    const searchResult = await service.search({
      query: 'transcript memory',
      projectId: 'project-1',
    })

    expect(searchResult.hits[0]).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        locationId: 'location-1',
        sessionId: 'session-1',
        timestampStart: '2026-04-15T12:00:01.000Z',
        timestampEnd: '2026-04-15T12:00:02.000Z',
        sourcePath: 'C:\\transcripts\\session-1.jsonl',
      }),
    )
  })

  it('skips re-adding transcript drawers when the same session is indexed again', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const transcript: TranscriptEvent[] = [
      {
        id: 'event-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-04-15T12:00:01.000Z',
        kind: 'input',
        source: 'user',
        chunk: 'Repeatable transcript memory',
      },
      {
        id: 'event-2',
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        timestamp: '2026-04-15T12:00:02.000Z',
        kind: 'output',
        source: 'pty',
        chunk: 'Repeatable transcript memory stored.',
      },
    ]
    const bridge = {
      addDrawer: vi.fn().mockResolvedValue({
        success: true,
        drawer_id: 'drawer_transcript',
      }),
      search: vi.fn().mockResolvedValue({ results: [] }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })
    const input = {
      project: {
        id: 'project-1',
        title: 'agentclis',
        rootPath: 'C:\\repo\\agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        identity: {
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: null,
        },
      },
      location: {
        id: 'location-1',
        projectId: 'project-1',
        rootPath: 'C:\\repo\\agentclis',
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: null,
        label: 'agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        lastSeenAt: '2026-04-15T12:00:00.000Z',
      },
      session: {
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
      },
      transcript,
      transcriptPath: 'C:\\transcripts\\session-1.jsonl',
    } as const

    const firstResult = await service.indexSessionTranscript(input)
    const secondResult = await service.indexSessionTranscript(input)

    expect(firstResult).toEqual(
      expect.objectContaining({
        status: 'indexed',
        indexedCount: 1,
        skippedCount: 0,
      }),
    )
    expect(secondResult).toEqual(
      expect.objectContaining({
        status: 'skipped',
        indexedCount: 0,
        skippedCount: 1,
      }),
    )
    expect(bridge.addDrawer).toHaveBeenCalledTimes(1)
  })

  it('skips re-adding structured drawers when the same logical candidate is indexed again', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const bridge = {
      addDrawer: vi.fn().mockResolvedValue({
        success: true,
        drawer_id: 'drawer_preference',
      }),
      search: vi.fn().mockResolvedValue({ results: [] }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })

    const baseInput = {
      project: {
        id: 'project-1',
        title: 'agentclis',
        rootPath: 'C:\\repo\\agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        identity: {
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: 'github.com/openai/agenclis',
        },
      },
      location: {
        id: 'location-1',
        projectId: 'project-1',
        rootPath: 'C:\\repo\\agentclis',
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: 'github.com/openai/agenclis',
        label: 'agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        lastSeenAt: '2026-04-15T12:00:00.000Z',
      },
      session: {
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
      },
      summary: {
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-04-15T12:00:10.000Z',
        extractionVersion: 2,
        summary: '   ',
        sourceEventIds: ['event-1'],
      } satisfies SessionSummary,
    } as const

    const firstResult = await service.indexStructuredSessionMemory({
      ...baseInput,
      candidates: [
        {
          id: 'candidate-1',
          projectId: 'project-1',
          locationId: null,
          kind: 'project-convention',
          scope: 'project',
          key: 'provider-native-bootstrap',
          content: 'Keep using provider-native instructions for bootstrap injection.',
          confidence: 0.91,
          status: 'active',
          createdAt: '2026-04-15T12:00:06.000Z',
          updatedAt: '2026-04-15T12:00:10.000Z',
          lastReinforcedAt: '2026-04-15T12:00:10.000Z',
          sourceSessionId: 'session-1',
          sourceEventIds: ['event-2'],
        },
      ] satisfies ProjectMemoryCandidate[],
    })
    const secondResult = await service.indexStructuredSessionMemory({
      ...baseInput,
      candidates: [
        {
          id: 'candidate-2',
          projectId: 'project-1',
          locationId: null,
          kind: 'project-convention',
          scope: 'project',
          key: 'provider-native-bootstrap',
          content: 'Keep using provider-native instructions for bootstrap injection.',
          confidence: 0.91,
          status: 'active',
          createdAt: '2026-04-15T12:00:07.000Z',
          updatedAt: '2026-04-15T12:00:11.000Z',
          lastReinforcedAt: '2026-04-15T12:00:11.000Z',
          sourceSessionId: 'session-1',
          sourceEventIds: ['event-2'],
        },
      ] satisfies ProjectMemoryCandidate[],
    })

    expect(firstResult).toEqual(
      expect.objectContaining({
        status: 'indexed',
        indexedCount: 1,
        skippedCount: 0,
      }),
    )
    expect(secondResult).toEqual(
      expect.objectContaining({
        status: 'skipped',
        indexedCount: 0,
        skippedCount: 1,
      }),
    )
    expect(bridge.addDrawer).toHaveBeenCalledTimes(1)
  })

  it('suppresses stale search hits when the same logical source is reindexed with new content', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const bridge = {
      addDrawer: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'drawer_summary_v1',
        })
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'drawer_summary_v2',
        }),
      search: vi.fn().mockResolvedValue({
        results: [
          {
            text: 'Old summary content.',
            wing: 'github.com/openai/agenclis',
            room: 'session-summary',
            source_file: 'mempalace://summary/session-1',
            similarity: 0.95,
          },
          {
            text: 'New summary content.',
            wing: 'github.com/openai/agenclis',
            room: 'session-summary',
            source_file: 'mempalace://summary/session-1',
            similarity: 0.91,
          },
        ],
      }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })

    const baseInput = {
      project: {
        id: 'project-1',
        title: 'agentclis',
        rootPath: 'C:\\repo\\agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        identity: {
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: 'github.com/openai/agenclis',
        },
      },
      location: {
        id: 'location-1',
        projectId: 'project-1',
        rootPath: 'C:\\repo\\agentclis',
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: 'github.com/openai/agenclis',
        label: 'agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        lastSeenAt: '2026-04-15T12:00:00.000Z',
      },
      session: {
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
      },
      candidates: [] satisfies ProjectMemoryCandidate[],
    } as const

    const firstResult = await service.indexStructuredSessionMemory({
      ...baseInput,
      summary: {
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-04-15T12:00:10.000Z',
        extractionVersion: 2,
        summary: 'Old summary content.',
        sourceEventIds: ['event-1'],
      },
    })
    const secondResult = await service.indexStructuredSessionMemory({
      ...baseInput,
      summary: {
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-04-15T12:00:12.000Z',
        extractionVersion: 2,
        summary: 'New summary content.',
        sourceEventIds: ['event-1', 'event-2'],
      },
    })

    expect(firstResult).toEqual(
      expect.objectContaining({
        status: 'indexed',
        indexedCount: 1,
        skippedCount: 0,
      }),
    )
    expect(secondResult).toEqual(
      expect.objectContaining({
        status: 'indexed',
        indexedCount: 1,
        skippedCount: 0,
      }),
    )
    expect(bridge.addDrawer).toHaveBeenCalledTimes(2)

    const searchResult = await service.search({
      query: 'summary content',
      wing: 'github.com/openai/agenclis',
    })

    expect(searchResult.hitCount).toBe(1)
    expect(searchResult.hits[0]).toEqual(
      expect.objectContaining({
        room: 'session-summary',
        sourceLabel: 'Session summary',
        textPreview: 'New summary content.',
      }),
    )
  })

  it('migrates legacy structured provenance keys before reindexing the same logical card', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const wing = 'github.com/openai/agenclis'
    const content = 'Keep using provider-native instructions for bootstrap injection.'
    const legacySourceFile =
      'mempalace://candidate/session-1/project-convention/candidate-legacy'
    const provenancePath = path.join(tempRoot, 'provenance.json')
    await writeFile(
      provenancePath,
      `${JSON.stringify(
        {
          recordsByLookupKey: {
            [buildLookupKey(wing, 'preference', content)]: {
              lookupKey: buildLookupKey(wing, 'preference', content),
              palaceDrawerId: 'legacy-drawer',
              drawerId: 'candidate-legacy',
              sourceFile: legacySourceFile,
              sourceLabel: 'project-convention:provider-native-bootstrap',
              projectId: 'project-1',
              locationId: null,
              sessionId: 'session-1',
              eventIds: ['event-2'],
              timestampStart: '2026-04-15T12:00:06.000Z',
              timestampEnd: '2026-04-15T12:00:10.000Z',
              sourceKind: 'project-convention',
              room: 'preference',
              wing,
              candidateId: 'candidate-legacy',
              candidateKind: 'project-convention',
              scope: 'project',
              memoryKey: 'provider-native-bootstrap',
              confidence: 0.91,
              status: 'active',
            },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const bridge = {
      addDrawer: vi.fn(),
      search: vi.fn().mockResolvedValue({ results: [] }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: provenancePath,
    })

    const result = await service.indexStructuredSessionMemory({
      project: {
        id: 'project-1',
        title: 'agentclis',
        rootPath: 'C:\\repo\\agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        identity: {
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: wing,
        },
      },
      location: {
        id: 'location-1',
        projectId: 'project-1',
        rootPath: 'C:\\repo\\agentclis',
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: wing,
        label: 'agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        lastSeenAt: '2026-04-15T12:00:00.000Z',
      },
      session: {
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
      },
      summary: {
        sessionId: 'session-1',
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-04-15T12:00:10.000Z',
        extractionVersion: 2,
        summary: '   ',
        sourceEventIds: ['event-1'],
      },
      candidates: [
        {
          id: 'candidate-1',
          projectId: 'project-1',
          locationId: null,
          kind: 'project-convention',
          scope: 'project',
          key: 'provider-native-bootstrap',
          content,
          confidence: 0.91,
          status: 'active',
          createdAt: '2026-04-15T12:00:06.000Z',
          updatedAt: '2026-04-15T12:00:10.000Z',
          lastReinforcedAt: '2026-04-15T12:00:10.000Z',
          sourceSessionId: 'session-1',
          sourceEventIds: ['event-2'],
        },
      ],
    })

    expect(result).toEqual(
      expect.objectContaining({
        status: 'skipped',
        indexedCount: 0,
        skippedCount: 1,
      }),
    )
    expect(bridge.addDrawer).not.toHaveBeenCalled()
  })

  it('indexes structured session summaries and candidates into MemPalace', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const bridge = {
      addDrawer: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'drawer_summary',
        })
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'drawer_decision',
        })
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'drawer_preference',
        }),
      search: vi.fn().mockResolvedValue({
        results: [
          {
            text: 'Captured durable memory from the session.',
            wing: 'github.com/openai/agenclis',
            room: 'session-summary',
            source_file: 'mempalace://summary/session-1',
            similarity: 0.96,
          },
          {
            text: 'Keep using provider-native instructions for bootstrap injection.',
            wing: 'github.com/openai/agenclis',
            room: 'preference',
            source_file: 'mempalace://candidate/session-1/project-convention/candidate-2',
            similarity: 0.9,
          },
        ],
      }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })

    const summary: SessionSummary = {
      sessionId: 'session-1',
      projectId: 'project-1',
      locationId: 'location-1',
      generatedAt: '2026-04-15T12:00:10.000Z',
      extractionVersion: 2,
      summary: 'Captured durable memory from the session.',
      sourceEventIds: ['event-1', 'event-2'],
    }
    const candidates: ProjectMemoryCandidate[] = [
      {
        id: 'candidate-1',
        projectId: 'project-1',
        locationId: 'location-1',
        kind: 'decision',
        scope: 'project',
        key: 'use-mempalace',
        content: 'Use MemPalace as the durable retrieval backend.',
        confidence: 0.94,
        status: 'active',
        createdAt: '2026-04-15T12:00:05.000Z',
        updatedAt: '2026-04-15T12:00:10.000Z',
        lastReinforcedAt: '2026-04-15T12:00:10.000Z',
        sourceSessionId: 'session-1',
        sourceEventIds: ['event-1', 'event-2'],
      },
      {
        id: 'candidate-2',
        projectId: 'project-1',
        locationId: 'location-1',
        kind: 'project-convention',
        scope: 'project',
        key: 'provider-native-bootstrap',
        content: 'Keep using provider-native instructions for bootstrap injection.',
        confidence: 0.91,
        status: 'active',
        createdAt: '2026-04-15T12:00:06.000Z',
        updatedAt: '2026-04-15T12:00:10.000Z',
        lastReinforcedAt: '2026-04-15T12:00:10.000Z',
        sourceSessionId: 'session-1',
        sourceEventIds: ['event-2'],
      },
    ]

    const indexResult = await service.indexStructuredSessionMemory({
      project: {
        id: 'project-1',
        title: 'agentclis',
        rootPath: 'C:\\repo\\agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        identity: {
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: 'github.com/openai/agenclis',
        },
      },
      location: {
        id: 'location-1',
        projectId: 'project-1',
        rootPath: 'C:\\repo\\agentclis',
        repoRoot: null,
        gitCommonDir: null,
        remoteFingerprint: 'github.com/openai/agenclis',
        label: 'agentclis',
        createdAt: '2026-04-15T12:00:00.000Z',
        updatedAt: '2026-04-15T12:00:00.000Z',
        lastSeenAt: '2026-04-15T12:00:00.000Z',
      },
      session: {
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
      },
      summary,
      candidates,
    })

    expect(indexResult).toEqual(
      expect.objectContaining({
        status: 'indexed',
        indexedCount: 3,
      }),
    )

    const searchResult = await service.search({
      query: 'bootstrap injection',
      projectId: 'project-1',
    })

    expect(searchResult.hits[0]).toEqual(
      expect.objectContaining({
        room: 'session-summary',
        sourceLabel: 'Session summary',
        sessionId: 'session-1',
        sourcePath: null,
      }),
    )
    expect(searchResult.hits[1]).toEqual(
      expect.objectContaining({
        room: 'preference',
        sourceLabel: 'project-convention:provider-native-bootstrap',
        sessionId: 'session-1',
        sourcePath: null,
      }),
    )
  })

  it('imports legacy artifact records into MemPalace with preserved source paths', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-mempalace-service-'))
    tempRoots.push(tempRoot)

    const runtime = {
      getStatus: vi.fn().mockResolvedValue(buildStatus()),
      installRuntime: vi.fn(),
    }
    const bridge = {
      addDrawer: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'legacy-summary',
        })
        .mockResolvedValueOnce({
          success: true,
          drawer_id: 'legacy-architecture',
        }),
      search: vi.fn().mockResolvedValue({
        results: [
          {
            text: 'Legacy summary imported from disk.',
            wing: 'github.com/openai/agenclis',
            room: 'session-summary',
            source_file:
              'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\summaries\\session-1.json#summary',
            similarity: 0.95,
          },
          {
            text: 'Legacy architecture overview.',
            wing: 'github.com/openai/agenclis',
            room: 'architecture',
            source_file:
              'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\architecture.json#overview',
            similarity: 0.9,
          },
        ],
      }),
    }
    const service = new MempalaceService(runtime, bridge, {
      indexStatePath: path.join(tempRoot, 'provenance.json'),
    })
    const bundle: MempalaceLegacyImportBundle = {
      projectId: 'project-1',
      wing: 'github.com/openai/agenclis',
      records: [
        {
          drawerId: 'legacy-summary:session-1',
          content: 'Legacy summary imported from disk.',
          sourceFile:
            'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\summaries\\session-1.json#summary',
          sourceLabel:
            'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\summaries\\session-1.json',
          projectId: 'project-1',
          locationId: 'location-1',
          sessionId: 'session-1',
          eventIds: ['event-1'],
          timestampStart: '2026-04-10T12:00:00.000Z',
          timestampEnd: '2026-04-10T12:00:00.000Z',
          sourceKind: 'session-summary',
          room: 'session-summary',
          wing: 'github.com/openai/agenclis',
        },
        {
          drawerId: 'legacy-architecture:project-1',
          content: 'Legacy architecture overview.',
          sourceFile:
            'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\architecture.json#overview',
          sourceLabel:
            'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\architecture.json',
          projectId: 'project-1',
          locationId: null,
          sessionId: '',
          eventIds: [],
          timestampStart: '2026-04-10T12:00:00.000Z',
          timestampEnd: '2026-04-10T12:00:00.000Z',
          sourceKind: 'architecture',
          room: 'architecture',
          wing: 'github.com/openai/agenclis',
        },
      ],
    }

    const importResult = await service.importLegacyProjectMemory(bundle)

    expect(importResult).toEqual(
      expect.objectContaining({
        status: 'indexed',
        indexedCount: 2,
      }),
    )

    const searchResult = await service.search({
      query: 'legacy',
      wing: 'github.com/openai/agenclis',
    })

    expect(searchResult.hits[0]).toEqual(
      expect.objectContaining({
        sourceLabel:
          'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\summaries\\session-1.json',
        sourcePath:
          'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\summaries\\session-1.json',
        sessionId: 'session-1',
      }),
    )
    expect(searchResult.hits[1]).toEqual(
      expect.objectContaining({
        sourceLabel:
          'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\architecture.json',
        sourcePath:
          'C:\\memory\\.agenclis-memory\\projects\\remote-github.com-openai-agenclis\\architecture.json',
        sessionId: null,
      }),
    )
  })
})

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (tempRoot) => {
      await rm(tempRoot, { recursive: true, force: true })
    }),
  )
})
