// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let persistedState: unknown = null
  let nextPid = 1000
  const createTerminal = () => ({
    pid: nextPid++,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  })
  const terminals: Array<ReturnType<typeof createTerminal>> = []
  const spawn = vi.fn(() => {
    const terminal = createTerminal()
    terminals.push(terminal)
    return terminal
  })

  return {
    terminals,
    spawn,
    getPersistedState: () => persistedState,
    setPersistedState: (value: unknown) => {
      persistedState = structuredClone(value)
    },
    reset: () => {
      persistedState = null
      nextPid = 1000
      terminals.length = 0
      spawn.mockReset()
      spawn.mockImplementation(() => {
        const terminal = createTerminal()
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
        this.store = structuredClone(initial) as T
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
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const initialSnapshot = manager.listSessions()
    expect(
      initialSnapshot.projects[0]?.sessions.map((session) => session.runtime.status),
    ).toEqual(['exited', 'exited'])

    const restoredSnapshot = await manager.restoreSessions()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const firstSpawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(firstSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'beta',
    ])
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
    expect(mocks.terminals[0].write).not.toHaveBeenCalled()

    await manager.activateSession('session-a')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    const secondSpawnArgs = (mocks.spawn.mock.calls[1] as unknown[] | undefined)?.[1]
    expect(secondSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'alpha',
    ])
    expect(manager.listSessions().activeSessionId).toBe('session-a')

    vi.runOnlyPendingTimers()
    expect(mocks.terminals[1].write).not.toHaveBeenCalled()

    await manager.activateSession('session-a')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })
})

describe('SessionManager project lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.reset()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('creates a project without creating a session', () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const project = manager.createProject({
      title: 'Workspace',
      rootPath: 'C:\\repo',
    })

    expect(project.config.title).toBe('Workspace')
    expect(project.sessions).toEqual([])
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(manager.listSessions()).toEqual({
      projects: [project],
      activeSessionId: null,
    })
  })

  it('keeps the project after its last session is closed', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
    })

    vi.runOnlyPendingTimers()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    manager.closeSession(session.config.id)

    expect(manager.listSessions()).toEqual({
      projects: [
        {
          config: expect.objectContaining({
            id: session.config.projectId,
            title: 'Workspace',
            rootPath: 'C:\\repo',
          }),
          sessions: [],
        },
      ],
      activeSessionId: null,
    })
  })

  it('uses the first submitted prompt as the title for managed CLI sessions', async () => {
    const onConfig = vi.fn()
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
    })

    expect(session.config.title).toBe('codex')
    expect(session.config.pendingFirstPromptTitle).toBe(true)

    manager.writeToSession(session.config.id, 'hello world')
    manager.writeToSession(session.config.id, '\r')

    const renamedSession = manager
      .listSessions()
      .projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )

    expect(renamedSession?.config.title).toBe('hello world')
    expect(renamedSession?.config.pendingFirstPromptTitle).toBe(false)
    expect(onConfig).toHaveBeenCalledWith({
      sessionId: session.config.id,
      config: expect.objectContaining({
        id: session.config.id,
        title: 'hello world',
        pendingFirstPromptTitle: false,
      }),
    })
  })

  it('does not override a manual title with the first prompt', async () => {
    const onConfig = vi.fn()
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      title: 'Manual title',
      startupCommand: 'codex',
    })

    manager.writeToSession(session.config.id, 'hello world')
    manager.writeToSession(session.config.id, '\r')

    const unchangedSession = manager
      .listSessions()
      .projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )

    expect(unchangedSession?.config.title).toBe('Manual title')
    expect(unchangedSession?.config.pendingFirstPromptTitle).toBe(false)
    expect(onConfig).not.toHaveBeenCalled()
  })
})
