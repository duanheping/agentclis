// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import type { AssembledProjectContext, ProjectLocation } from '../src/shared/projectMemory'
import type { ProjectConfig } from '../src/shared/session'
import { BootstrapComposer } from './bootstrapComposer'

function buildProject(): ProjectConfig {
  return {
    id: 'project-1',
    title: 'agentclis',
    rootPath: 'C:\\repo\\agentclis',
    createdAt: '2026-04-15T12:00:00.000Z',
    updatedAt: '2026-04-15T12:00:00.000Z',
    primaryLocationId: 'location-1',
    identity: {
      repoRoot: 'C:\\repo\\agentclis',
      gitCommonDir: 'C:\\repo\\agentclis\\.git',
      remoteFingerprint: 'github.com/openai/agenclis',
    },
  }
}

function buildLocation(): ProjectLocation {
  return {
    id: 'location-1',
    projectId: 'project-1',
    rootPath: 'C:\\repo\\agentclis',
    repoRoot: 'C:\\repo\\agentclis',
    gitCommonDir: 'C:\\repo\\agentclis\\.git',
    remoteFingerprint: 'github.com/openai/agenclis',
    label: 'agentclis',
    createdAt: '2026-04-15T12:00:00.000Z',
    updatedAt: '2026-04-15T12:00:00.000Z',
    lastSeenAt: '2026-04-15T12:00:00.000Z',
  }
}

describe('BootstrapComposer', () => {
  it('returns an empty context when MemPalace is unavailable', async () => {
    const memorySearch = {
      getStatus: vi.fn().mockRejectedValue(new Error('bridge offline')),
      search: vi.fn(),
    }
    const composer = new BootstrapComposer(memorySearch)

    const result = await composer.composeContext({
      project: buildProject(),
      location: buildLocation(),
    })

    expect(result).toEqual<AssembledProjectContext>({
      projectId: 'project-1',
      locationId: 'location-1',
      generatedAt: expect.any(String),
      bootstrapMessage: null,
      fileReferences: [],
      summaryExcerpt: null,
      architectureExcerpt: null,
    })
    expect(memorySearch.search).not.toHaveBeenCalled()
  })

  it('composes a structured bootstrap from MemPalace cards and uses searched source paths', async () => {
    const memorySearch = {
      getStatus: vi.fn().mockResolvedValue({
        backend: 'mempalace' as const,
        repo: 'https://github.com/duanheping/mempalace.git',
        commit: '74e5bf6090cb239b1b48b5a015670842a99a2c8c',
        installState: 'installed' as const,
        runtimeState: 'running' as const,
        installRoot: 'C:\\runtime',
        palacePath: 'C:\\palace',
        pythonPath: 'C:\\python.exe',
        module: 'mempalace.mcp_server',
        message: null,
        lastError: null,
      }),
      search: vi
        .fn()
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'latest summary',
          hitCount: 1,
          hits: [
            {
              id: 'summary-1',
              backend: 'mempalace' as const,
              textPreview: 'Structured summary from MemPalace.',
              similarity: 0.96,
              distance: null,
              sessionId: 'session-1',
              room: 'session-summary',
              sourceLabel: 'C:\\memory\\summaries\\latest.md',
            },
          ],
          warning: null,
        })
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'architecture overview',
          hitCount: 1,
          hits: [
            {
              id: 'architecture-1',
              backend: 'mempalace' as const,
              textPreview: 'Renderer -> preload -> main',
              similarity: 0.94,
              distance: null,
              sessionId: null,
              room: 'architecture',
              sourceLabel: 'C:\\memory\\architecture.json',
            },
          ],
          warning: null,
        })
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'key decisions',
          hitCount: 1,
          hits: [
            {
              id: 'decision-1',
              backend: 'mempalace' as const,
              textPreview: 'Use MemPalace as the structured recall backend.',
              similarity: 0.92,
              distance: null,
              sessionId: 'session-1',
              room: 'decision',
              sourceLabel: 'C:\\memory\\decisions.json',
            },
          ],
          warning: null,
        })
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'project preferences',
          hitCount: 1,
          hits: [
            {
              id: 'preference-1',
              backend: 'mempalace' as const,
              textPreview: 'Keep provider-native bootstrap injection.',
              similarity: 0.9,
              distance: null,
              sessionId: 'session-1',
              room: 'preference',
              sourceLabel: 'C:\\memory\\preferences.json',
            },
          ],
          warning: null,
        })
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'workflows',
          hitCount: 1,
          hits: [
            {
              id: 'workflow-1',
              backend: 'mempalace' as const,
              textPreview: 'Index transcripts first, then extract structured cards.',
              similarity: 0.88,
              distance: null,
              sessionId: 'session-1',
              room: 'workflow',
              sourceLabel: 'C:\\memory\\component-workflows.md',
            },
          ],
          warning: null,
        })
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'troubleshooting',
          hitCount: 1,
          hits: [
            {
              id: 'trouble-1',
              backend: 'mempalace' as const,
              textPreview: 'If MemPalace is unavailable, keep the legacy fallback.',
              similarity: 0.86,
              distance: null,
              sessionId: 'session-1',
              room: 'troubleshooting',
              sourceLabel: 'C:\\memory\\troubleshooting.md',
            },
          ],
          warning: null,
        })
        .mockResolvedValueOnce({
          backend: 'mempalace' as const,
          query: 'critical files',
          hitCount: 1,
          hits: [
            {
              id: 'critical-1',
              backend: 'mempalace' as const,
              textPreview: 'Read electron/projectMemoryManager.ts first.',
              similarity: 0.9,
              distance: null,
              sessionId: 'session-1',
              room: 'critical-file',
              sourceLabel: 'C:\\memory\\critical-files.md',
            },
          ],
          warning: null,
        }),
    }
    const composer = new BootstrapComposer(memorySearch)

    const result = await composer.composeContext({
      project: buildProject(),
      location: buildLocation(),
    })

    expect(memorySearch.search).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        wing: 'github.com/openai/agenclis',
        room: 'session-summary',
      }),
    )
    expect(memorySearch.search).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        wing: 'github.com/openai/agenclis',
        room: 'architecture',
      }),
    )
    expect(result.fileReferences).toEqual([
      'C:\\memory\\summaries\\latest.md',
      'C:\\memory\\architecture.json',
      'C:\\memory\\decisions.json',
      'C:\\memory\\preferences.json',
      'C:\\memory\\component-workflows.md',
      'C:\\memory\\troubleshooting.md',
      'C:\\memory\\critical-files.md',
    ])
    expect(result.bootstrapMessage).toContain('Structured summary from MemPalace.')
    expect(result.bootstrapMessage).toContain('Active decisions:')
    expect(result.bootstrapMessage).toContain('Project preferences:')
    expect(result.bootstrapMessage).toContain('Read electron/projectMemoryManager.ts first.')
    expect(result.bootstrapMessage).toContain('Architecture overview: Renderer -> preload -> main')
  })
})
