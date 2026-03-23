// @vitest-environment node

import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptEvent } from '../src/shared/projectMemory'
import type { ProjectLocationIdentity } from './projectIdentity'

function normalizeMockPath(filePath: string): string {
  return filePath.replace(/\//g, '\\').toLowerCase()
}

const mocks = vi.hoisted(() => {
  let persistedState: unknown = null
  let nextPid = 1000
  const files = new Map<string, { content: string; mtimeMs: number }>()
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
  const createProjectSessionWorktree = vi.fn(async () => ({
    branchName: 'agenclis/main/20260317-153045-session',
    cwd: 'C:\\Users\\hduan10\\.codex\\worktrees\\repo\\20260317-153045-session',
  }))

  return {
    createProjectSessionWorktree,
    terminals,
    spawn,
    getFile: (filePath: string) => files.get(filePath)?.content,
    getFileMeta: (filePath: string) => files.get(filePath),
    listFiles: () => Array.from(files.entries()),
    getPersistedState: () => persistedState,
    setFile: (filePath: string, content: string, modifiedAt?: string | number) => {
      files.set(normalizeMockPath(filePath), {
        content,
        mtimeMs:
          typeof modifiedAt === 'number'
            ? modifiedAt
            : modifiedAt
              ? Date.parse(modifiedAt)
              : Date.now(),
      })
    },
    setPersistedState: (value: unknown) => {
      persistedState = structuredClone(value)
    },
    reset: () => {
      persistedState = null
      nextPid = 1000
      files.clear()
      terminals.length = 0
      spawn.mockReset()
      spawn.mockImplementation(() => {
        const terminal = createTerminal()
        terminals.push(terminal)
        return terminal
      })
      createProjectSessionWorktree.mockReset()
      createProjectSessionWorktree.mockResolvedValue({
        branchName: 'agenclis/main/20260317-153045-session',
        cwd: 'C:\\Users\\hduan10\\.codex\\worktrees\\repo\\20260317-153045-session',
      })
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (filePath: string) => {
      const content = mocks.getFile(normalizeMockPath(String(filePath)))
      if (content === undefined) {
        throw new Error(`ENOENT: ${filePath}`)
      }

      return content
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()

  return {
    ...actual,
    open: async (filePath: string) => {
      const meta = mocks.getFileMeta(normalizeMockPath(String(filePath)))
      if (!meta) {
        throw new Error(`ENOENT: ${filePath}`)
      }

      return {
        read: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          const chunk = Buffer.from(meta.content).subarray(position, position + length)
          chunk.copy(buffer, offset)
          return {
            bytesRead: chunk.length,
            buffer,
          }
        },
        readFile: async () => meta.content,
        close: async () => undefined,
      }
    },
    readdir: async (targetPath: string, options?: { withFileTypes?: boolean }) => {
      const normalizedTargetPath = normalizeMockPath(String(targetPath)).replace(
        /[\\]+$/,
        '',
      )
      const entries = new Map<string, 'file' | 'directory'>()

      for (const [filePath] of mocks.listFiles()) {
        if (!filePath.startsWith(`${normalizedTargetPath}\\`)) {
          continue
        }

        const relativePath = filePath.slice(normalizedTargetPath.length + 1)
        const [entryName, ...remainingParts] = relativePath.split('\\')
        if (!entryName) {
          continue
        }

        entries.set(entryName, remainingParts.length > 0 ? 'directory' : 'file')
      }

      if (!options?.withFileTypes) {
        return Array.from(entries.keys())
      }

      return Array.from(entries.entries()).map(([name, kind]) => ({
        name,
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
      }))
    },
    stat: async (targetPath: string) => {
      const normalizedTargetPath = normalizeMockPath(String(targetPath)).replace(
        /[\\]+$/,
        '',
      )
      const fileMeta = mocks.getFileMeta(normalizedTargetPath)
      if (fileMeta) {
        return {
          mtimeMs: fileMeta.mtimeMs,
        }
      }

      const childModificationTimes = mocks
        .listFiles()
        .filter(([filePath]) => filePath.startsWith(`${normalizedTargetPath}\\`))
        .map(([, meta]) => meta.mtimeMs)

      if (childModificationTimes.length > 0) {
        return {
          mtimeMs: Math.max(...childModificationTimes),
        }
      }

      throw new Error(`ENOENT: ${targetPath}`)
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

vi.mock('./projectWorktree', () => ({
  createProjectSessionWorktree: mocks.createProjectSessionWorktree,
}))

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

  it('recovers a missing Codex resume id from local session history before restoring', async () => {
    const onConfig = vi.fn()

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-15T18:10:00.000Z',
          updatedAt: '2026-03-15T18:12:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'triage ECG-205709',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-15T18:10:24.756Z',
          updatedAt: '2026-03-15T18:12:00.000Z',
        },
      ],
      activeSessionId: 'session-a',
    })

    const sessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '15',
      'rollout-2026-03-15T18-10-31-019cf7a4-db19-78a0-a9b1-b9e3d2b0126a.jsonl',
    )
    mocks.setFile(
      sessionFilePath,
      [
        '{"timestamp":"2026-03-15T18:10:31.000Z","type":"session_meta","payload":{"id":"019cf7a4-db19-78a0-a9b1-b9e3d2b0126a","timestamp":"2026-03-15T18:10:31.000Z","cwd":"C:\\\\repo","originator":"codex_cli_rs"}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"triage ECG-205709"}]}}',
      ].join('\n'),
      '2026-03-15T18:10:35.000Z',
    )

    const manager = new SessionManager({
      onData: () => undefined,
      onConfig,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.restoreSessions()
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const firstSpawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(firstSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex resume 019cf7a4-db19-78a0-a9b1-b9e3d2b0126a',
    ])

    expect(onConfig).toHaveBeenCalledWith({
      sessionId: 'session-a',
      config: expect.objectContaining({
        externalSession: {
          provider: 'codex',
          sessionId: '019cf7a4-db19-78a0-a9b1-b9e3d2b0126a',
          detectedAt: expect.any(String),
        },
      }),
    })

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: { sessionId: string }
          }>
        }
      ).sessions[0]?.externalSession?.sessionId,
    ).toBe('019cf7a4-db19-78a0-a9b1-b9e3d2b0126a')
  })

  it('does not recover a Codex Desktop session for an agentclis-managed restore', async () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-15T18:10:00.000Z',
          updatedAt: '2026-03-15T18:12:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'triage ECG-205709',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-15T18:10:24.756Z',
          updatedAt: '2026-03-15T18:12:00.000Z',
        },
      ],
      activeSessionId: 'session-a',
    })

    const desktopSessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '15',
      'rollout-2026-03-15T18-10-31-019desktop-session.jsonl',
    )
    mocks.setFile(
      desktopSessionFilePath,
      [
        '{"timestamp":"2026-03-15T18:10:31.000Z","type":"session_meta","payload":{"id":"019desktop-session","timestamp":"2026-03-15T18:10:31.000Z","cwd":"C:\\\\repo","originator":"Codex Desktop","source":"vscode"}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"triage ECG-205709"}]}}',
      ].join('\n'),
      '2026-03-15T18:10:35.000Z',
    )

    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.restoreSessions()
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const firstSpawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(firstSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex',
    ])

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: { sessionId: string }
          }>
        }
      ).sessions[0]?.externalSession,
    ).toBeUndefined()
  })

  it('drops a previously saved Codex Desktop session id before restore', async () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-15T18:10:00.000Z',
          updatedAt: '2026-03-19T15:25:31.314Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'tell me major canadian oil company stock',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-18T20:18:09.708Z',
          updatedAt: '2026-03-19T15:25:31.314Z',
          externalSession: {
            provider: 'codex',
            sessionId: '019desktop-session',
            detectedAt: '2026-03-19T15:23:22.906Z',
          },
        },
      ],
      activeSessionId: 'session-a',
    })

    const desktopSessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '18',
      'rollout-2026-03-18T20-18-09-019desktop-session.jsonl',
    )
    mocks.setFile(
      desktopSessionFilePath,
      [
        '{"timestamp":"2026-03-18T20:18:24.720Z","type":"session_meta","payload":{"id":"019desktop-session","timestamp":"2026-03-18T20:18:09.708Z","cwd":"C:\\\\repo","originator":"Codex Desktop","source":"vscode"}}',
      ].join('\n'),
      '2026-03-19T15:25:31.314Z',
    )

    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.restoreSessions()
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    })

    const firstSpawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(firstSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex',
    ])

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: { sessionId: string }
          }>
        }
      ).sessions[0]?.externalSession,
    ).toBeUndefined()
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

  it('creates a project without creating a session', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const project = await manager.createProject({
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
        expect.objectContaining({
          config: expect.objectContaining({
            id: session.config.projectId,
            title: 'Workspace',
            rootPath: 'C:\\repo',
          }),
          sessions: [],
        }),
      ],
      activeSessionId: null,
    })
  })

  it('starts a fresh Codex session instead of reviving project history', async () => {
    const startedAt = new Date(Date.now() - 60_000)
    const sessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      `${startedAt.getFullYear()}`,
      `${startedAt.getMonth() + 1}`.padStart(2, '0'),
      `${startedAt.getDate()}`.padStart(2, '0'),
      'rollout-existing-session.jsonl',
    )

    mocks.setFile(
      sessionFilePath,
      [
        `{"timestamp":"${startedAt.toISOString()}","type":"session_meta","payload":{"id":"019existing-codex-session","timestamp":"${startedAt.toISOString()}","cwd":"C:\\\\repo","originator":"codex_cli_rs"}}`,
      ].join('\n'),
      startedAt.getTime(),
    )

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

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex',
    ])
    expect(session.config.externalSession).toBeUndefined()
  })

  it('creates project-context sessions inside a fresh git worktree', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const project = await manager.createProject({
      title: 'Workspace',
      rootPath: 'C:\\repo',
    })

    const session = await manager.createSession({
      projectId: project.config.id,
      startupCommand: 'codex',
      createWithWorktree: true,
    })

    expect(mocks.createProjectSessionWorktree).toHaveBeenCalledWith({
      projectRootPath: 'C:\\repo',
      sessionId: session.config.id,
      createdAt: session.config.createdAt,
    })
    expect(session.config.cwd).toBe(
      'C:\\Users\\hduan10\\.codex\\worktrees\\repo\\20260317-153045-session',
    )
    expect((mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[2]).toEqual(
      expect.objectContaining({
        cwd: 'C:\\Users\\hduan10\\.codex\\worktrees\\repo\\20260317-153045-session',
      }),
    )
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

  it('ignores low-signal first prompts until a meaningful title is available', async () => {
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
      startupCommand: 'copilot',
    })

    manager.writeToSession(session.config.id, '/')
    manager.writeToSession(session.config.id, '\r')

    let currentSession = manager
      .listSessions()
      .projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )

    expect(currentSession?.config.title).toBe('copilot')
    expect(currentSession?.config.pendingFirstPromptTitle).toBe(true)

    manager.writeToSession(session.config.id, 'review callout analysis')
    manager.writeToSession(session.config.id, '\r')

    currentSession = manager
      .listSessions()
      .projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )

    expect(currentSession?.config.title).toBe('review callout analysis')
    expect(currentSession?.config.pendingFirstPromptTitle).toBe(false)
    expect(onConfig).toHaveBeenCalledWith({
      sessionId: session.config.id,
      config: expect.objectContaining({
        id: session.config.id,
        title: 'review callout analysis',
        pendingFirstPromptTitle: false,
      }),
    })
  })

  it('hydrates Copilot sessions from workspace summaries when the stored title is low-signal', () => {
    const externalSessionId = '33301b34-0c7c-4968-aa11-cc87fe2bdea4'
    const workspaceFilePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      externalSessionId,
      'workspace.yaml',
    )

    mocks.setFile(
      workspaceFilePath,
      [
        `id: ${externalSessionId}`,
        'cwd: C:\\repo',
        'summary: Review ECG2 Callout Analysis',
        'created_at: 2026-03-13T13:29:40.918Z',
      ].join('\n'),
    )
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-13T13:29:32.043Z',
          updatedAt: '2026-03-13T13:29:32.043Z',
        },
      ],
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: '/',
          startupCommand: 'copilot',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-13T13:29:32.043Z',
          updatedAt: '2026-03-13T13:29:55.564Z',
          externalSession: {
            provider: 'copilot',
            sessionId: externalSessionId,
            detectedAt: '2026-03-13T13:29:41.129Z',
          },
        },
      ],
      activeSessionId: 'session-1',
    })

    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const hydratedSession = manager.listSessions().projects[0]?.sessions[0]

    expect(hydratedSession?.config.title).toBe('Review ECG2 Callout Analysis')
    expect(hydratedSession?.config.pendingFirstPromptTitle).toBe(false)
    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{ title: string }>
        }
      ).sessions[0]?.title,
    ).toBe('Review ECG2 Callout Analysis')
  })
})

