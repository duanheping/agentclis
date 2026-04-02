// @vitest-environment node

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'

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
  cleanupStructuredAgentTemp,
  prepareStructuredAgent,
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

  it('runs copilot structured jobs from the first context directory and uses prompt-file mode', async () => {
    const contextDirectory = process.cwd()
    const promise = runStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object","properties":{"status":{"type":"string"}}}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const spawnCall = mocks.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd?: string },
    ]
    expect(spawnCall[2]).toEqual(
      expect.objectContaining({
        cwd: contextDirectory,
      }),
    )

    if (process.platform === 'win32') {
      const scriptPath = spawnCall[1][3]
      const script = await readFile(scriptPath, 'utf8')
      expect(script).toContain('copilot --allow-all --no-ask-user --no-custom-instructions')
      expect(script).toContain('Read and follow all instructions in the file at')
      expect(script).not.toContain('--output-format json')
      expect(script).not.toContain('--stream off')
    } else {
      expect(spawnCall[1]).toEqual(
        expect.arrayContaining([
          '--allow-all',
          '--no-ask-user',
          '--no-custom-instructions',
        ]),
      )
      expect(spawnCall[1]).not.toEqual(expect.arrayContaining(['--output-format']))
      expect(spawnCall[1]).not.toEqual(expect.arrayContaining(['--stream']))
    }

    mocks.children[0]?.emit('close', 1)
    await expect(promise).rejects.toThrow(/copilot exited with code 1/i)
  })

  it('anchors prepared copilot analysis scripts in the first context directory', async () => {
    const contextDirectory = process.cwd()
    const prepared = await prepareStructuredAgent({
      agent: 'copilot',
      schema: '{"type":"object"}',
      prompt: 'Summarize the repository.',
      contextDirectories: [contextDirectory],
    })

    expect(prepared.cwd).toBe(contextDirectory)

    await cleanupStructuredAgentTemp(prepared.tempRoot)
  })
})
