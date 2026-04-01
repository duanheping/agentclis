// @vitest-environment node

import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptEvent } from '../src/shared/projectMemory'
import type { SessionDataEvent } from '../src/shared/session'
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
    killTerminalProcessTree: vi.fn(),
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
      mocks.killTerminalProcessTree.mockReset()
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

vi.mock('./ptyProcessTree', () => ({
  killTerminalProcessTree: mocks.killTerminalProcessTree,
}))

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
          size: Buffer.byteLength(fileMeta.content),
        }
      }

      const childModificationTimes = mocks
        .listFiles()
        .filter(([filePath]) => filePath.startsWith(`${normalizedTargetPath}\\`))
        .map(([, meta]) => meta.mtimeMs)

      if (childModificationTimes.length > 0) {
        return {
          mtimeMs: Math.max(...childModificationTimes),
          size: 0,
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

function buildProjectMemoryContext(
  projectId = 'project-1',
  locationId = 'location-1',
) {
  return {
    projectId,
    locationId,
    generatedAt: '2026-03-22T12:00:10.000Z',
    bootstrapMessage: null,
    fileReferences: [],
    summaryExcerpt: null,
  }
}

function buildProjectMemoryServiceMock(
  overrides: Record<string, unknown> = {},
) {
  return {
    assembleContext: vi.fn(async () => buildProjectMemoryContext()),
    captureSession: vi.fn(async () => undefined),
    scheduleBackfillSessions: vi.fn(() => undefined),
    refreshHistoricalImport: vi.fn(async () => ({
      cleanedProjectCount: 0,
      removedEmptySummaryCount: 0,
      prunedCandidateCount: 0,
      regeneratedArchitectureCount: 0,
    })),
    analyzeHistoricalArchitecture: vi.fn(async () => ({
      analyzedProjectCount: 0,
    })),
    analyzeHistoricalSessions: vi.fn(async () => ({
      analyzedProjectCount: 0,
      analyzedSessionCount: 0,
      skippedSessionCount: 0,
    })),
    dispose: vi.fn(() => undefined),
    ...overrides,
  }
}

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

  it('restores all saved sessions at launch and reuses running terminals on demand', async () => {
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
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    const firstSpawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(firstSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'beta',
    ])
    const secondSpawnArgs = (mocks.spawn.mock.calls[1] as unknown[] | undefined)?.[1]
    expect(secondSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'alpha',
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
      'session-a': 'running',
      'session-b': 'running',
    })

    vi.runOnlyPendingTimers()
    expect(mocks.terminals[0].write).not.toHaveBeenCalled()
    expect(mocks.terminals[1].write).not.toHaveBeenCalled()

    await manager.activateSession('session-a')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(manager.listSessions().activeSessionId).toBe('session-a')

    vi.runOnlyPendingTimers()
    expect(mocks.terminals[0].write).not.toHaveBeenCalled()
    expect(mocks.terminals[1].write).not.toHaveBeenCalled()

    await manager.activateSession('session-a')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })

  it('keeps the restored active session first even when titles would sort it later', () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-a',
          title: 'Alpha project',
          rootPath: 'C:\\repo\\alpha',
          createdAt: '2026-03-11T10:00:00.000Z',
          updatedAt: '2026-03-11T10:00:00.000Z',
        },
        {
          id: 'project-b',
          title: 'Beta project',
          rootPath: 'C:\\repo\\beta',
          createdAt: '2026-03-11T10:01:00.000Z',
          updatedAt: '2026-03-11T10:01:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-a',
          title: 'alpha',
          startupCommand: 'alpha',
          cwd: 'C:\\repo\\alpha',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-11T10:00:00.000Z',
          updatedAt: '2026-03-11T10:00:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-b',
          title: 'zeta',
          startupCommand: 'beta',
          cwd: 'C:\\repo\\beta',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-11T10:01:00.000Z',
          updatedAt: '2026-03-11T10:01:00.000Z',
        },
      ],
      activeSessionId: 'session-b',
    })

    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const snapshot = manager.listSessions()
    expect(snapshot.projects.map((project) => project.config.id)).toEqual([
      'project-b',
      'project-a',
    ])
    expect(snapshot.projects[0]?.sessions.map((session) => session.config.id)).toEqual([
      'session-b',
    ])
  })

  it('restores inactive session ordering from persisted lastActiveAt values', () => {
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
          title: 'zeta',
          startupCommand: 'beta',
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-11T10:01:00.000Z',
          updatedAt: '2026-03-11T10:01:00.000Z',
        },
      ],
      runtimes: [
        {
          sessionId: 'session-a',
          lastActiveAt: '2026-03-11T10:00:00.000Z',
        },
        {
          sessionId: 'session-b',
          lastActiveAt: '2026-03-11T10:01:00.000Z',
        },
      ],
      activeSessionId: null,
    })

    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    expect(
      manager.listSessions().projects[0]?.sessions.map((session) => session.config.id),
    ).toEqual(['session-b', 'session-a'])
  })

  it('keeps another restored session running when closing the restored active session', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.restoreSessions()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)

    const closeResult = await manager.closeSession('session-b')

    expect(closeResult).toEqual({
      closedSessionId: 'session-b',
      activeSessionId: 'session-a',
    })
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(manager.listSessions().activeSessionId).toBe('session-a')
    expect(
      Object.fromEntries(
        manager.listSessions().projects[0]?.sessions.map((session) => [
          session.config.id,
          session.runtime.status,
        ]) ?? [],
      ),
    ).toEqual({
      'session-a': 'running',
    })
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

  it('restores a saved Codex session id even when newer transcripts exceed the recent scan window', async () => {
    const externalSessionId = '019saved-codex-session'
    const startedAt = new Date('2026-03-15T18:10:31.000Z')

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
          externalSession: {
            provider: 'codex',
            sessionId: externalSessionId,
            detectedAt: '2026-03-15T18:10:35.000Z',
          },
        },
      ],
      activeSessionId: 'session-a',
    })

    const targetSessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '15',
      `rollout-2026-03-15T18-10-31-${externalSessionId}.jsonl`,
    )
    mocks.setFile(
      targetSessionFilePath,
      [
        `{"timestamp":"${startedAt.toISOString()}","type":"session_meta","payload":{"id":"${externalSessionId}","timestamp":"${startedAt.toISOString()}","cwd":"C:\\\\repo","originator":"codex_cli_rs","source":"cli"}}`,
      ].join('\n'),
      startedAt.getTime(),
    )

    for (let index = 0; index < 40; index += 1) {
      const decoyStartedAt = new Date(startedAt.getTime() + (index + 1) * 60_000)
      const decoySessionFilePath = path.join(
        os.homedir(),
        '.codex',
        'sessions',
        '2026',
        '03',
        '15',
        `rollout-decoy-session-${index}.jsonl`,
      )
      mocks.setFile(
        decoySessionFilePath,
        [
          `{"timestamp":"${decoyStartedAt.toISOString()}","type":"session_meta","payload":{"id":"019decoy-session-${index}","timestamp":"${decoyStartedAt.toISOString()}","cwd":"C:\\\\other-${index}","originator":"codex_cli_rs","source":"cli"}}`,
        ].join('\n'),
        decoyStartedAt.getTime(),
      )
    }

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
      `codex resume ${externalSessionId}`,
    ])
  })

  it('backfills Codex attention from a recovered transcript before polling new lines', async () => {
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
          title: 'review PR',
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
        '{"timestamp":"2026-03-15T18:10:31.000Z","type":"session_meta","payload":{"id":"019cf7a4-db19-78a0-a9b1-b9e3d2b0126a","timestamp":"2026-03-15T18:10:31.000Z","cwd":"C:\\\\repo","originator":"codex_cli_rs","source":"cli"}}',
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review PR"}]}}',
        '{"type":"event_msg","payload":{"type":"agent_message","message":"Should I open a PR?","phase":"final_answer"}}',
        '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}',
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

    await vi.waitFor(() => {
      expect(
        manager.listSessions().projects[0]?.sessions[0]?.runtime.attention,
      ).toBe('needs-user-decision')
    })
  })

  it('restores a Codex session when the saved title is an ellipsized first prompt', async () => {
    const fullPrompt =
      'let review agentclis session save and resume logic because restart recovery still fails for older codex sessions'
    const truncatedTitle =
      'let review agentclis session save and resume logic because restart recovery...'

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
          title: truncatedTitle,
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
        '{"timestamp":"2026-03-15T18:10:31.000Z","type":"session_meta","payload":{"id":"019cf7a4-db19-78a0-a9b1-b9e3d2b0126a","timestamp":"2026-03-15T18:10:31.000Z","cwd":"C:\\\\repo","originator":"codex_cli_rs","source":"cli"}}',
        `{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"${fullPrompt}"}]}}`,
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
      'codex resume 019cf7a4-db19-78a0-a9b1-b9e3d2b0126a',
    ])
  })

  it('keeps a restore session failed when only an ineligible Codex Desktop transcript is available', async () => {
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
    expect(mocks.spawn).not.toHaveBeenCalled()

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: { sessionId: string }
          }>
        }
      ).sessions[0]?.externalSession,
    ).toBeUndefined()
    expect(
      manager.listSessions().projects[0]?.sessions[0]?.runtime.status,
    ).toBe('error')
  })

  it('clears a saved Codex Desktop session id but does not launch a fresh Codex session', async () => {
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
    expect(mocks.spawn).not.toHaveBeenCalled()

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: { sessionId: string }
          }>
        }
      ).sessions[0]?.externalSession,
    ).toBeUndefined()
    expect(
      manager.listSessions().projects[0]?.sessions[0]?.runtime.status,
    ).toBe('error')
  })

  it('drops a stale saved Copilot session id and recovers a matching historical session before restore', async () => {
    const onConfig = vi.fn()
    const staleExternalSessionId = 'stale-copilot-session'
    const recoveredExternalSessionId = '11111111-2222-3333-4444-555555555555'

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-20T08:00:00.000Z',
          updatedAt: '2026-03-20T08:15:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'review callout analysis',
          startupCommand: 'copilot',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-20T08:00:24.756Z',
          updatedAt: '2026-03-20T08:15:00.000Z',
          externalSession: {
            provider: 'copilot',
            sessionId: staleExternalSessionId,
            detectedAt: '2026-03-20T08:01:00.000Z',
          },
        },
      ],
      activeSessionId: 'session-a',
    })

    const recoveredWorkspacePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      recoveredExternalSessionId,
      'workspace.yaml',
    )
    const recoveredEventsPath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      recoveredExternalSessionId,
      'events.jsonl',
    )

    mocks.setFile(
      recoveredWorkspacePath,
      [
        `id: ${recoveredExternalSessionId}`,
        'cwd: C:\\repo',
        'created_at: 2026-03-20T08:00:31.000Z',
      ].join('\n'),
      '2026-03-20T08:15:00.000Z',
    )
    mocks.setFile(
      recoveredEventsPath,
      [
        '{"type":"user.message","data":{"content":"review callout analysis"}}',
        '{"type":"assistant.message","data":{"content":"All set.","toolRequests":[]}}',
      ].join('\n'),
      '2026-03-20T08:15:00.000Z',
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
      `copilot --resume ${recoveredExternalSessionId}`,
    ])

    expect(onConfig).toHaveBeenCalledWith({
      sessionId: 'session-a',
      config: expect.objectContaining({
        externalSession: {
          provider: 'copilot',
          sessionId: recoveredExternalSessionId,
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
    ).toBe(recoveredExternalSessionId)
  })

  it('restores a saved Copilot session id even when newer session folders exceed the recent scan window', async () => {
    const externalSessionId = '11111111-2222-3333-4444-555555555555'

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-20T08:00:00.000Z',
          updatedAt: '2026-03-20T08:15:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'review callout analysis',
          startupCommand: 'copilot',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-20T08:00:24.756Z',
          updatedAt: '2026-03-20T08:15:00.000Z',
          externalSession: {
            provider: 'copilot',
            sessionId: externalSessionId,
            detectedAt: '2026-03-20T08:01:00.000Z',
          },
        },
      ],
      activeSessionId: 'session-a',
    })

    mocks.setFile(
      path.join(
        os.homedir(),
        '.copilot',
        'session-state',
        externalSessionId,
        'workspace.yaml',
      ),
      [
        `id: ${externalSessionId}`,
        'cwd: C:\\repo',
        'summary: Review Callout Analysis',
        'created_at: 2026-03-20T08:00:31.000Z',
      ].join('\n'),
      '2026-03-20T08:15:00.000Z',
    )

    for (let index = 0; index < 40; index += 1) {
      const decoyId = `decoy-session-${index}`
      mocks.setFile(
        path.join(
          os.homedir(),
          '.copilot',
          'session-state',
          decoyId,
          'workspace.yaml',
        ),
        [
          `id: ${decoyId}`,
          `cwd: C:\\other-${index}`,
          `created_at: 2026-03-20T09:${`${index}`.padStart(2, '0')}:00.000Z`,
        ].join('\n'),
        `2026-03-20T09:${`${index}`.padStart(2, '0')}:00.000Z`,
      )
    }

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
      `copilot --resume ${externalSessionId}`,
    ])
  })

  it('recovers a saved Codex session from timestamps when the restored title no longer matches the transcript', async () => {
    const recoveredExternalSessionId = '019recovered-codex-session'
    const recoveredStartedAt = new Date('2026-03-20T08:00:31.000Z')

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-20T08:00:00.000Z',
          updatedAt: '2026-03-20T08:15:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'Manual review title',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: '2026-03-20T08:00:24.756Z',
          updatedAt: '2026-03-20T08:15:00.000Z',
          externalSession: {
            provider: 'codex',
            sessionId: 'stale-codex-session',
            detectedAt: '2026-03-20T08:01:00.000Z',
          },
        },
      ],
      activeSessionId: 'session-a',
    })

    const recoveredSessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '20',
      `rollout-2026-03-20T08-00-31-${recoveredExternalSessionId}.jsonl`,
    )
    mocks.setFile(
      recoveredSessionFilePath,
      [
        `{"timestamp":"${recoveredStartedAt.toISOString()}","type":"session_meta","payload":{"id":"${recoveredExternalSessionId}","timestamp":"${recoveredStartedAt.toISOString()}","cwd":"C:\\\\repo","originator":"codex_cli_rs","source":"cli"}}`,
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review callout analysis"}]}}',
      ].join('\n'),
      recoveredStartedAt.getTime(),
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
      `codex resume ${recoveredExternalSessionId}`,
    ])
  })

  it('does not cross-match external sessions between sibling sessions in the same project', async () => {
    const sessionACreated = '2026-03-22T12:00:00.000Z'
    const sessionBCreated = '2026-03-22T12:05:00.000Z'
    const codexAStarted = new Date('2026-03-22T12:00:07.000Z')
    const codexBStarted = new Date('2026-03-22T12:05:08.000Z')

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: sessionACreated,
          updatedAt: sessionBCreated,
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'analyze architecture',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: sessionACreated,
          updatedAt: sessionACreated,
        },
        {
          id: 'session-b',
          projectId: 'project-1',
          title: 'review pull request',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt: sessionBCreated,
          updatedAt: sessionBCreated,
        },
      ],
      activeSessionId: 'session-a',
    })

    const codexAFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '22',
      'rollout-2026-03-22T12-00-07-019codex-session-a.jsonl',
    )
    mocks.setFile(
      codexAFilePath,
      [
        `{"timestamp":"${codexAStarted.toISOString()}","type":"session_meta","payload":{"id":"019codex-session-a","timestamp":"${codexAStarted.toISOString()}","cwd":"C:\\\\repo","originator":"codex_cli_rs"}}`,
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"analyze architecture"}]}}',
      ].join('\n'),
      codexAStarted.getTime(),
    )

    const codexBFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '22',
      'rollout-2026-03-22T12-05-08-019codex-session-b.jsonl',
    )
    mocks.setFile(
      codexBFilePath,
      [
        `{"timestamp":"${codexBStarted.toISOString()}","type":"session_meta","payload":{"id":"019codex-session-b","timestamp":"${codexBStarted.toISOString()}","cwd":"C:\\\\repo","originator":"codex_cli_rs"}}`,
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review pull request"}]}}',
      ].join('\n'),
      codexBStarted.getTime(),
    )

    const onConfig = vi.fn()
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.restoreSessions()
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(2)
    })

    // Session A (active) should resume its own codex session, not session B's.
    const firstSpawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(firstSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex resume 019codex-session-a',
    ])

    // Session B should also resume its own codex session during restore.
    const secondSpawnArgs = (mocks.spawn.mock.calls[1] as unknown[] | undefined)?.[1]
    expect(secondSpawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex resume 019codex-session-b',
    ])

    // Activating an already restored session should not spawn another terminal.
    await manager.activateSession('session-b')
    await vi.waitFor(() => {
      expect(mocks.spawn).toHaveBeenCalledTimes(2)
    })
  })

  it('restores a historical Codex session even when newer transcripts push it past the recent-file window', async () => {
    const createdAt = '2026-03-30T15:10:31.377Z'
    const updatedAt = '2026-03-30T15:12:35.672Z'
    const startedAt = new Date('2026-03-30T15:10:33.570Z')
    vi.setSystemTime(new Date('2026-03-30T17:00:00.000Z'))

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt,
          updatedAt,
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-1',
          title: 'inspect codex hook plugins',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          createdAt,
          updatedAt,
        },
      ],
      activeSessionId: 'session-a',
    })

    const targetSessionFilePath = path.join(
      os.homedir(),
      '.codex',
      'sessions',
      '2026',
      '03',
      '30',
      'rollout-target-session.jsonl',
    )
    mocks.setFile(
      targetSessionFilePath,
      [
        `{"timestamp":"${startedAt.toISOString()}","type":"session_meta","payload":{"id":"019historical-codex-session","timestamp":"${startedAt.toISOString()}","cwd":"C:\\\\repo","originator":"codex_cli_rs","source":"cli"}}`,
        '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"inspect codex hook plugins"}]}}',
      ].join('\n'),
      startedAt.getTime(),
    )

    for (let index = 0; index < 40; index += 1) {
      const decoyStartedAt = new Date(startedAt.getTime() + (index + 1) * 60_000)
      const decoySessionFilePath = path.join(
        os.homedir(),
        '.codex',
        'sessions',
        '2026',
        '03',
        '30',
        `rollout-decoy-session-${index}.jsonl`,
      )
      mocks.setFile(
        decoySessionFilePath,
        [
          `{"timestamp":"${decoyStartedAt.toISOString()}","type":"session_meta","payload":{"id":"019decoy-session-${index}","timestamp":"${decoyStartedAt.toISOString()}","cwd":"C:\\\\other-${index}","originator":"codex_cli_rs","source":"cli"}}`,
        ].join('\n'),
        decoyStartedAt.getTime(),
      )
    }

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

    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex resume 019historical-codex-session',
    ])

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: {
              provider: string
              sessionId: string
            }
          }>
        }
      ).sessions[0]?.externalSession,
    ).toEqual(
      expect.objectContaining({
        provider: 'codex',
        sessionId: '019historical-codex-session',
      }),
    )
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

    await manager.closeSession(session.config.id)

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
    expect(mocks.killTerminalProcessTree).toHaveBeenCalledTimes(1)
    expect(mocks.killTerminalProcessTree).toHaveBeenCalledWith(mocks.terminals[0])
  })

  it('launches Codex in true bypass mode when full-access is selected', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
      permissionLevel: 'full-access',
    })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex --dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('launches Copilot with full-access flags when full-access is selected', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'copilot',
      permissionLevel: 'full-access',
    })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'copilot --allow-all --no-ask-user',
    ])
  })

  it('adds Copilot full-access flags even when related allow flags are already present', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'copilot --allow-all-paths --no-color',
      permissionLevel: 'full-access',
    })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'copilot --allow-all-paths --no-color --allow-all --no-ask-user',
    ])
  })

  it('does not mistake Copilot option values for existing full-access flags', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'copilot --config-dir "C:\\tmp\\--allow-all" --no-ask-user',
      permissionLevel: 'full-access',
    })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'copilot --config-dir C:\\tmp\\--allow-all --no-ask-user --allow-all',
    ])
  })

  it('does not duplicate existing Copilot full-access flags', async () => {
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'copilot --allow-all --no-ask-user',
      permissionLevel: 'full-access',
    })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'copilot --allow-all --no-ask-user',
    ])
  })

  it('starts a fresh Codex session instead of reviving project history', async () => {
    const now = new Date('2026-03-27T15:00:00.000Z')
    vi.setSystemTime(now)
    const startedAt = new Date(now.getTime() - 2_000)
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
    await vi.runAllTimersAsync()

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const spawnArgs = (mocks.spawn.mock.calls[0] as unknown[] | undefined)?.[1]
    expect(spawnArgs).toEqual([
      '-NoLogo',
      '-NoExit',
      '-Command',
      'codex',
    ])
    expect(session.config.externalSession).toBeUndefined()
    expect(
      manager.listSessions().projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )?.config.externalSession,
    ).toBeUndefined()
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

  it('marks a live session as needing user attention when the terminal shows an approval prompt', async () => {
    const onRuntime = vi.fn()
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime,
      onExit: () => undefined,
    })

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
    })

    const terminalDataListener = mocks.terminals[0]?.onData.mock.calls[0]?.[0] as
      | ((chunk: string) => void)
      | undefined

    expect(terminalDataListener).toBeTypeOf('function')

    terminalDataListener?.(
      '\r\nWould you like to run the following command?\r\n',
    )
    terminalDataListener?.(
      '\r\nPress enter to confirm or esc to cancel\r\n',
    )

    expect(
      manager.listSessions().projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )?.runtime.attention,
    ).toBe('needs-user-decision')
    expect(onRuntime).toHaveBeenCalledWith({
      sessionId: session.config.id,
      runtime: expect.objectContaining({
        attention: 'needs-user-decision',
      }),
    })

    manager.writeToSession(session.config.id, 'y')

    expect(
      manager.listSessions().projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )?.runtime.attention,
    ).toBeNull()
  })

  it('marks Copilot sessions as awaiting a response after user input and clears it on completion', async () => {
    const onRuntime = vi.fn()
    const manager = new SessionManager({
      onData: () => undefined,
      onConfig: () => undefined,
      onRuntime,
      onExit: () => undefined,
    })

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'copilot',
    })

    manager.writeToSession(session.config.id, 'please investigate')
    manager.writeToSession(session.config.id, '\r')

    expect(
      manager.listSessions().projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )?.runtime.awaitingResponse,
    ).toBe(true)

    const eventsFilePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      'copilot-session-1',
      'events.jsonl',
    )
    mocks.setFile(
      eventsFilePath,
      [
        '{"type":"user.message","data":{"content":"please investigate"}}',
        '{"type":"assistant.turn_start","data":{"turnId":"1"}}',
        '{"type":"assistant.message","data":{"content":"All done.","toolRequests":[]}}',
      ].join('\n'),
      '2026-03-31T18:40:00.000Z',
    )

    const externalConfig = manager
      .listSessions()
      .projects[0]?.sessions.find((entry) => entry.config.id === session.config.id)?.config

    expect(externalConfig?.externalSession?.provider).toBeUndefined()
    expect(externalConfig).toBeDefined()

    mocks.setFile(
      path.join(
        os.homedir(),
        '.copilot',
        'session-state',
        'copilot-session-1',
        'workspace.yaml',
      ),
      [
        'id: copilot-session-1',
        'cwd: C:\\repo',
        'summary: Investigate reminder state',
        'created_at: 2026-03-31T18:35:05.000Z',
      ].join('\n'),
      '2026-03-31T18:35:05.000Z',
    )

    ;(manager as unknown as {
      attachExternalSession: (
        config: typeof session.config,
        detectedSession: {
          provider: 'copilot'
          sessionId: string
          timestamp: string
          cwd: string
          startedAt: number
          sourcePath: string
        },
      ) => void
    }).attachExternalSession(
      externalConfig!,
      {
        provider: 'copilot',
        sessionId: 'copilot-session-1',
        timestamp: '2026-03-31T18:35:05.000Z',
        cwd: 'C:\\repo',
        startedAt: Date.parse('2026-03-31T18:35:05.000Z'),
        sourcePath: eventsFilePath,
      },
    )

    await vi.waitFor(() => {
      expect(
        manager.listSessions().projects[0]?.sessions.find(
          (entry) => entry.config.id === session.config.id,
        )?.runtime.awaitingResponse,
      ).toBe(false)
    })

    expect(
      manager.listSessions().projects[0]?.sessions.find(
        (entry) => entry.config.id === session.config.id,
      )?.runtime.attention,
    ).toBe('task-complete')
    expect(onRuntime).toHaveBeenCalledWith({
      sessionId: session.config.id,
      runtime: expect.objectContaining({
        awaitingResponse: true,
      }),
    })
    expect(onRuntime).toHaveBeenCalledWith({
      sessionId: session.config.id,
      runtime: expect.objectContaining({
        awaitingResponse: false,
        attention: 'task-complete',
      }),
    })
  })

  it('routes terminal data to the correct session when multiple sessions run concurrently', async () => {
    const onData = vi.fn()
    const manager = new SessionManager({
      onData,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const session1 = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'first',
    })

    const session2 = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'second',
    })

    const session3 = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'third',
    })

    const terminal1Listener = mocks.terminals[0]?.onData.mock.calls[0]?.[0] as
      | ((chunk: string) => void)
      | undefined
    const terminal2Listener = mocks.terminals[1]?.onData.mock.calls[0]?.[0] as
      | ((chunk: string) => void)
      | undefined
    const terminal3Listener = mocks.terminals[2]?.onData.mock.calls[0]?.[0] as
      | ((chunk: string) => void)
      | undefined

    expect(terminal1Listener).toBeTypeOf('function')
    expect(terminal2Listener).toBeTypeOf('function')
    expect(terminal3Listener).toBeTypeOf('function')

    terminal1Listener?.('output-from-session-1')
    terminal3Listener?.('output-from-session-3')
    terminal2Listener?.('output-from-session-2')

    const dataEvents = onData.mock.calls.map(
      ([event]) => event as SessionDataEvent,
    )
    const session1Events = dataEvents.filter(
      (event) => event.sessionId === session1.config.id,
    )
    const session2Events = dataEvents.filter(
      (event) => event.sessionId === session2.config.id,
    )
    const session3Events = dataEvents.filter(
      (event) => event.sessionId === session3.config.id,
    )

    expect(session1Events).toHaveLength(1)
    expect(session1Events[0]?.chunk).toBe('output-from-session-1')

    expect(session2Events).toHaveLength(1)
    expect(session2Events[0]?.chunk).toBe('output-from-session-2')

    expect(session3Events).toHaveLength(1)
    expect(session3Events[0]?.chunk).toBe('output-from-session-3')
  })

  it('ignores terminal data from a replaced terminal after session restart', async () => {
    const onData = vi.fn()
    const manager = new SessionManager({
      onData,
      onConfig: () => undefined,
      onRuntime: () => undefined,
      onExit: () => undefined,
    })

    const session = await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'agent',
    })

    const oldTerminalListener = mocks.terminals[0]?.onData.mock.calls[0]?.[0] as
      | ((chunk: string) => void)
      | undefined

    await manager.restartSession(session.config.id)

    const newTerminalListener = mocks.terminals[1]?.onData.mock.calls[0]?.[0] as
      | ((chunk: string) => void)
      | undefined

    expect(oldTerminalListener).toBeTypeOf('function')
    expect(newTerminalListener).toBeTypeOf('function')

    onData.mockClear()

    oldTerminalListener?.('stale-data-from-old-terminal')
    newTerminalListener?.('fresh-data-from-new-terminal')

    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData).toHaveBeenCalledWith({
      sessionId: session.config.id,
      chunk: 'fresh-data-from-new-terminal',
    })
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

  it('keeps restored legacy path titles eligible for first-prompt inference', () => {
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
          title: 'C:\\Users\\hduan10\\AppData\\Local\\Temp\\codex.exe',
          startupCommand: 'C:\\Users\\hduan10\\AppData\\Local\\Temp\\codex.exe --model gpt',
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-13T13:29:32.043Z',
          updatedAt: '2026-03-13T13:29:55.564Z',
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

    const restoredSession = manager.listSessions().projects[0]?.sessions[0]

    expect(restoredSession?.config.title).toBe('codex')
    expect(restoredSession?.config.pendingFirstPromptTitle).toBe(true)
    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{ title: string; pendingFirstPromptTitle?: boolean }>
        }
      ).sessions[0],
    ).toMatchObject({
      title: 'codex',
      pendingFirstPromptTitle: true,
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

  it('hydrates Copilot historical matches from events when workspace summary is missing', async () => {
    const externalSessionId = '7b66ea2f-c5fe-4665-89b3-5236c54bb5f7'
    const workspaceFilePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      externalSessionId,
      'workspace.yaml',
    )
    const eventsFilePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      externalSessionId,
      'events.jsonl',
    )

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-21T09:00:00.000Z',
          updatedAt: '2026-03-21T09:02:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'review callout analysis',
          startupCommand: 'copilot',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-21T09:00:32.043Z',
          updatedAt: '2026-03-21T09:02:55.564Z',
        },
      ],
      activeSessionId: 'session-1',
    })

    mocks.setFile(
      workspaceFilePath,
      [
        `id: ${externalSessionId}`,
        'cwd: C:\\repo',
        'created_at: 2026-03-21T09:00:40.918Z',
      ].join('\n'),
      '2026-03-21T09:02:00.000Z',
    )
    mocks.setFile(
      eventsFilePath,
      [
        '{"type":"user.message","data":{"content":"review callout analysis"}}',
        '{"type":"assistant.message","data":{"content":"All done.","toolRequests":[]}}',
      ].join('\n'),
      '2026-03-21T09:02:00.000Z',
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
      `copilot --resume ${externalSessionId}`,
    ])

    expect(
      (
        mocks.getPersistedState() as {
          sessions: Array<{
            externalSession?: { provider: string; sessionId: string }
          }>
        }
      ).sessions[0]?.externalSession,
    ).toEqual({
      provider: 'copilot',
      sessionId: externalSessionId,
      detectedAt: expect.any(String),
    })
  })

  it('hydrates Copilot historical matches when the event log is recent but workspace metadata is stale', async () => {
    const externalSessionId = '7b66ea2f-c5fe-4665-89b3-5236c54bb5f7'
    const workspaceFilePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      externalSessionId,
      'workspace.yaml',
    )
    const eventsFilePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      externalSessionId,
      'events.jsonl',
    )

    mocks.setPersistedState({
      projects: [
        {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-21T09:00:00.000Z',
          updatedAt: '2026-03-21T09:02:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'review callout analysis',
          startupCommand: 'copilot',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-21T09:00:32.043Z',
          updatedAt: '2026-03-21T09:02:55.564Z',
        },
      ],
      activeSessionId: 'session-1',
    })

    mocks.setFile(
      workspaceFilePath,
      [
        `id: ${externalSessionId}`,
        'cwd: C:\\repo',
        'created_at: 2026-03-21T09:00:40.918Z',
      ].join('\n'),
      '2026-01-01T00:00:00.000Z',
    )
    mocks.setFile(
      eventsFilePath,
      [
        '{"type":"user.message","data":{"content":"review callout analysis"}}',
        '{"type":"assistant.message","data":{"content":"All done.","toolRequests":[]}}',
      ].join('\n'),
      '2026-03-21T09:02:00.000Z',
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
      `copilot --resume ${externalSessionId}`,
    ])
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

  it('keeps separate local copies with the same remote fingerprint as separate projects', async () => {
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

    expect(secondProject.config.id).not.toBe(firstProject.config.id)
    expect(firstProject.locations).toEqual([
      expect.objectContaining({
        label: 'copy-a',
        rootPath: 'C:\\repo\\copy-a',
      }),
    ])
    expect(secondProject.locations).toEqual([
      expect.objectContaining({
        label: 'copy-b',
        rootPath: 'D:\\backup\\copy-b',
      }),
    ])
    expect(manager.listSessions().projects).toHaveLength(2)
  })

  it('restores persisted duplicate clones as separate projects even when the remote matches', () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-a',
          title: 'Workspace',
          rootPath: 'C:\\repo\\copy-a',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:00:00.000Z',
          primaryLocationId: 'location-a',
          identity: {
            repoRoot: 'C:\\repo\\copy-a',
            gitCommonDir: 'C:\\repo\\copy-a\\.git',
            remoteFingerprint: 'github.com/openai/agenclis',
          },
        },
        {
          id: 'project-b',
          title: 'Workspace copy',
          rootPath: 'D:\\repo\\copy-b',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:00:00.000Z',
          primaryLocationId: 'location-b',
          identity: {
            repoRoot: 'D:\\repo\\copy-b',
            gitCommonDir: 'D:\\repo\\copy-b\\.git',
            remoteFingerprint: 'github.com/openai/agenclis',
          },
        },
      ],
      locations: [
        {
          id: 'location-a',
          projectId: 'project-a',
          rootPath: 'C:\\repo\\copy-a',
          repoRoot: 'C:\\repo\\copy-a',
          gitCommonDir: 'C:\\repo\\copy-a\\.git',
          remoteFingerprint: 'github.com/openai/agenclis',
          label: 'copy-a',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:00:00.000Z',
          lastSeenAt: '2026-03-22T10:00:00.000Z',
        },
        {
          id: 'location-b',
          projectId: 'project-b',
          rootPath: 'D:\\repo\\copy-b',
          repoRoot: 'D:\\repo\\copy-b',
          gitCommonDir: 'D:\\repo\\copy-b\\.git',
          remoteFingerprint: 'github.com/openai/agenclis',
          label: 'copy-b',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:00:00.000Z',
          lastSeenAt: '2026-03-22T11:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-a',
          locationId: 'location-a',
          title: 'alpha',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo\\copy-a',
          shell: 'pwsh.exe',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:30:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-b',
          locationId: 'location-b',
          title: 'beta',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'D:\\repo\\copy-b',
          shell: 'pwsh.exe',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:30:00.000Z',
        },
      ],
      activeSessionId: 'session-b',
    })

    const projectMemory = buildProjectMemoryServiceMock({
      assembleContext: vi.fn(async () => buildProjectMemoryContext('project-a', 'location-a')),
      refreshHistoricalImport: vi.fn(async () => ({
        cleanedProjectCount: 1,
        removedEmptySummaryCount: 2,
        prunedCandidateCount: 3,
        regeneratedArchitectureCount: 1,
      })),
    })

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        projectMemory,
      },
    )

    const snapshot = manager.listSessions()
    const copyAProject = snapshot.projects.find(
      (entry) => entry.config.id === 'project-a',
    )
    const copyBProject = snapshot.projects.find(
      (entry) => entry.config.id === 'project-b',
    )

    expect(snapshot.projects).toHaveLength(2)
    expect(snapshot.projects.map((entry) => entry.config.id)).toEqual([
      'project-b',
      'project-a',
    ])
    expect(copyAProject?.locations).toEqual([
      expect.objectContaining({
        id: 'location-a',
        projectId: 'project-a',
        rootPath: 'C:\\repo\\copy-a',
      }),
    ])
    expect(copyBProject?.locations).toEqual([
      expect.objectContaining({
        id: 'location-b',
        projectId: 'project-b',
        rootPath: 'D:\\repo\\copy-b',
      }),
    ])
    expect(copyAProject?.sessions.map((entry) => entry.config.projectId)).toEqual([
      'project-a',
    ])
    expect(copyBProject?.sessions.map((entry) => entry.config.projectId)).toEqual([
      'project-b',
    ])
  })

  it('splits legacy multi-location projects into separate clone projects during restore', () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-a',
          title: 'MSAR43_S32G',
          rootPath: 'C:\\repo\\copy-a',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:00:00.000Z',
          primaryLocationId: 'location-a',
          identity: {
            repoRoot: 'C:\\repo\\copy-a',
            gitCommonDir: 'C:\\repo\\copy-a\\.git',
            remoteFingerprint: 'github.com/openai/agenclis',
          },
        },
      ],
      locations: [
        {
          id: 'location-a',
          projectId: 'project-a',
          rootPath: 'C:\\repo\\copy-a',
          repoRoot: 'C:\\repo\\copy-a',
          gitCommonDir: 'C:\\repo\\copy-a\\.git',
          remoteFingerprint: 'github.com/openai/agenclis',
          label: 'copy-a',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:00:00.000Z',
          lastSeenAt: '2026-03-22T10:00:00.000Z',
        },
        {
          id: 'location-b',
          projectId: 'project-a',
          rootPath: 'D:\\repo\\copy-b',
          repoRoot: 'D:\\repo\\copy-b',
          gitCommonDir: 'D:\\repo\\copy-b\\.git',
          remoteFingerprint: 'github.com/openai/agenclis',
          label: 'copy-b',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:00:00.000Z',
          lastSeenAt: '2026-03-22T11:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-a',
          locationId: 'location-a',
          title: 'alpha',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo\\copy-a',
          shell: 'pwsh.exe',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:30:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-a',
          locationId: 'location-b',
          title: 'beta',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'D:\\repo\\copy-b',
          shell: 'pwsh.exe',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:30:00.000Z',
        },
      ],
      activeSessionId: 'session-b',
    })

    const projectMemory = buildProjectMemoryServiceMock({
      assembleContext: vi.fn(async () => buildProjectMemoryContext('project-a', 'location-a')),
      refreshHistoricalImport: vi.fn(async () => ({
        cleanedProjectCount: 1,
        removedEmptySummaryCount: 2,
        prunedCandidateCount: 3,
        regeneratedArchitectureCount: 1,
      })),
    })

    const manager = new SessionManager(
      {
        onData: () => undefined,
        onConfig: () => undefined,
        onRuntime: () => undefined,
        onExit: () => undefined,
      },
      {
        projectMemory,
      },
    )

    const snapshot = manager.listSessions()

    expect(snapshot.projects).toHaveLength(2)

    const copyAProject = snapshot.projects.find(
      (entry) => entry.config.rootPath === 'C:\\repo\\copy-a',
    )
    const copyBProject = snapshot.projects.find(
      (entry) => entry.config.rootPath === 'D:\\repo\\copy-b',
    )

    expect(copyAProject).toMatchObject({
      config: {
        id: 'project-a',
        title: 'copy-a',
        rootPath: 'C:\\repo\\copy-a',
        primaryLocationId: 'location-a',
      },
    })
    expect(copyAProject?.locations).toEqual([
      expect.objectContaining({
        id: 'location-a',
        projectId: 'project-a',
        rootPath: 'C:\\repo\\copy-a',
      }),
    ])
    expect(copyAProject?.sessions.map((entry) => entry.config.id)).toEqual(['session-a'])
    expect(copyAProject?.sessions.map((entry) => entry.config.projectId)).toEqual([
      'project-a',
    ])

    expect(copyBProject?.config.title).toBe('copy-b')
    expect(copyBProject?.config.primaryLocationId).toBe('location-b')
    expect(copyBProject?.locations).toEqual([
      expect.objectContaining({
        id: 'location-b',
        rootPath: 'D:\\repo\\copy-b',
      }),
    ])
    expect(copyBProject?.sessions.map((entry) => entry.config.id)).toEqual(['session-b'])
    expect(copyBProject?.sessions[0]?.config.projectId).toBe(copyBProject?.config.id)

    const persistedState = mocks.getPersistedState() as {
      projects: Array<{
        id: string
        title: string
        rootPath: string
        primaryLocationId: string | null
      }>
      locations: Array<{ id: string; projectId: string; rootPath: string }>
      sessions: Array<{ id: string; projectId: string; locationId: string }>
    }

    expect(persistedState.projects).toHaveLength(2)
    expect(
      persistedState.projects.find((entry) => entry.rootPath === 'C:\\repo\\copy-a'),
    ).toMatchObject({
      id: 'project-a',
      title: 'copy-a',
      primaryLocationId: 'location-a',
    })

    const persistedCopyBProject = persistedState.projects.find(
      (entry) => entry.rootPath === 'D:\\repo\\copy-b',
    )
    expect(persistedCopyBProject).toMatchObject({
      title: 'copy-b',
      primaryLocationId: 'location-b',
    })
    expect(
      persistedState.locations.find((entry) => entry.id === 'location-b'),
    )?.toMatchObject({
      projectId: persistedCopyBProject?.id,
      rootPath: 'D:\\repo\\copy-b',
    })
    expect(
      persistedState.sessions.find((entry) => entry.id === 'session-b'),
    )?.toMatchObject({
      projectId: persistedCopyBProject?.id,
      locationId: 'location-b',
    })
  })

  it('injects project context as system input without consuming the first user prompt title', async () => {
    const transcriptEvents: TranscriptEvent[] = []
    const transcriptStore = {
      append: vi.fn(async (event: TranscriptEvent) => {
        transcriptEvents.push(event)
      }),
      readEvents: vi.fn(async () => structuredClone(transcriptEvents)),
    }
    const projectMemory = buildProjectMemoryServiceMock({
      assembleContext: vi.fn(async () => ({
        ...buildProjectMemoryContext(),
        bootstrapMessage: 'Use the project memory.\nRead:\n- memory.md',
        fileReferences: ['memory.md'],
        summaryExcerpt: 'Latest summary',
      })),
    })
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

  it('injects a deferred query-aware bootstrap after capturing the first user prompt', async () => {
    const transcriptEvents: TranscriptEvent[] = []
    const transcriptStore = {
      append: vi.fn(async (event: TranscriptEvent) => {
        transcriptEvents.push(event)
      }),
      readEvents: vi.fn(async () => structuredClone(transcriptEvents)),
    }
    let assembleCallCount = 0
    const projectMemory = buildProjectMemoryServiceMock({
      assembleContext: vi.fn(async (input: { query?: string }) => {
        assembleCallCount += 1
        return {
          ...buildProjectMemoryContext(),
          bootstrapMessage: input.query
            ? `Task-specific memory for: ${input.query}`
            : 'Use the project memory.\nRead:\n- memory.md',
          fileReferences: ['memory.md'],
          summaryExcerpt: 'Latest summary',
        }
      }),
    })
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
    expect(assembleCallCount).toBe(1)

    manager.writeToSession(session.config.id, 'fix the login bug\r')

    await vi.runOnlyPendingTimersAsync()

    expect(assembleCallCount).toBe(2)
    expect(projectMemory.assembleContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: 'fix the login bug',
      }),
    )
    expect(mocks.terminals[0]?.write).toHaveBeenCalledWith(
      'Task-specific memory for: fix the login bug\r',
    )
  })

  it('queues project memory capture when a session is closed', async () => {
    const transcriptEvents: TranscriptEvent[] = []
    const transcriptStore = {
      append: vi.fn(async (event: TranscriptEvent) => {
        transcriptEvents.push(event)
      }),
    }
    const projectMemory = buildProjectMemoryServiceMock({
      refreshHistoricalImport: vi.fn(async () => ({
        cleanedProjectCount: 1,
        removedEmptySummaryCount: 2,
        prunedCandidateCount: 3,
        regeneratedArchitectureCount: 1,
      })),
    })
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

    await manager.closeSession(session.config.id)
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

  it('does not queue project memory capture for open sessions during shutdown', async () => {
    const projectMemory = buildProjectMemoryServiceMock()
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

    await manager.createSession({
      projectTitle: 'Workspace',
      projectRootPath: 'C:\\repo',
      startupCommand: 'codex',
    })

    manager.dispose()
    await vi.waitFor(() => {
      expect(projectMemory.dispose).toHaveBeenCalledTimes(1)
    })

    expect(projectMemory.captureSession).not.toHaveBeenCalled()
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

    const projectMemory = buildProjectMemoryServiceMock()
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

  it('includes the restored active session at the end of low-priority backfill', async () => {
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
          title: 'existing session',
          startupCommand: 'beta',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-22T12:00:00.000Z',
          updatedAt: '2026-03-22T12:05:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-1',
          locationId: 'location-1',
          title: 'older session',
          startupCommand: 'alpha',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:05:00.000Z',
        },
      ],
      activeSessionId: 'session-a',
    })

    const projectMemory = buildProjectMemoryServiceMock()
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
    expect(projectMemory.scheduleBackfillSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        session: expect.objectContaining({
          id: 'session-b',
        }),
      }),
      expect.objectContaining({
        session: expect.objectContaining({
          id: 'session-a',
        }),
      }),
    ])
  })

  it('can schedule low-priority project-memory backfill for an existing active session', async () => {
    const projectMemory = buildProjectMemoryServiceMock()
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
      startupCommand: 'beta',
    })

    manager.scheduleProjectMemoryBackfill()
    await vi.runOnlyPendingTimersAsync()

    expect(projectMemory.scheduleBackfillSessions).toHaveBeenCalledTimes(1)
    expect(projectMemory.scheduleBackfillSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        session: expect.objectContaining({
          id: session.config.id,
        }),
      }),
    ])
  })

  it('analyzes stored project architecture on demand', async () => {
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
          title: 'existing session',
          startupCommand: 'beta',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-22T12:00:00.000Z',
          updatedAt: '2026-03-22T12:05:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-1',
          locationId: 'location-1',
          title: 'older session',
          startupCommand: 'alpha',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo',
          shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:05:00.000Z',
        },
      ],
      activeSessionId: 'session-a',
    })

    const projectMemory = buildProjectMemoryServiceMock({
      analyzeHistoricalArchitecture: vi.fn(async () => ({
        analyzedProjectCount: 1,
      })),
    })
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

    await expect(manager.analyzeHistoricalProjectArchitecture()).resolves.toEqual({
      analyzedProjectCount: 1,
    })
    expect(identityResolver.inspect).toHaveBeenCalledTimes(1)
    expect(projectMemory.analyzeHistoricalArchitecture).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'project-1',
      }),
    ])
    expect(projectMemory.refreshHistoricalImport).not.toHaveBeenCalled()
    expect(projectMemory.scheduleBackfillSessions).not.toHaveBeenCalled()
  })

  it('refreshes repo identity before stored sessions analysis without collapsing clone projects', async () => {
    mocks.setPersistedState({
      projects: [
        {
          id: 'project-a',
          title: 'copy-a',
          rootPath: 'C:\\repo\\copy-a',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:00:00.000Z',
          primaryLocationId: 'location-a',
          identity: {
            repoRoot: null,
            gitCommonDir: null,
            remoteFingerprint: null,
          },
        },
        {
          id: 'project-b',
          title: 'copy-b',
          rootPath: 'D:\\repo\\copy-b',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:00:00.000Z',
          primaryLocationId: 'location-b',
          identity: {
            repoRoot: null,
            gitCommonDir: null,
            remoteFingerprint: null,
          },
        },
      ],
      locations: [
        {
          id: 'location-a',
          projectId: 'project-a',
          rootPath: 'C:\\repo\\copy-a',
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: null,
          label: 'copy-a',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:00:00.000Z',
          lastSeenAt: '2026-03-22T10:00:00.000Z',
        },
        {
          id: 'location-b',
          projectId: 'project-b',
          rootPath: 'D:\\repo\\copy-b',
          repoRoot: null,
          gitCommonDir: null,
          remoteFingerprint: null,
          label: 'copy-b',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:00:00.000Z',
          lastSeenAt: '2026-03-22T11:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session-a',
          projectId: 'project-a',
          locationId: 'location-a',
          title: 'alpha',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'C:\\repo\\copy-a',
          shell: 'pwsh.exe',
          createdAt: '2026-03-22T10:00:00.000Z',
          updatedAt: '2026-03-22T10:30:00.000Z',
        },
        {
          id: 'session-b',
          projectId: 'project-b',
          locationId: 'location-b',
          title: 'beta',
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'D:\\repo\\copy-b',
          shell: 'pwsh.exe',
          createdAt: '2026-03-22T11:00:00.000Z',
          updatedAt: '2026-03-22T11:30:00.000Z',
        },
      ],
      activeSessionId: 'session-b',
    })

    const projectMemory = buildProjectMemoryServiceMock({
      assembleContext: vi.fn(async () => buildProjectMemoryContext('project-a', 'location-a')),
      refreshHistoricalImport: vi.fn(async () => ({
        cleanedProjectCount: 2,
        removedEmptySummaryCount: 0,
        prunedCandidateCount: 0,
        regeneratedArchitectureCount: 2,
      })),
      analyzeHistoricalSessions: vi.fn(async () => ({
        analyzedProjectCount: 2,
        analyzedSessionCount: 2,
        skippedSessionCount: 0,
      })),
    })
    const identityResolver = {
      inspect: vi.fn(async (rootPath: string): Promise<ProjectLocationIdentity> => ({
        rootPath,
        label: path.basename(rootPath),
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

    await expect(manager.analyzeHistoricalProjectSessions()).resolves.toEqual({
      analyzedProjectCount: 2,
      analyzedSessionCount: 2,
      skippedSessionCount: 0,
      cleanedProjectCount: 2,
      removedEmptySummaryCount: 0,
      prunedCandidateCount: 0,
    })

    expect(identityResolver.inspect).toHaveBeenCalledTimes(2)
    expect(projectMemory.refreshHistoricalImport).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'project-a',
      }),
      expect.objectContaining({
        id: 'project-b',
      }),
    ], {
      regenerateArchitecture: false,
    })
    expect(projectMemory.analyzeHistoricalSessions).toHaveBeenCalledWith([
      expect.objectContaining({
        project: expect.objectContaining({
          id: 'project-a',
        }),
        session: expect.objectContaining({
          id: 'session-a',
          projectId: 'project-a',
        }),
      }),
      expect.objectContaining({
        project: expect.objectContaining({
          id: 'project-b',
        }),
        session: expect.objectContaining({
          id: 'session-b',
          projectId: 'project-b',
        }),
      }),
    ])
    expect(projectMemory.scheduleBackfillSessions).not.toHaveBeenCalled()
  })
})
