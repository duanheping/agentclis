import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./components/TerminalWorkspace', () => ({
  TerminalWorkspace: () => <div data-testid="terminal-workspace" />,
}))

import App from './App'
import type { ProjectGitOverview } from './shared/projectTools'
import type { ListSessionsResponse } from './shared/session'
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
    providers: {
      codex: {
        targetRoot: 'C:\\Users\\hduan10\\.codex\\skills',
      },
      claude: {
        targetRoot: 'C:\\Users\\hduan10\\.claude\\skills',
      },
    },
    autoSyncOnAppStart: false,
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
        configured: false,
        rootPath: '',
        skillNames: [],
      },
      {
        root: 'codex',
        configured: true,
        rootPath: 'C:\\Users\\hduan10\\.codex\\skills',
        skillNames: [],
      },
      {
        root: 'claude',
        configured: true,
        rootPath: 'C:\\Users\\hduan10\\.claude\\skills',
        skillNames: [],
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
        rootPath: 'C:\\repo\\agentclis-skills',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
      },
      {
        root: 'codex',
        rootPath: 'C:\\skills\\codex',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
      },
      {
        root: 'claude',
        rootPath: 'C:\\skills\\claude',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
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
        rootPath: 'C:\\repo\\agentclis-skills',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
      },
      {
        root: 'codex',
        rootPath: 'C:\\skills\\codex',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
      },
      {
        root: 'claude',
        rootPath: 'C:\\skills\\claude',
        synchronizedSkills: ['document-topic-search'],
        changedSkills: ['document-topic-search'],
        changed: true,
        skipped: false,
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
    sourceRoots: ['codex', 'claude'],
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
                recommendedRoot: 'codex',
                differingFiles: ['SKILL.md'],
                roots: [
                  {
                    root: 'codex',
                    rootPath: currentSkillSettings.providers.codex.targetRoot,
                    modifiedAt: '2026-03-12T18:00:00.000Z',
                    fileCount: 1,
                  },
                  {
                    root: 'claude',
                    rootPath: currentSkillSettings.providers.claude.targetRoot,
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
            configured: Boolean(currentSkillSettings.libraryRoot),
            rootPath: currentSkillSettings.libraryRoot,
            skillNames: currentSkillSettings.libraryRoot
              ? ['document-topic-search']
              : [],
          },
          {
            root: 'codex',
            configured: Boolean(currentSkillSettings.providers.codex.targetRoot),
            rootPath: currentSkillSettings.providers.codex.targetRoot,
            skillNames: currentSkillSettings.libraryRoot
              ? ['document-topic-search']
              : [],
          },
          {
            root: 'claude',
            configured: Boolean(currentSkillSettings.providers.claude.targetRoot),
            rootPath: currentSkillSettings.providers.claude.targetRoot,
            skillNames: currentSkillSettings.libraryRoot
              ? ['document-topic-search']
              : [],
          },
        ],
        lastSyncResult: currentSkillStatus.lastSyncResult,
      }

      return structuredClone(currentSkillSettings)
    }),
    getSkillSyncStatus: vi
      .fn()
      .mockImplementation(async () => structuredClone(currentSkillStatus)),
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
      .mockResolvedValueOnce('C:\\repo\\agentclis-skills')
      .mockResolvedValueOnce('C:\\skills\\codex')
      .mockResolvedValueOnce('C:\\skills\\claude'),
    openPath: vi.fn().mockResolvedValue(undefined),
    openProject: vi.fn().mockResolvedValue(undefined),
    getProjectGitOverview: vi.fn().mockResolvedValue(gitOverview),
    getProjectGitDiff: vi.fn().mockResolvedValue({
      filePath: 'src/App.tsx',
      staged: false,
      patch: 'diff --git a/src/App.tsx b/src/App.tsx\n+new line\n-old line',
    }),
    openFileReference: vi.fn().mockResolvedValue(undefined),
    getPathForFile: vi.fn((file: File) => file.name),
    listWindowsCommandPrompts: vi.fn().mockResolvedValue([]),
    openWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    closeWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    writeToWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    resizeWindowsCommandPrompt: vi.fn().mockResolvedValue(undefined),
    onSessionData: vi.fn(() => vi.fn()),
    onSessionConfig: vi.fn(() => vi.fn()),
    onSessionRuntime: vi.fn(() => vi.fn()),
    onSessionExit: vi.fn(() => vi.fn()),
    onWindowsCommandPromptData: vi.fn(() => vi.fn()),
    onWindowsCommandPromptExit: vi.fn(() => vi.fn()),
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

  it('loads root settings, lets the user choose paths, and triggers sync', async () => {
    const user = userEvent.setup()
    const { agentCli } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(
      screen.getByText('Library: Library root is not configured.'),
    ).toBeInTheDocument()

    const chooseButtons = screen.getAllByRole('button', { name: 'Choose' })
    await user.click(chooseButtons[0]!)
    await user.click(chooseButtons[1]!)
    await user.click(chooseButtons[2]!)

    await waitFor(() => {
      expect(screen.getByText('C:\\repo\\agentclis-skills')).toBeInTheDocument()
    })

    await user.selectOptions(
      screen.getByLabelText('Primary merge agent'),
      'claude',
    )
    await user.selectOptions(screen.getByLabelText('Review agent'), 'codex')

    await user.click(screen.getByRole('button', { name: 'Sync now' }))

    await waitFor(() => {
      expect(screen.getByText('Last sync')).toBeInTheDocument()
      expect(screen.getByText('Succeeded')).toBeInTheDocument()
    })

    expect(agentCli.updateSkillLibrarySettings).toHaveBeenCalled()
    expect(agentCli.syncSkills).toHaveBeenCalledTimes(1)
    const lastSettingsCall =
      agentCli.updateSkillLibrarySettings.mock.calls.at(-1)?.[0] as
        | SkillLibrarySettings
        | undefined
    expect(lastSettingsCall?.primaryMergeAgent).toBe('claude')
    expect(lastSettingsCall?.reviewMergeAgent).toBe('codex')
  })

  it('shows skill conflicts and lets the user resolve one from the settings panel', async () => {
    const user = userEvent.setup()
    const { agentCli } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    const chooseButtons = screen.getAllByRole('button', { name: 'Choose' })
    await user.click(chooseButtons[0]!)

    await waitFor(() => {
      expect(screen.getByText('Conflicts')).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Use Codex' }))

    await waitFor(() => {
      expect(screen.queryByText('Conflicts')).not.toBeInTheDocument()
    })

    expect(agentCli.resolveSkillConflict).toHaveBeenCalledWith(
      'document-topic-search',
      'codex',
    )
  })

  it('generates an AI merge preview and applies it from the settings panel', async () => {
    const user = userEvent.setup()
    const { agentCli, mergeProposal } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')
    await user.click(screen.getByRole('button', { name: 'Settings' }))

    const chooseButtons = screen.getAllByRole('button', { name: 'Choose' })
    await user.click(chooseButtons[0]!)

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

    await screen.findByRole('button', { name: 'Open project' })

    await user.click(screen.getByRole('button', { name: 'Open project' }))
    await user.click(screen.getByRole('menuitem', { name: /VS Code/i }))

    expect(agentCli.openProject).toHaveBeenCalledWith('vscode', 'C:\\repo\\agenclis')

    await user.click(screen.getByRole('button', { name: 'Toggle cmd' }))

    expect(agentCli.openWindowsCommandPrompt).toHaveBeenCalledWith(
      'session-1',
      'C:\\repo\\agenclis',
    )

    await user.click(screen.getByRole('button', { name: 'Toggle diff panel' }))

    await waitFor(() => {
      expect(screen.getByText('Changes')).toBeInTheDocument()
      expect(screen.getAllByText('src/App.tsx')).toHaveLength(2)
      expect(screen.getByText(/diff --git a\/src\/App.tsx/i)).toBeInTheDocument()
    })

    expect(agentCli.getProjectGitOverview).toHaveBeenCalledWith('C:\\repo\\agenclis')
    expect(agentCli.getProjectGitDiff).toHaveBeenCalledWith(
      'C:\\repo\\agenclis',
      'src/App.tsx',
      false,
    )
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
