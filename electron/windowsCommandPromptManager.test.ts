// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let nextPid = 2000
  const prompts: any[] = []
  const spawn = vi.fn(() => {
    const prompt = {
      pid: nextPid++,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    }

    prompts.push(prompt)
    return prompt
  })

  return {
    prompts,
    spawn,
    reset: () => {
      nextPid = 2000
      prompts.length = 0
      spawn.mockReset()
      spawn.mockImplementation(() => {
        const prompt = {
          pid: nextPid++,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(),
          onExit: vi.fn(),
        }

        prompts.push(prompt)
        return prompt
      })
    },
  }
})

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: () => {
      return (specifier: string) => {
        if (specifier === 'node-pty') {
          return { spawn: mocks.spawn }
        }

        throw new Error(`Unexpected require: ${specifier}`)
      }
    },
  }
})

import { WindowsCommandPromptManager } from './windowsCommandPromptManager'

describe('WindowsCommandPromptManager', () => {
  beforeEach(() => {
    mocks.reset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens, writes to, resizes, and closes a prompt for a session', () => {
    const onData = vi.fn()
    const onExit = vi.fn()
    const manager = new WindowsCommandPromptManager({ onData, onExit })

    manager.open('session-a', 'C:\\repo')

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(manager.listOpenSessionIds()).toEqual(['session-a'])

    manager.write('session-a', 'dir\r')
    manager.resize('session-a', 120, 24)

    expect(mocks.prompts[0].write).toHaveBeenCalledWith('dir\r')
    expect(mocks.prompts[0].resize).toHaveBeenCalledWith(120, 24)

    manager.close('session-a')

    expect(mocks.prompts[0].kill).toHaveBeenCalledTimes(1)
    expect(manager.listOpenSessionIds()).toEqual([])
    expect(onExit).not.toHaveBeenCalled()
  })
})