describe('SessionManager logical project identity and project context', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.reset()
  })

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
  })

  it('merges separate local copies with the same remote fingerprint into one logical project', async () => {
    const identityResolver = {
      inspect: vi.fn(async (rootPath: string): Promise<ProjectLocationIdentity> => {
        if (rootPath === 'C:\\repo\\copy-a') {
          return {
            rootPath,
            label: 'copy-a',
            repoRoot: rootPath,
            gitCommonDir: 'C:\\repo\\copy-a\\.git',
            remoteFingerprint: 'github.com/openai/agenclis',
          }
        }

        return {
          rootPath,
          label: 'copy-b',
          repoRoot: rootPath,
          gitCommonDir: 'D:\\backup\\copy-b\\.git',
          remoteFingerprint: 'github.com/openai/agenclis',
        }
      }),
    }

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        identityResolver,
      },
    )

    const firstProject = await manager.createProject({
      title: 'Workspace',
      rootPath: 'C:\\repo\\copy-a',
    })
    const secondProject = await manager.createProject({
      title: 'Workspace backup',
      rootPath: 'D:\\backup\\copy-b',
    })

    expect(secondProject.config.id).toBe(firstProject.config.id)
    expect(secondProject.config.rootPath).toBe('D:\\backup\\copy-b')
    expect(secondProject.locations).toEqual([
      expect.objectContaining({
        label: 'copy-b',
        rootPath: 'D:\\backup\\copy-b',
      }),
      expect.objectContaining({
        label: 'copy-a',
        rootPath: 'C:\\repo\\copy-a',
      }),
    ])
  })

  it('injects project context as system input without consuming the first user prompt title', async () => {
    const transcriptEvents: TranscriptEvent[] = []
    const transcriptStore = {
      append: vi.fn(async (event: TranscriptEvent) => {
        transcriptEvents.push(event)
      }),
      readEvents: vi.fn(async () => structuredClone(transcriptEvents)),
    }
    const projectMemory = {
      assembleContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:10.000Z',
        bootstrapMessage: 'Use the project memory.\nRead:\n- memory.md',
        fileReferences: ['memory.md'],
        summaryExcerpt: 'Latest summary',
      })),
      captureSession: vi.fn(async () => undefined),
      scheduleBackfillSessions: vi.fn(() => undefined),
      dispose: vi.fn(() => undefined),
    }
    const identityResolver = {
      inspect: vi.fn(async (rootPath: string): Promise<ProjectLocationIdentity> => ({
        rootPath,
        label: 'repo',
        repoRoot: rootPath,
        gitCommonDir: `${rootPath}\\.git`,
        remoteFingerprint: 'github.com/openai/agenclis',
      })),
    }

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        identityResolver,
        transcriptStore,
        projectMemory,
      },
    )

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
      attachProjectContext: true,
    })

    await vi.runOnlyPendingTimersAsync()

    expect(mocks.terminals[0]?.write).toHaveBeenCalledWith(
      'Use the project memory.\nRead:\n- memory.md\r',
    )

    const bootstrappedSession = manager
      .listSessions()
      .projects[0]?.sessions.find((entry) => entry.config.id === session.config.id)

    expect(bootstrappedSession?.config.title).toBe('codex')
    expect(bootstrappedSession?.config.pendingFirstPromptTitle).toBe(true)
    expect(projectMemory.assembleContext).toHaveBeenCalled()
    expect(
      transcriptStore.append.mock.calls.some(
        ([event]) =>
          event.kind === 'input' &&
          event.source === 'system' &&
          event.sessionId === session.config.id,
      ),
    ).toBe(true)

    manager.writeToSession(session.config.id, 'real user task')
    manager.writeToSession(session.config.id, '\r')

    const renamedSession = manager
      .listSessions()
      .projects[0]?.sessions.find((entry) => entry.config.id === session.config.id)

    expect(renamedSession?.config.title).toBe('real user task')
  })

  it('queues project memory capture when a session is closed', async () => {
    const transcriptEvents: TranscriptEvent[] = []
    const transcriptStore = {
      append: vi.fn(async (event: TranscriptEvent) => {
        transcriptEvents.push(event)
      }),
    }
    const projectMemory = {
      assembleContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:10.000Z',
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
      })),
      captureSession: vi.fn(async () => undefined),
      scheduleBackfillSessions: vi.fn(() => undefined),
      dispose: vi.fn(() => undefined),
    }
    const identityResolver = {
      inspect: vi.fn(async (rootPath: string): Promise<ProjectLocationIdentity> => ({
        rootPath,
        label: 'repo',
        repoRoot: rootPath,
        gitCommonDir: `${rootPath}\\.git`,
        remoteFingerprint: 'github.com/openai/agenclis',
      })),
    }

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        identityResolver,
        transcriptStore,
        projectMemory,
      },
    )

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
    })

    manager.closeSession(session.config.id)
    await vi.waitFor(() => {
      expect(projectMemory.captureSession).toHaveBeenCalledTimes(1)
    })

    expect(projectMemory.captureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({
          id: session.config.projectId,
        }),
        location: expect.objectContaining({
          id: session.config.locationId,
        }),
        session: expect.objectContaining({
          id: session.config.id,
        }),
      }),
    )
  })

  it('queues project memory capture for open sessions during shutdown', async () => {
    const projectMemory = {
      assembleContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:10.000Z',
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
      })),
      captureSession: vi.fn(async () => undefined),
      scheduleBackfillSessions: vi.fn(() => undefined),
      dispose: vi.fn(() => undefined),
    }
    const identityResolver = {
      inspect: vi.fn(async (rootPath: string): Promise<ProjectLocationIdentity> => ({
        rootPath,
        label: 'repo',
        repoRoot: rootPath,
        gitCommonDir: `${rootPath}\\.git`,
        remoteFingerprint: 'github.com/openai/agenclis',
      })),
    }

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        identityResolver,
        transcriptStore: {
          append: vi.fn(async () => undefined),
        },
        projectMemory,
      },
    )

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
    })

    manager.dispose()
    await vi.waitFor(() => {
      expect(projectMemory.captureSession).toHaveBeenCalledTimes(1)
    })

    expect(projectMemory.captureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          id: session.config.id,
        }),
      }),
    )
    expect(projectMemory.dispose).toHaveBeenCalledTimes(1)
  })

  it('schedules low-priority project-memory backfill after restore', async () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-22T12:00:00.000Z',
          updatedAt: '2026-03-22T12:00:00.000Z',
          primaryLocationId: 'location-1',
          identity: {
            repoRoot: null,
            gitCommonDir: null,
            remoteFingerprint: null,
          },
        },
      ],
      locations: [
        {
          id: 'location-1',
          projectId: 'project-1',
          rootPath: 'C:\\repo',
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: null,
          label: 'repo',
          createdAt: '2026-03-22T12:00:00.000Z',
          updatedAt: '2026-03-22T12:00:00.000Z',
          lastSeenAt: '2026-03-22T12:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          locationId: 'location-1',
          title: 'triage issue',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-22T12:00:00.000Z',
          updatedAt: '2026-03-22T12:05:00.000Z',
        },
      ],
      activeSessionId: null,
    })

    const projectMemory = {
      assembleContext: vi.fn(async () => ({
        projectId: 'project-1',
        locationId: 'location-1',
        generatedAt: '2026-03-22T12:00:10.000Z',
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
      })),
      captureSession: vi.fn(async () => undefined),
      scheduleBackfillSessions: vi.fn(() => undefined),
      dispose: vi.fn(() => undefined),
    }
    const identityResolver = {
      inspect: vi.fn(async (rootPath: string): Promise<ProjectLocationIdentity> => ({
        rootPath,
        label: 'repo',
        repoRoot: rootPath,
        gitCommonDir: `${rootPath}\\.git`,
        remoteFingerprint: 'github.com/openai/agenclis',
      })),
    }

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        identityResolver,
        transcriptStore: {
          append: vi.fn(async () => undefined),
        },
        projectMemory,
      },
    )

    await manager.restoreSessions()
    await vi.runOnlyPendingTimersAsync()

    expect(projectMemory.scheduleBackfillSessions).toHaveBeenCalledTimes(1)
    expect(projectMemory.scheduleBackfillSessions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          session: expect.objectContaining({
            id: 'session-a',
            startupCommand: 'codex',
          }),
        }),
      ]),
    )
  })
})
