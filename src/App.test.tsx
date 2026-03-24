import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./components/TerminalWorkspace', () => ({
  TerminalWorkspace: () => <div data-testid="terminal-workspace" />,
}))

import App from './App'
import type { ProjectGitOverview } from './shared/projectTools'
import type { ListSessionsResponse, SessionExitMeta } from './shared/session'
import type {
  SkillAiMergeProposal,
  SkillLibrarySettings,
  SkillSyncResult,
  SkillSyncStatus,
} from './shared/skills'
import { useSessionsStore } from './store/useSessionsStore'

function buildSkillSettings(): SkillLibrarySettings {
  return {
    libraryRoot: '',
    primaryMergeAgent: 'codex',
    reviewMergeAgent: 'none',
  }
}

function buildSkillStatus(): SkillSyncStatus {
  return {
    issues: [
      {
        severity: 'error',
        code: 'missing-library-root',
        message: 'Library root is not configured.',
        root: 'library',
      },
    ],
    conflicts: [],
    roots: [
      {
        root: 'library',
        label: 'Library',
        configured: false,
        rootPath: '',
        skillNames: [],
      },
      {
        root: 'discovered',
        label: 'Discovered folders',
        configured: true,
        rootPath: 'C:\\Users\\hduan10',
        skillNames: [],
        folderCount: 2,
        message: 'Automatically scanned 2 folders under C:\\Users\\hduan10.',
      },
    ],
    lastSyncResult: null,
  }
}

function buildWorkspacePayload(): ListSessionsResponse {
  return {
    projects: [],
    activeSessionId: null,
  }
}

function buildProjectGitOverview(): ProjectGitOverview {
  return {
    projectPath: 'C:\\repo\\agenclis',
    isGitRepository: true,
    repoRoot: 'C:\\repo\\agenclis',
    branch: 'feature/topbar-actions',
    stagedFiles: [],
    unstagedFiles: [
      {
        path: 'src/App.tsx',
        status: 'modified',
        additions: 23,
        deletions: 7,
        staged: false,
      },
    ],
    stagedTotals: {
      additions: 0,
      deletions: 0,
    },
    unstagedTotals: {
      additions: 23,
      deletions: 7,
    },
  }
}

