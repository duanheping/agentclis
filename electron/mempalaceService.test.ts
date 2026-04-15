// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MempalaceService } from './mempalaceService'
import type { TranscriptEvent } from '../src/shared/projectMemory'

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
