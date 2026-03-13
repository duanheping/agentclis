import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
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

function createAgentCliMock() {
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
    restoreSessions: vi.fn().mockResolvedValue({
      projects: [],
      activeSessionId: null,
    }),
    listSessions: vi.fn().mockResolvedValue({
      projects: [],
      activeSessionId: null,
    }),
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
})
