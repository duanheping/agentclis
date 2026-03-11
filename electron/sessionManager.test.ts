// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let persistedState: any = null
  let nextPid = 1000
  const terminals: any[] = []
  const spawn = vi.fn(() => {
    const terminal = {
      pid: nextPid++,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    }
    terminals.push(terminal)
    return terminal
  })

  return {
    terminals,
    spawn,
    getPersistedState: () => persistedState,
    setPersistedState: (value: any) => {
      persistedState = structuredClone(value)
    },
    reset: () => {
      persistedState = null
      nextPid = 1000
      terminals.length = 0
      spawn.mockReset()
      spawn.mockImplementation(() => {
        const terminal = {
          pid: nextPid++,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(),
          onExit: vi.fn(),
        }
        terminals.push(terminal)
        return terminal
      })
    },
  }
})

vi.mock('electron-store', () => {
  return {
    default: class StoreMock<T> {
      store: T

      constructor(options?: { defaults?: T }) {
        const initial = mocks.getPersistedState() ?? options?.defaults ?? {}
        this.store = structuredClone(initial)
      }

      set(value: T): void {
        this.store = structuredClone(value)
        mocks.setPersistedState(this.store)
      }
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

import { SessionManager } from './sessionManager'

describe('SessionManager restore policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.reset()
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-11T10:00:00.000Z',
          updatedAt: '2026-03-11T10:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'alpha',
          startupCommand: 'alpha',
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-11T10:00:00.000Z',
          updatedAt: '2026-03-11T10:00:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-1',
          title: 'beta',
          startupCommand: 'beta',
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-11T10:01:00.000Z',
          updatedAt: '2026-03-11T10:01:00.000Z',
        },
      ],
      activeSessionId: 'session-b',
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('restores only the last active session at launch and starts others on demand', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const initialSnapshot = manager.listSessions()
    expect(
      initialSnapshot.projects[0]?.sessions.map((session) => session.runtime.status),
    ).toEqual(['exited', 'exited'])

    const restoredSnapshot = await manager.restoreSessions()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(restoredSnapshot.activeSessionId).toBe('session-b')
    expect(
      Object.fromEntries(
        restoredSnapshot.projects[0]?.sessions.map((session) => [
          session.config.id,
          session.runtime.status,
        ]) ?? [],
      ),
    ).toEqual({
      'session-a': 'exited',
      'session-b': 'running',
    })

    vi.runOnlyPendingTimers()
    expect(mocks.terminals[0].write).toHaveBeenCalledWith('beta\r')

    await manager.activateSession('session-a')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(manager.listSessions().activeSessionId).toBe('session-a')

    vi.runOnlyPendingTimers()
    expect(mocks.terminals[1].write).toHaveBeenCalledWith('alpha\r')

    await manager.activateSession('session-a')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })
})