function mockElementRect(
  element: Element,
  rect: {
    left: number
    top?: number
    width: number
    height?: number
  },
): void {
  const top = rect.top ?? 0
  const height = rect.height ?? 0
  const right = rect.left + rect.width
  const bottom = top + height

  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.left,
      y: top,
      left: rect.left,
      top,
      width: rect.width,
      height,
      right,
      bottom,
      toJSON: () => '',
    }),
  })
}
function createAgentCliMock(
  workspacePayload: ListSessionsResponse = buildWorkspacePayload(),
  gitOverview: ProjectGitOverview = buildProjectGitOverview(),
) {
  let currentSkillSettings = buildSkillSettings()
  let currentSkillStatus = buildSkillStatus()

  const syncResult: SkillSyncResult = {
    startedAt: '2026-03-12T18:00:00.000Z',
    completedAt: '2026-03-12T18:00:02.000Z',
    success: true,
    issues: [],
    conflicts: [],
    synchronizedSkills: ['document-topic-search'],
    roots: [
      {
        root: 'library',
        label: 'Library',
        rootPath: 'C:\\repo\\agentclis-skills',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
      },
      {
        root: 'discovered',
        label: 'Discovered folders',
        rootPath: 'C:\\Users\\hduan10',
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        folderCount: 2,
        message: 'Automatically scanned 2 folders under C:\\Users\\hduan10.',
      },
    ],
  }

  const resolveResult: SkillSyncResult = {
    startedAt: '2026-03-12T18:10:00.000Z',
    completedAt: '2026-03-12T18:10:02.000Z',
    success: true,
    issues: [],
    conflicts: [],
    synchronizedSkills: ['document-topic-search'],
    roots: [
      {
        root: 'library',
        label: 'Library',
        rootPath: 'C:\\repo\\agentclis-skills',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
      },
      {
        root: 'discovered',
        label: 'Discovered folders',
        rootPath: 'C:\\Users\\hduan10',
        synchronizedSkills: [],
        changedSkills: [],
        changed: false,
        skipped: true,
        folderCount: 2,
        message: 'Automatically scanned 2 folders under C:\\Users\\hduan10.',
      },
    ],
  }

  const mergeProposal: SkillAiMergeProposal = {
    skillName: 'document-topic-search',
    mergeAgent: 'codex',
    generatedAt: '2026-03-12T18:05:00.000Z',
    summary: 'Merged the stronger instructions and combined non-overlapping helper files.',
    rationale:
      'Kept the clearer SKILL.md structure, retained both useful helper scripts, and removed duplicate wording.',
    warnings: ['Review the merged notes.txt wording before final apply.'],
    sourceRoots: ['library', 'discovered'],
    files: [
      {
        path: 'SKILL.md',
        content: '# merged skill\n',
      },
      {
        path: 'notes.txt',
        content: 'merged notes\n',
      },
    ],
    review: {
      reviewer: 'claude',
      reviewedAt: '2026-03-12T18:06:00.000Z',
      status: 'approved-with-warnings',
      summary: 'The merge looks sound.',
      rationale: 'The combined skill preserves the stronger instructions.',
      warnings: ['The merged notes remain slightly verbose.'],
    },
  }

  const agentCli = {
    restoreSessions: vi.fn().mockResolvedValue(workspacePayload),
    listSessions: vi.fn().mockResolvedValue(workspacePayload),
    createProject: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    activateSession: vi.fn().mockResolvedValue(undefined),
    restartSession: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    writeToSession: vi.fn().mockResolvedValue(undefined),
    resizeSession: vi.fn().mockResolvedValue(undefined),
    getSkillLibrarySettings: vi
      .fn()
      .mockImplementation(async () => structuredClone(currentSkillSettings)),
    updateSkillLibrarySettings: vi.fn().mockImplementation(async (settings) => {
      currentSkillSettings = structuredClone(settings)
      currentSkillStatus = {
        issues: currentSkillSettings.libraryRoot
          ? []
          : [
              {
                severity: 'error',
                code: 'missing-library-root',
                message: 'Library root is not configured.',
                root: 'library',
              },
            ],
        conflicts: currentSkillSettings.libraryRoot
          ? [
              {
                skillName: 'document-topic-search',
                recommendedRoot: 'discovered',
                recommendedRootLabel: 'C:\\Users\\hduan10\\.codex\\skills',
                differingFiles: ['SKILL.md'],
                roots: [
                  {
                    root: 'library',
                    label: 'Library',
                    rootPath: currentSkillSettings.libraryRoot,
                    modifiedAt: '2026-03-12T18:00:00.000Z',
                    fileCount: 1,
                  },
                  {
                    root: 'discovered',
                    label: 'C:\\Users\\hduan10\\.codex\\skills',
                    rootPath: 'C:\\Users\\hduan10',
                    modifiedAt: '2026-03-12T17:59:00.000Z',
                    fileCount: 1,
                  },
                ],
              },
            ]
          : [],
        roots: [
          {
            root: 'library',
            label: 'Library',
            configured: Boolean(currentSkillSettings.libraryRoot),
            rootPath: currentSkillSettings.libraryRoot,
            skillNames: currentSkillSettings.libraryRoot
              ? ['document-topic-search']
              : [],
          },
          {
            root: 'discovered',
            label: 'Discovered folders',
            configured: true,
            rootPath: 'C:\\Users\\hduan10',
            skillNames: currentSkillSettings.libraryRoot
              ? ['document-topic-search']
              : [],
            folderCount: 2,
            message: 'Automatically scanned 2 folders under C:\\Users\\hduan10.',
          },
        ],
        lastSyncResult: currentSkillStatus.lastSyncResult,
      }

      return structuredClone(currentSkillSettings)
    }),
    getSkillSyncStatus: vi
      .fn()
      .mockImplementation(async () => structuredClone(currentSkillStatus)),
    importHistoricalProjectMemory: vi.fn().mockResolvedValue({
      queuedSessionCount: 2,
      cleanedProjectCount: 1,
      removedEmptySummaryCount: 2,
      prunedCandidateCount: 3,
      regeneratedArchitectureCount: 1,
    }),
    syncSkills: vi.fn().mockImplementation(async () => {
      currentSkillStatus = {
        ...currentSkillStatus,
        conflicts: [],
        lastSyncResult: syncResult,
      }

      return syncResult
    }),
    resolveSkillConflict: vi.fn().mockImplementation(async () => {
      currentSkillStatus = {
        ...currentSkillStatus,
        conflicts: [],
        lastSyncResult: resolveResult,
      }

      return resolveResult
    }),
    generateSkillAiMerge: vi.fn().mockResolvedValue(mergeProposal),
    applySkillAiMerge: vi.fn().mockImplementation(async () => {
      currentSkillStatus = {
        ...currentSkillStatus,
        conflicts: [],
        lastSyncResult: resolveResult,
      }

      return resolveResult
    }),
    pickDirectory: vi
      .fn()
      .mockResolvedValueOnce('C:\\repo\\agentclis-skills'),
    openPath: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn().mockResolvedValue(undefined),
    getProjectGitOverview: vi.fn().mockResolvedValue(gitOverview),
    getProjectGitDiff: vi.fn().mockResolvedValue({
      filePath: 'src/App.tsx',
      staged: false,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n+new line\n-old line',
    }),
    openFileReference: vi.fn().mockResolvedValue(undefined),
    openExternalLink: vi.fn().mockResolvedValue(undefined),
    getPathForFile: vi.fn((file: File) => file.name),
    listWindowsCommandPrompts: vi.fn().mockResolvedValue([]),
    openWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    closeWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    writeToWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    resizeWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    onSessionData: vi.fn(() => vi.fn()),
    onSessionConfig: vi.fn(() => vi.fn()),
    onSessionRuntime: vi.fn(() => vi.fn()),
    onSessionExit: vi.fn<(listener: (event: SessionExitMeta) => void) => () => void>(
      () => vi.fn(),
    ),
    onWindowsCommandPromptData: vi.fn(() => vi.fn()),
    onWindowsCommandPromptExit: vi.fn(() => vi.fn()),
    openSkillSyncWindow: vi.fn().mockResolvedValue(undefined),
    startFullSync: vi.fn().mockResolvedValue({
      running: true,
      progress: null,
      result: null,
    }),
    getFullSyncState: vi.fn().mockResolvedValue({
      running: false,
      progress: null,
      result: null,
    }),
    onFullSyncProgress: vi.fn(() => vi.fn()),
    onFullSyncDone: vi.fn(() => vi.fn()),
    persistTransientFile: vi.fn().mockResolvedValue('C:\\temp\\clipboard.png'),
  }

  return {
    agentCli,
    mergeProposal,
  }
}

