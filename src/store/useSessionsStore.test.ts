import { beforeEach, describe, expect, it } from 'vitest'

import type {
  ListSessionsResponse,
  SessionConfig,
  SessionRuntime,
} from '../shared/session'

import { useSessionsStore } from './useSessionsStore'

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    title: 'Session 1',
    startupCommand: 'codex',
    pendingFirstPromptTitle: false,
    cwd: 'C:\\project',
    shell: 'powershell.exe',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeRuntime(overrides: Partial<SessionRuntime> = {}): SessionRuntime {
  return {
    sessionId: 'sess-1',
    status: 'running',
    attention: null,
    lastActiveAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeWorkspace(
  sessions: Array<{ config: SessionConfig; runtime: SessionRuntime }> = [],
  activeSessionId: string | null = null,
): ListSessionsResponse {
  return {
    projects: [
      {
        config: {
          id: 'proj-1',
          title: 'Project 1',
          rootPath: 'C:\\project',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        sessions: sessions.map((s) => ({
          config: s.config,
          runtime: s.runtime,
        })),
      },
    ],
    activeSessionId,
  }
}

describe('useSessionsStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useSessionsStore.setState({
      projects: [],
      activeSessionId: null,
      permissionLevel: 'default',
      hydrated: false,
    })
  })

  it('starts with empty defaults', () => {
    const state = useSessionsStore.getState()
    expect(state.projects).toEqual([])
    expect(state.activeSessionId).toBeNull()
    expect(state.hydrated).toBe(false)
  })

  it('setInitialData hydrates the store', () => {
    const config = makeConfig()
    const runtime = makeRuntime()
    const workspace = makeWorkspace([{ config, runtime }], 'sess-1')

    useSessionsStore.getState().setInitialData(workspace)

    const state = useSessionsStore.getState()
    expect(state.hydrated).toBe(true)
    expect(state.activeSessionId).toBe('sess-1')
    expect(state.projects).toHaveLength(1)
    expect(state.projects[0].sessions).toHaveLength(1)
    expect(state.projects[0].sessions[0].config.id).toBe('sess-1')
  })

  it('setActiveSession updates the active session id', () => {
    useSessionsStore.getState().setActiveSession('sess-2')
    expect(useSessionsStore.getState().activeSessionId).toBe('sess-2')
  })

  it('setActiveSession accepts null', () => {
    useSessionsStore.getState().setActiveSession('sess-1')
    useSessionsStore.getState().setActiveSession(null)
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
  })

  it('updateConfig replaces the matching session config', () => {
    const config = makeConfig()
    const runtime = makeRuntime()
    const workspace = makeWorkspace([{ config, runtime }], 'sess-1')
    useSessionsStore.getState().setInitialData(workspace)

    const updatedConfig = makeConfig({ title: 'Updated Title' })
    useSessionsStore.getState().updateConfig(updatedConfig)

    const session = useSessionsStore.getState().projects[0].sessions[0]
    expect(session.config.title).toBe('Updated Title')
  })

  it('updateConfig does not affect non-matching sessions', () => {
    const config1 = makeConfig({ id: 'sess-1', title: 'S1' })
    const runtime1 = makeRuntime({ sessionId: 'sess-1' })
    const config2 = makeConfig({ id: 'sess-2', title: 'S2' })
    const runtime2 = makeRuntime({ sessionId: 'sess-2' })

    const workspace: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'proj-1',
            title: 'P1',
            rootPath: 'C:\\project',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sessions: [
            { config: config1, runtime: runtime1 },
            { config: config2, runtime: runtime2 },
          ],
        },
      ],
      activeSessionId: 'sess-1',
    }
    useSessionsStore.getState().setInitialData(workspace)

    useSessionsStore.getState().updateConfig(makeConfig({ id: 'sess-1', title: 'Updated' }))

    const sessions = useSessionsStore.getState().projects[0].sessions
    expect(sessions[0].config.title).toBe('Updated')
    expect(sessions[1].config.title).toBe('S2')
  })

  it('updateRuntime replaces the matching session runtime', () => {
    const config = makeConfig()
    const runtime = makeRuntime()
    const workspace = makeWorkspace([{ config, runtime }], 'sess-1')
    useSessionsStore.getState().setInitialData(workspace)

    const updated = makeRuntime({ status: 'exited', exitCode: 0 })
    useSessionsStore.getState().updateRuntime(updated)

    const session = useSessionsStore.getState().projects[0].sessions[0]
    expect(session.runtime.status).toBe('exited')
    expect(session.runtime.exitCode).toBe(0)
  })

  it('updateRuntime does not affect non-matching sessions', () => {
    const config1 = makeConfig({ id: 'sess-1' })
    const runtime1 = makeRuntime({ sessionId: 'sess-1', status: 'running' })
    const config2 = makeConfig({ id: 'sess-2' })
    const runtime2 = makeRuntime({ sessionId: 'sess-2', status: 'running' })

    const workspace: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'proj-1',
            title: 'P1',
            rootPath: 'C:\\project',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sessions: [
            { config: config1, runtime: runtime1 },
            { config: config2, runtime: runtime2 },
          ],
        },
      ],
      activeSessionId: 'sess-1',
    }
    useSessionsStore.getState().setInitialData(workspace)

    useSessionsStore.getState().updateRuntime(makeRuntime({ sessionId: 'sess-2', status: 'exited' }))

    const sessions = useSessionsStore.getState().projects[0].sessions
    expect(sessions[0].runtime.status).toBe('running')
    expect(sessions[1].runtime.status).toBe('exited')
  })

  it('updateConfig is a no-op when session id does not exist', () => {
    const config = makeConfig()
    const runtime = makeRuntime()
    const workspace = makeWorkspace([{ config, runtime }], 'sess-1')
    useSessionsStore.getState().setInitialData(workspace)

    useSessionsStore.getState().updateConfig(makeConfig({ id: 'nonexistent', title: 'Ghost' }))

    const session = useSessionsStore.getState().projects[0].sessions[0]
    expect(session.config.title).toBe('Session 1')
  })

  it('updateRuntime is a no-op when session id does not exist', () => {
    const config = makeConfig()
    const runtime = makeRuntime()
    const workspace = makeWorkspace([{ config, runtime }], 'sess-1')
    useSessionsStore.getState().setInitialData(workspace)

    useSessionsStore.getState().updateRuntime(makeRuntime({ sessionId: 'nonexistent', status: 'exited' }))

    const session = useSessionsStore.getState().projects[0].sessions[0]
    expect(session.runtime.status).toBe('running')
  })

  it('handles multiple projects with sessions', () => {
    const workspace: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'proj-1',
            title: 'P1',
            rootPath: 'C:\\p1',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sessions: [
            { config: makeConfig({ id: 's1', projectId: 'proj-1' }), runtime: makeRuntime({ sessionId: 's1' }) },
          ],
        },
        {
          config: {
            id: 'proj-2',
            title: 'P2',
            rootPath: 'C:\\p2',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
          sessions: [
            { config: makeConfig({ id: 's2', projectId: 'proj-2' }), runtime: makeRuntime({ sessionId: 's2' }) },
          ],
        },
      ],
      activeSessionId: 's2',
    }
    useSessionsStore.getState().setInitialData(workspace)

    useSessionsStore.getState().updateConfig(makeConfig({ id: 's2', projectId: 'proj-2', title: 'Updated' }))

    expect(useSessionsStore.getState().projects[0].sessions[0].config.title).toBe('Session 1')
    expect(useSessionsStore.getState().projects[1].sessions[0].config.title).toBe('Updated')
  })

  it('starts with default permission level', () => {
    expect(useSessionsStore.getState().permissionLevel).toBe('default')
  })

  it('setPermissionLevel updates the level and persists to localStorage', () => {
    useSessionsStore.getState().setPermissionLevel('full-access')
    expect(useSessionsStore.getState().permissionLevel).toBe('full-access')
    expect(window.localStorage.getItem('agenclis:permission-level')).toBe('full-access')
  })

  it('setPermissionLevel can switch back to default', () => {
    useSessionsStore.getState().setPermissionLevel('full-access')
    useSessionsStore.getState().setPermissionLevel('default')
    expect(useSessionsStore.getState().permissionLevel).toBe('default')
    expect(window.localStorage.getItem('agenclis:permission-level')).toBe('default')
  })
})
