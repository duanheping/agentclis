import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import type {
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
  }
}

function buildSkillStatus(): SkillSyncStatus {
  return {
    discoveredSkills: [],
    issues: [
      {
        severity: 'error',
        code: 'missing-library-root',
        message: 'Library root is not configured.',
      },
    ],
    providers: [
      {
        provider: 'codex',
        configured: true,
        plannedExports: [],
      },
      {
        provider: 'claude',
        configured: true,
        plannedExports: [],
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
    providers: [
      {
        provider: 'codex',
        targetRoot: 'C:\\skills\\codex',
        syncedExports: ['document-topic-search'],
        removedExports: [],
        changed: true,
        skipped: false,
      },
      {
        provider: 'claude',
        targetRoot: 'C:\\skills\\claude',
        syncedExports: ['pdf-topic-search'],
        removedExports: [],
        changed: true,
        skipped: false,
      },
    ],
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
        discoveredSkills: currentSkillSettings.libraryRoot
          ? ['document-topic-search']
          : [],
        issues: currentSkillSettings.libraryRoot
          ? []
          : [
              {
                severity: 'error',
                code: 'missing-library-root',
                message: 'Library root is not configured.',
              },
            ],
        providers: [
          {
            provider: 'codex',
            configured: Boolean(currentSkillSettings.providers.codex.targetRoot),
            plannedExports: currentSkillSettings.libraryRoot
              ? ['document-topic-search']
              : [],
          },
          {
            provider: 'claude',
            configured: Boolean(currentSkillSettings.providers.claude.targetRoot),
            plannedExports: currentSkillSettings.libraryRoot
              ? ['pdf-topic-search']
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
        lastSyncResult: syncResult,
      }

      return syncResult
    }),
    pickDirectory: vi
      .fn()
      .mockResolvedValueOnce('C:\\repo\\agentclis-skills')
      .mockResolvedValueOnce('C:\\skills\\codex')
      .mockResolvedValueOnce('C:\\skills\\claude'),
    openPath: vi.fn().mockResolvedValue(undefined),
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
  }
}

describe('App skills settings', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useSessionsStore.setState({
      projects: [],
      activeSessionId: null,
      hydrated: false,
    })
  })

  it('loads validation state, lets the user choose roots, and shows the last sync result', async () => {
    const user = userEvent.setup()
    const { agentCli } = createAgentCliMock()

    window.agentCli = agentCli

    render(<App />)

    await screen.findByText('Create a project or session to get started.')

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText('Library root is not configured.')).toBeInTheDocument()

    const chooseButtons = screen.getAllByRole('button', { name: 'Choose' })
    await user.click(chooseButtons[0]!)
    await user.click(chooseButtons[1]!)
    await user.click(chooseButtons[2]!)

    await waitFor(() => {
      expect(screen.getByText('C:\\repo\\agentclis-skills')).toBeInTheDocument()
    })

    expect(screen.getByText('C:\\skills\\codex')).toBeInTheDocument()
    expect(screen.getByText('C:\\skills\\claude')).toBeInTheDocument()
    expect(screen.queryByText('Library root is not configured.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sync now' }))

    await waitFor(() => {
      expect(screen.getByText('Last sync')).toBeInTheDocument()
      expect(screen.getByText('Succeeded')).toBeInTheDocument()
    })

    expect(agentCli.updateSkillLibrarySettings).toHaveBeenCalled()
    expect(agentCli.syncSkills).toHaveBeenCalledTimes(1)
  })
})