describe('App skills settings', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    useSessionsStore.setState({
      projects: [],
      activeSessionId: null,
      hydrated: false,
    })
  })

  it('reflects session attention in the document title', async () => {
    const { agentCli } = createAgentCliMock({
      projects: [
        {
          config: {
            id: 'project-1',
            title: 'agenclis',
            rootPath: 'C:\\repo\\agenclis',
            createdAt: '2026-03-12T18:00:00.000Z',
            updatedAt: '2026-03-12T18:00:00.000Z',
          },
          sessions: [
            {
              config: {
                id: 'session-1',
                projectId: 'project-1',
                title: 'Codex',
                startupCommand: 'codex',
                pendingFirstPromptTitle: false,
                cwd: 'C:\\repo\\agenclis',
                shell: 'pwsh.exe',
                createdAt: '2026-03-12T18:00:00.000Z',
                updatedAt: '2026-03-12T18:00:00.000Z',
              },
              runtime: {
                sessionId: 'session-1',
                status: 'running',
                attention: 'needs-user-decision',
                lastActiveAt: '2026-03-12T18:00:05.000Z',
              },
            },
          ],
        },
      ],
      activeSessionId: 'session-1',
    })

    window.agentCli = agentCli

    render(<App />)

    await waitFor(() => {
      expect(document.title).toBe('Reply needed: Codex - Agent CLIs')
    })
  })

  it('loads root settings, lets the user choose paths, and triggers sync', async () => {
    const user = userEvent.setup()
    const { agentCli } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText('Library root is not configured.')).toBeInTheDocument()
    expect(screen.queryByText('Validation')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Choose' }))

    await waitFor(() => {
      expect(screen.getByText('C:\\repo\\agentclis-skills')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Primary agent' }))
    await user.click(screen.getByRole('option', { name: 'Claude' }))
    await user.click(screen.getByRole('button', { name: 'Secondary agent' }))
    await user.click(screen.getByRole('option', { name: 'Copilot' }))

    await user.click(screen.getByRole('button', { name: 'Sync now' }))

    await waitFor(() => {
      expect(agentCli.openSkillSyncWindow).toHaveBeenCalledWith(true)
    })

    expect(screen.queryByText('Last sync')).not.toBeInTheDocument()
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument()

    expect(agentCli.updateSkillLibrarySettings).toHaveBeenCalled()
    const lastSettingsCall =
      agentCli.updateSkillLibrarySettings.mock.calls.at(-1)?.[0] as
        | SkillLibrarySettings
        | undefined
    expect(lastSettingsCall?.primaryMergeAgent).toBe('claude')
    expect(lastSettingsCall?.reviewMergeAgent).toBe('copilot')
  })

  it('shows skill conflicts and lets the user resolve one from the settings panel', async () => {
    const user = userEvent.setup()
    const { agentCli } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    await user.click(screen.getByRole('button', { name: 'Choose' }))

    await waitFor(() => {
      expect(screen.getByText('Conflicts')).toBeInTheDocument()
    })

    await user.click(
      screen.getByRole('button', { name: 'Use C:\\Users\\hduan10\\.codex\\skills' }),
    )

    await waitFor(() => {
      expect(screen.queryByText('Conflicts')).not.toBeInTheDocument()
    })

    expect(agentCli.resolveSkillConflict).toHaveBeenCalledWith(
      'document-topic-search',
      'discovered',
    )
  })

  it('queues a dedicated historical project-memory import from the settings panel', async () => {
    const user = userEvent.setup()
    const { agentCli } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Choose' }))

    await waitFor(() => {
      expect(screen.getByText('C:\\repo\\agentclis-skills')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Import history' }))

    await waitFor(() => {
      expect(agentCli.importHistoricalProjectMemory).toHaveBeenCalledTimes(1)
    })

    expect(
      screen.getByText(
        'Refreshed 1 project memory snapshot, removed 2 empty summaries, pruned 3 stale memory entries, regenerated architecture for 1 project, queued 2 sessions for background import.',
      ),
    ).toBeInTheDocument()
  })

  it('generates an AI merge preview and applies it from the settings panel', async () => {
    const user = userEvent.setup()
    const { agentCli, mergeProposal } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    await user.click(screen.getByRole('button', { name: 'Choose' }))

    await waitFor(() => {
      expect(screen.getByText('Conflicts')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'AI Merge' }))

    await waitFor(() => {
      expect(screen.getByText('AI Merge Preview')).toBeInTheDocument()
      expect(screen.getByText(/Merged the stronger instructions/i)).toBeInTheDocument()
      expect(screen.getByText('notes.txt')).toBeInTheDocument()
      expect(screen.getByText('Approved with warnings by Claude')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Apply Merge' }))

    await waitFor(() => {
      expect(screen.queryByText('Conflicts')).not.toBeInTheDocument()
    })

    expect(agentCli.generateSkillAiMerge).toHaveBeenCalledWith('document-topic-search')
    expect(agentCli.applySkillAiMerge).toHaveBeenCalledWith(mergeProposal)
  })

  it('opens projects from the top bar and toggles cmd and diff controls', async () => {
    const user = userEvent.setup()
    const workspacePayload: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'project-1',
            title: 'agenclis',
            rootPath: 'C:\\repo\\agenclis',
            createdAt: '2026-03-13T16:00:00.000Z',
            updatedAt: '2026-03-13T16:00:00.000Z',
          },
          sessions: [
            {
              config: {
                id: 'session-1',
                projectId: 'project-1',
                title: 'Codex',
                startupCommand: 'codex',
                pendingFirstPromptTitle: false,
                cwd: 'C:\\Users\\hduan10\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
                shell: 'powershell.exe',
                createdAt: '2026-03-13T16:00:00.000Z',
                updatedAt: '2026-03-13T16:00:00.000Z',
              },
              runtime: {
                sessionId: 'session-1',
                status: 'running',
                lastActiveAt: '2026-03-13T16:00:00.000Z',
              },
            },
          ],
        },
      ],
      activeSessionId: 'session-1',
    }

    const { agentCli } = createAgentCliMock(workspacePayload)

    window.agentCli = agentCli

    render(<App />)

    await screen.findByRole('button', { name: 'Open project' })

    await user.click(screen.getByRole('button', { name: 'Open project' }))
    await user.click(screen.getByRole('menuitem', { name: /VS Code/i }))

    expect(agentCli.openProject).toHaveBeenCalledWith(
      'vscode',
      'C:\\Users\\hduan10\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
    )

    await user.click(screen.getByRole('button', { name: 'Toggle cmd' }))

    expect(agentCli.openWindowsCommandPrompt).toHaveBeenCalledWith(
      'session-1',
      'C:\\Users\\hduan10\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
    )

    await user.click(screen.getByRole('button', { name: 'Toggle diff panel' }))

    await waitFor(() => {
      expect(screen.getByText('Changes')).toBeInTheDocument()
      expect(screen.getAllByText('src/App.tsx')).toHaveLength(2)
      expect(screen.queryByText('Unstaged')).not.toBeInTheDocument()
      expect(screen.queryByText('Staged')).not.toBeInTheDocument()
      expect(screen.getByText('Patch preview')).toBeInTheDocument()
      expect(screen.getByText(/diff --git a\/src\/App.tsx/i)).toBeInTheDocument()
    })

    expect(agentCli.getProjectGitOverview).toHaveBeenCalledWith(
      'C:\\Users\\hduan10\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
    )
    expect(agentCli.getProjectGitDiff).toHaveBeenCalledWith(
      'C:\\Users\\hduan10\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
      'src/App.tsx',
      false,
    )
  })

  it('hides the cmd pane immediately while the close request is still pending', async () => {
    const user = userEvent.setup()
    const workspacePayload: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'project-1',
            title: 'agenclis',
            rootPath: 'C:\\repo\\agenclis',
            createdAt: '2026-03-13T16:00:00.000Z',
            updatedAt: '2026-03-13T16:00:00.000Z',
          },
          sessions: [
            {
              config: {
                id: 'session-1',
                projectId: 'project-1',
                title: 'Codex',
                startupCommand: 'codex',
                pendingFirstPromptTitle: false,
                cwd: 'C:\\repo\\agenclis',
                shell: 'powershell.exe',
                createdAt: '2026-03-13T16:00:00.000Z',
                updatedAt: '2026-03-13T16:00:00.000Z',
              },
              runtime: {
                sessionId: 'session-1',
                status: 'running',
                lastActiveAt: '2026-03-13T16:00:00.000Z',
              },
            },
          ],
        },
      ],
      activeSessionId: 'session-1',
    }

    const { agentCli } = createAgentCliMock(workspacePayload)
    let resolveClose: (() => void) | null = null

    agentCli.listWindowsCommandPrompts.mockResolvedValue(['session-1'])
    agentCli.closeWindowsCommandPrompt.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        }),
    )

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Console on')

    await user.click(screen.getByRole('button', { name: 'Toggle cmd' }))

    expect(agentCli.closeWindowsCommandPrompt).toHaveBeenCalledWith('session-1')

    await waitFor(() => {
      expect(screen.getByText('Console')).toBeInTheDocument()
      expect(screen.queryByText('Console on')).not.toBeInTheDocument()
    })

    await act(async () => {
      resolveClose?.()
    })
  })

  it('closes a session immediately when the agent CLI exits on its own', async () => {
    let exitListener: ((event: { sessionId: string; exitCode: number }) => void) | null = null
    let workspacePayload: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'project-1',
            title: 'agenclis',
            rootPath: 'C:\\repo\\agenclis',
            createdAt: '2026-03-13T16:00:00.000Z',
            updatedAt: '2026-03-13T16:00:00.000Z',
          },
          sessions: [
            {
              config: {
                id: 'session-1',
                projectId: 'project-1',
                title: 'Copilot',
                startupCommand: 'copilot',
                pendingFirstPromptTitle: false,
                cwd: 'C:\\repo\\agenclis',
                shell: 'powershell.exe',
                createdAt: '2026-03-13T16:00:00.000Z',
                updatedAt: '2026-03-13T16:00:00.000Z',
              },
              runtime: {
                sessionId: 'session-1',
                status: 'running',
                lastActiveAt: '2026-03-13T16:00:00.000Z',
              },
            },
          ],
        },
      ],
      activeSessionId: 'session-1',
    }

    const { agentCli } = createAgentCliMock(workspacePayload)
    agentCli.listSessions.mockImplementation(async () => structuredClone(workspacePayload))
    agentCli.restoreSessions.mockImplementation(async () => structuredClone(workspacePayload))
    agentCli.onSessionExit.mockImplementation((listener) => {
      exitListener = listener
      return vi.fn()
    })
    agentCli.closeSession.mockImplementation(async (sessionId: string) => {
      workspacePayload = {
        projects: workspacePayload.projects.map((project) => ({
          ...project,
          sessions: project.sessions.filter((session) => session.config.id !== sessionId),
        })),
        activeSessionId: null,
      }

      return {
        closedSessionId: sessionId,
        activeSessionId: null,
      }
    })

    window.agentCli = agentCli

    render(<App />)

    await screen.findByRole('button', { name: 'Toggle cmd' })

    expect(exitListener).not.toBeNull()

    await act(async () => {
      exitListener?.({ sessionId: 'session-1', exitCode: 0 })
    })

    await waitFor(() => {
      expect(agentCli.closeSession).toHaveBeenCalledWith('session-1')
      expect(screen.getByText('Ready to build locally')).toBeInTheDocument()
      expect(useSessionsStore.getState().activeSessionId).toBeNull()
      expect(useSessionsStore.getState().projects[0]?.sessions).toHaveLength(0)
    })
  })

  it('lets the user drag the sidebar and diff splitters to resize panes', async () => {
    const user = userEvent.setup()
    const workspacePayload: ListSessionsResponse = {
      projects: [
        {
          config: {
            id: 'project-1',
            title: 'agenclis',
            rootPath: 'C:\\repo\\agenclis',
            createdAt: '2026-03-13T16:00:00.000Z',
            updatedAt: '2026-03-13T16:00:00.000Z',
          },
          sessions: [
            {
              config: {
                id: 'session-1',
                projectId: 'project-1',
                title: 'Codex',
                startupCommand: 'codex',
                pendingFirstPromptTitle: false,
                cwd: 'C:\\repo\\agenclis',
                shell: 'powershell.exe',
                createdAt: '2026-03-13T16:00:00.000Z',
                updatedAt: '2026-03-13T16:00:00.000Z',
              },
              runtime: {
                sessionId: 'session-1',
                status: 'running',
                lastActiveAt: '2026-03-13T16:00:00.000Z',
              },
            },
          ],
        },
      ],
      activeSessionId: 'session-1',
    }

    const { agentCli } = createAgentCliMock(workspacePayload)

    window.agentCli = agentCli

    render(<App />)

    await screen.findByRole('button', { name: 'Resize sidebar' })

    const appShell = document.querySelector('.app-shell') as HTMLDivElement | null
    const workspaceBody = document.querySelector(
      '.workspace-shell__body',
    ) as HTMLElement | null

    expect(appShell).not.toBeNull()
    expect(workspaceBody).not.toBeNull()

    mockElementRect(appShell!, { left: 0, width: 1400, height: 900 })
    mockElementRect(workspaceBody!, { left: 0, width: 1080, height: 900 })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize sidebar' }), {
      clientX: 288,
    })
    fireEvent.pointerMove(window, { clientX: 360 })
    fireEvent.pointerUp(window)

    await waitFor(() => {
      expect(appShell!.style.getPropertyValue('--sidebar-width')).toBe('360px')
    })

    await user.click(screen.getByRole('button', { name: 'Toggle diff panel' }))

    await waitFor(() => {
      expect(screen.getByText('Changes')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Resize diff panel' })).toBeInTheDocument()
    })

    mockElementRect(workspaceBody!, { left: 0, width: 1040, height: 900 })

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize diff panel' }), {
      clientX: 620,
    })
    fireEvent.pointerMove(window, { clientX: 560 })
    fireEvent.pointerUp(window)

    await waitFor(() => {
      expect(workspaceBody!.style.getPropertyValue('--diff-panel-width')).toBe(
        '480px',
      )
    })
  })
})
