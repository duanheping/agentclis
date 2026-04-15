// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { MempalaceService } from './mempalaceService'

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
    }
    const service = new MempalaceService(runtime, bridge)

    await expect(service.getStatus()).resolves.toEqual(status)
    await expect(service.installRuntime()).resolves.toEqual({
      success: true,
      status,
    })
  })

  it('maps MemPalace search hits into renderer-safe search results', async () => {
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
    }
    const service = new MempalaceService(runtime, bridge)

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
    }
    const service = new MempalaceService(runtime, bridge)

    const result = await service.search({
      query: 'decision',
    })

    expect(result.hitCount).toBe(0)
    expect(result.warning).toContain('MemPalace bridge disconnected')
  })
})
