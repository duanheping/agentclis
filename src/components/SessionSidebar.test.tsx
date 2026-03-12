import type { ComponentProps } from 'react'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionSidebar } from './SessionSidebar'
import type { SkillLibrarySettings, SkillSyncStatus } from '../shared/skills'
import type { ProjectSnapshot } from '../shared/session'

function buildProject(): ProjectSnapshot {
  return {
    config: {
      id: 'project-1',
      title: 'AGENCLIS',
      rootPath: 'E:\\repo\\agenclis',
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
    },
    sessions: [
      {
        config: {
          id: 'session-1',
          projectId: 'project-1',
          title: "why you don't show session title",
          startupCommand: 'codex',
          pendingFirstPromptTitle: false,
          cwd: 'E:\\repo\\agenclis',
          shell: 'powershell.exe',
          createdAt: '2026-03-11T00:00:00.000Z',
          updatedAt: '2026-03-11T00:00:00.000Z',
        },
        runtime: {
          sessionId: 'session-1',
          status: 'running',
          lastActiveAt: '2026-03-11T00:00:00.000Z',
        },
      },
    ],
  }
}

function buildSkillLibrarySettings(): SkillLibrarySettings {
  return {
    libraryRoot: 'C:\\skills\\library',
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

function buildSkillSyncStatus(): SkillSyncStatus {
  return {
    discoveredSkills: ['document-topic-search'],
    issues: [],
    providers: [
      {
        provider: 'codex',
        configured: true,
        plannedExports: ['document-topic-search'],
      },
      {
        provider: 'claude',
        configured: true,
        plannedExports: ['pdf-topic-search'],
      },
    ],
    lastSyncResult: null,
  }
}

function renderSidebar(overrides?: Partial<ComponentProps<typeof SessionSidebar>>) {
  return render(
    <SessionSidebar
      projects={[buildProject()]}
      activeSessionId="session-1"
      showProjectPaths
      onToggleSidebar={() => {}}
      onCreateSession={() => {}}
      onCreateProject={() => {}}
      onCreateForProject={() => {}}
      onSelect={vi.fn().mockResolvedValue(undefined)}
      onRename={vi.fn().mockResolvedValue(undefined)}
      onClose={vi.fn().mockResolvedValue(undefined)}
      windowsCommandPromptSessionIds={[]}
      onToggleWindowsCommandPrompt={vi.fn().mockResolvedValue(undefined)}
      onToggleProjectPaths={() => {}}
      skillLibrarySettings={buildSkillLibrarySettings()}
      skillSyncStatus={buildSkillSyncStatus()}
      skillsLoading={false}
      skillsBusy={false}
      skillsSyncing={false}
      skillsErrorMessage={null}
      onPickSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onClearSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onOpenSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onToggleSkillAutoSync={vi.fn().mockResolvedValue(undefined)}
      onPickSkillTargetRoot={vi.fn().mockResolvedValue(undefined)}
      onClearSkillTargetRoot={vi.fn().mockResolvedValue(undefined)}
      onOpenSkillTargetRoot={vi.fn().mockResolvedValue(undefined)}
      onSyncSkills={vi.fn().mockResolvedValue(undefined)}
      {...overrides}
    />,
  )
}

describe('SessionSidebar', () => {
  afterEach(() => {
    cleanup()
  })

  it('collapses the active project when its header is clicked', async () => {
    const user = userEvent.setup()

    renderSidebar()

    const projectHeader = screen.getByRole('button', { name: /AGENCLIS/i })

    expect(projectHeader).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText("why you don't show session title")).toBeInTheDocument()

    await user.click(projectHeader)

    expect(projectHeader).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText("why you don't show session title")).not.toBeInTheDocument()
  })

  it('shows skills settings and triggers a sync callback', async () => {
    const user = userEvent.setup()
    const onSyncSkills = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      onSyncSkills,
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText('Library root')).toBeInTheDocument()
    expect(screen.getByText('document-topic-search')).toBeInTheDocument()
    expect(screen.getByText('pdf-topic-search')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sync now' }))

    expect(onSyncSkills).toHaveBeenCalledTimes(1)
  })
})
