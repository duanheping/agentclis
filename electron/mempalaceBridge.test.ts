// @vitest-environment node

import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MempalaceBridge, type MempalaceRuntimeHost } from './mempalaceBridge'

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: {
    write: (value: string) => boolean
    end: () => void
  }
  kill: () => boolean
  pid: number
}

function createMockChildProcess(
  handler: (request: Record<string, unknown>, child: MockChildProcess) => void,
): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = {
    write: (value: string) => {
      const lines = value.split(/\r?\n/u).filter(Boolean)
      for (const line of lines) {
        handler(JSON.parse(line) as Record<string, unknown>, child)
      }
      return true
    },
    end: () => undefined,
  }
  child.kill = () => {
    queueMicrotask(() => {
      child.emit('close', 0, 'SIGTERM')
    })
    return true
  }
  child.pid = Math.floor(Math.random() * 10000) + 1000
  return child
}

function emitJsonResponse(
  child: MockChildProcess,
  response: Record<string, unknown>,
): void {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(response)}\n`, 'utf8'))
  })
}

function createRuntimeHost(
  processes: MockChildProcess[],
): MempalaceRuntimeHost & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  let currentProcess: MockChildProcess | null = null

  const start = vi.fn(async () => {
    if (currentProcess) {
      return currentProcess as unknown as import('node:child_process').ChildProcessWithoutNullStreams
    }

    const nextProcess = processes.shift()
    if (!nextProcess) {
      throw new Error('No mock MemPalace process available.')
    }
    currentProcess = nextProcess
    const resetCurrent = () => {
      if (currentProcess === nextProcess) {
        currentProcess = null
      }
    }
    nextProcess.on('close', resetCurrent)
    nextProcess.on('error', resetCurrent)
    return nextProcess as unknown as import('node:child_process').ChildProcessWithoutNullStreams
  })
  const stop = vi.fn(() => undefined)

  return {
    start,
    stop,
  } as MempalaceRuntimeHost & { start: typeof start; stop: typeof stop }
}

describe('MempalaceBridge', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('lists tools and unwraps tool-call JSON payloads', async () => {
    const child = createMockChildProcess((request, process) => {
      const id = request.id as number | undefined
      const method = request.method

      if (method === 'initialize' && typeof id === 'number') {
        emitJsonResponse(process, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'mempalace', version: '3.1.0' },
          },
        })
        return
      }

      if (method === 'notifications/initialized') {
        return
      }

      if (method === 'tools/list' && typeof id === 'number') {
        emitJsonResponse(process, {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'mempalace_status',
                description: 'Status',
                inputSchema: { type: 'object', properties: {} },
              },
              {
                name: 'mempalace_search',
                description: 'Search',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              },
            ],
          },
        })
        return
      }

      if (method === 'tools/call' && typeof id === 'number') {
        const params = request.params as { name?: string; arguments?: Record<string, unknown> }
        if (params.name === 'mempalace_status') {
          emitJsonResponse(process, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    total_drawers: 4,
                    wings: { project_alpha: 4 },
                    rooms: { 'transcript-raw': 3, decision: 1 },
                  }),
                },
              ],
            },
          })
          return
        }

        if (params.name === 'mempalace_search') {
          emitJsonResponse(process, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    results: [
                      {
                        id: 'drawer-1',
                        document: 'Memory hit',
                        distance: 0.12,
                        metadata: {
                          wing: 'project_alpha',
                          room: 'transcript-raw',
                        },
                      },
                    ],
                  }),
                },
              ],
            },
          })
        }
      }
    })

    const runtime = createRuntimeHost([child])
    const bridge = new MempalaceBridge(runtime)

    const tools = await bridge.listTools()
    const status = await bridge.status()
    const search = await bridge.search({
      query: 'memory hit',
      wing: 'project_alpha',
      limit: 5,
    })

    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(tools.map((tool) => tool.name)).toEqual([
      'mempalace_status',
      'mempalace_search',
    ])
    expect(status).toEqual(
      expect.objectContaining({
        total_drawers: 4,
        wings: { project_alpha: 4 },
      }),
    )
    expect(search.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'drawer-1',
          distance: 0.12,
        }),
      ]),
    )
  })

  it('restarts on the next request after the process disconnects', async () => {
    const handler = (
      request: Record<string, unknown>,
      process: MockChildProcess,
    ) => {
      const id = request.id as number | undefined
      const method = request.method

      if (method === 'initialize' && typeof id === 'number') {
        emitJsonResponse(process, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'mempalace', version: '3.1.0' },
          },
        })
        return
      }

      if (method === 'notifications/initialized') {
        return
      }

      if (method === 'tools/call' && typeof id === 'number') {
        emitJsonResponse(process, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ total_drawers: 1 }),
              },
            ],
          },
        })
      }
    }

    const firstProcess = createMockChildProcess(handler)
    const secondProcess = createMockChildProcess(handler)
    const runtime = createRuntimeHost([firstProcess, secondProcess])
    const bridge = new MempalaceBridge(runtime)

    await bridge.status()
    firstProcess.emit('close', 1, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await bridge.status()

    expect(runtime.start).toHaveBeenCalledTimes(2)
  })

  it('times out when the server does not respond', async () => {
    const child = createMockChildProcess((request, process) => {
      const id = request.id as number | undefined
      if (request.method === 'initialize' && typeof id === 'number') {
        emitJsonResponse(process, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'mempalace', version: '3.1.0' },
          },
        })
      }
    })

    const runtime = createRuntimeHost([child])
    const bridge = new MempalaceBridge(runtime, {
      requestTimeoutMs: 25,
    })

    await expect(bridge.status()).rejects.toThrow(/timed out/u)
  })
})
