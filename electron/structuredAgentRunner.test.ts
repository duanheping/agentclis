// @vitest-environment node

import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type MockChild = EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
    }
    kill: ReturnType<typeof vi.fn>
  }

  const children: MockChild[] = []
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as MockChild
    child.pid = 4321
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(),
    }
    child.kill = vi.fn()
    children.push(child)
    return child
  })
  const spawnSync = vi.fn(() => ({
    error: undefined,
    status: 0,
  }))

  return {
    children,
    spawn,
    spawnSync,
    reset: () => {
      children.length = 0
      spawn.mockClear()
      spawnSync.mockClear()
    },
  }
})

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))

import {
  abortStructuredAgentProcesses,
  runStructuredAgent,
} from './structuredAgentRunner'

describe('structuredAgentRunner shutdown handling', () => {
  afterEach(() => {
    mocks.reset()
  })

  it('aborts active structured-agent child processes during shutdown', async () => {
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object"}',
      prompt: 'Return JSON.',
      contextDirectories: [],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    abortStructuredAgentProcesses()

    if (process.platform === 'win32') {
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        'taskkill.exe',
        ['/PID', '4321', '/T', '/F'],
        expect.objectContaining({
          stdio: 'ignore',
          windowsHide: true,
        }),
      )
      expect(mocks.children[0]?.kill).not.toHaveBeenCalled()
    } else {
      expect(mocks.children[0]?.kill).toHaveBeenCalledTimes(1)
    }

    mocks.children[0]?.emit('close', 1)

    await expect(promise).rejects.toThrow(/copilot exited with code 1/i)
  })
})
