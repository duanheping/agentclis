// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  spawnSync,
}))

import { killTerminalProcessTree } from './ptyProcessTree'

describe('killTerminalProcessTree', () => {
  beforeEach(() => {
    spawnSync.mockReset()
  })

  it('uses taskkill to terminate a Windows PTY process tree', () => {
    const terminal = {
      pid: 4321,
      kill: vi.fn(),
    }
    spawnSync.mockReturnValue({
      error: undefined,
      status: 0,
    })

    killTerminalProcessTree(terminal, 'win32')

    expect(spawnSync).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4321', '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    expect(terminal.kill).not.toHaveBeenCalled()
  })

  it('falls back to terminal.kill when taskkill fails', () => {
    const terminal = {
      pid: 4321,
      kill: vi.fn(),
    }
    spawnSync.mockReturnValue({
      error: undefined,
      status: 1,
    })

    killTerminalProcessTree(terminal, 'win32')

    expect(terminal.kill).toHaveBeenCalledTimes(1)
  })

  it('falls back to terminal.kill when no Windows PTY pid is available', () => {
    const withoutPid = {
      kill: vi.fn(),
    }
    const nonWindows = {
      pid: 4321,
      kill: vi.fn(),
    }

    killTerminalProcessTree(withoutPid, 'win32')
    killTerminalProcessTree(nonWindows, 'linux')

    expect(spawnSync).not.toHaveBeenCalled()
    expect(withoutPid.kill).toHaveBeenCalledTimes(1)
    expect(nonWindows.kill).toHaveBeenCalledTimes(1)
  })
})
