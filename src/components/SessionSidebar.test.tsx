import type { ComponentProps } from 'react'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionSidebar } from './SessionSidebar'
import type {
  SkillAiMergeProposal,
  SkillLibrarySettings,
  SkillSyncStatus,
} from '../shared/skills'
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
    primaryMergeAgent: 'codex',
    reviewMergeAgent: 'claude',
  }
}

function buildSkillSyncStatus(): SkillSyncStatus {
  return {
    issues: [],
    conflicts: [
      {
        skillName: 'document-topic-search',
        recommendedRoot: 'codex',
        differingFiles: ['SKILL.md', 'notes.txt'],
        roots: [
          {
            root: 'codex',
            rootPath: 'C:\\Users\\hduan10\\.codex\\skills',
            modifiedAt: '2026-03-12T12:00:00.000Z',
            fileCount: 2,
          },
          {
            root: 'claude',
            rootPath: 'C:\\Users\\hduan10\\.claude\\skills',
            modifiedAt: '2026-03-12T11:00:00.000Z',
            fileCount: 2,
          },
        ],
      },
    ],
    roots: [
      {
        root: 'library',
        configured: true,
        rootPath: 'C:\\skills\\library',
        skillNames: ['document-topic-search'],
      },
      {
        root: 'codex',
        configured: true,
        rootPath: 'C:\\Users\\hduan10\\.codex\\skills',
        skillNames: ['document-topic-search'],
      },
      {
        root: 'claude',
        configured: true,
        rootPath: 'C:\\Users\\hduan10\\.claude\\skills',
        skillNames: ['document-topic-search'],
      },
    ],
    lastSyncResult: null,
  }
}

function buildSkillAiMergeProposal(): SkillAiMergeProposal {
  return {
    skillName: 'document-topic-search',
    mergeAgent: 'codex',
    generatedAt: '2026-03-12T18:05:00.000Z',
    summary: 'Merged the clearer instructions and kept the useful helper notes.',
    rationale: 'Used the Codex SKILL.md structure and kept the extra notes file.',
    warnings: ['Double-check the notes wording before applying.'],
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
      summary: 'The merge keeps the best instructions.',
      rationale: 'No important content appears to be missing.',
      warnings: ['The notes file still has one awkward sentence.'],
    },
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
      skillsResolving={null}
      skillsGeneratingMerge={null}
      skillsApplyingMerge={false}
      skillAiMergeProposal={null}
      skillsErrorMessage={null}
      onPickSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onClearSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onOpenSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onToggleSkillAutoSync={vi.fn().mockResolvedValue(undefined)}
      onSetPrimaryMergeAgent={vi.fn().mockResolvedValue(undefined)}
      onSetReviewMergeAgent={vi.fn().mockResolvedValue(undefined)}
      onPickSkillTargetRoot={vi.fn().mockResolvedValue(undefined)}
      onClearSkillTargetRoot={vi.fn().mockResolvedValue(undefined)}
      onOpenSkillTargetRoot={vi.fn().mockResolvedValue(undefined)}
      onSyncSkills={vi.fn().mockResolvedValue(undefined)}
      onResolveSkillConflict={vi.fn().mockResolvedValue(undefined)}
      onGenerateSkillAiMerge={vi.fn().mockResolvedValue(undefined)}
      onApplySkillAiMerge={vi.fn().mockResolvedValue(undefined)}
      onDismissSkillAiMerge={vi.fn()}
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

  it('shows skill conflicts and forwards a chosen conflict source', async () => {
    const user = userEvent.setup()
    const onResolveSkillConflict = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      onResolveSkillConflict,
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText('Conflicts')).toBeInTheDocument()
    expect(screen.getByText('Prefer Codex')).toBeInTheDocument()
    expect(screen.getByText('SKILL.md, notes.txt')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Use Codex' }))

    expect(onResolveSkillConflict).toHaveBeenCalledWith(
      'document-topic-search',
      'codex',
    )
  })

  it('shows an AI merge preview and forwards apply/dismiss actions', async () => {
    const user = userEvent.setup()
    const onGenerateSkillAiMerge = vi.fn().mockResolvedValue(undefined)
    const onApplySkillAiMerge = vi.fn().mockResolvedValue(undefined)
    const onDismissSkillAiMerge = vi.fn()

    renderSidebar({
      skillAiMergeProposal: buildSkillAiMergeProposal(),
      onGenerateSkillAiMerge,
      onApplySkillAiMerge,
      onDismissSkillAiMerge,
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText('AI Merge Preview')).toBeInTheDocument()
    expect(screen.getByText(/Merged the clearer instructions/i)).toBeInTheDocument()
    expect(screen.getByText('Approved with warnings by Claude')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'AI Merge' }))
    await user.click(screen.getByRole('button', { name: 'Apply Merge' }))
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(onGenerateSkillAiMerge).toHaveBeenCalledWith('document-topic-search')
    expect(onApplySkillAiMerge).toHaveBeenCalledTimes(1)
    expect(onDismissSkillAiMerge).toHaveBeenCalledTimes(1)
  })
})
