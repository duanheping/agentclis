import type { ComponentProps } from 'react'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
        recommendedRoot: 'discovered',
        recommendedRootLabel: 'C:\\Users\\hduan10\\.codex\\skills',
        differingFiles: ['SKILL.md', 'notes.txt'],
        roots: [
          {
            root: 'library',
            label: 'Library',
            rootPath: 'C:\\skills\\library',
            modifiedAt: '2026-03-12T12:00:00.000Z',
            fileCount: 2,
          },
          {
            root: 'discovered',
            label: 'C:\\Users\\hduan10\\.codex\\skills',
            rootPath: 'C:\\Users\\hduan10',
            modifiedAt: '2026-03-12T11:00:00.000Z',
            fileCount: 2,
          },
        ],
      },
    ],
    roots: [
      {
        root: 'library',
        label: 'Library',
        configured: true,
        rootPath: 'C:\\skills\\library',
        skillNames: ['document-topic-search'],
      },
      {
        root: 'discovered',
        label: 'Discovered folders',
        configured: true,
        rootPath: 'C:\\Users\\hduan10',
        skillNames: ['document-topic-search'],
        folderCount: 2,
        message: 'Automatically scanned 2 folders under C:\\Users\\hduan10.',
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
      projectArchitectureAnalyzing={false}
      projectSessionsAnalyzing={false}
      projectArchitectureAnalysisStatus={null}
      projectSessionsAnalysisStatus={null}
      skillAiMergeProposal={null}
      skillsErrorMessage={null}
      onPickSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onClearSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onOpenSkillLibraryRoot={vi.fn().mockResolvedValue(undefined)}
      onSetPrimaryMergeAgent={vi.fn().mockResolvedValue(undefined)}
      onSetReviewMergeAgent={vi.fn().mockResolvedValue(undefined)}
      onSyncSkills={vi.fn().mockResolvedValue(undefined)}
      onAnalyzeProjectArchitecture={vi.fn().mockResolvedValue(undefined)}
      onAnalyzeProjectSessions={vi.fn().mockResolvedValue(undefined)}
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
    expect(screen.getByText('Prefer C:\\Users\\hduan10\\.codex\\skills')).toBeInTheDocument()
    expect(screen.getByText('SKILL.md, notes.txt')).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Use C:\\Users\\hduan10\\.codex\\skills' }),
    )

    expect(onResolveSkillConflict).toHaveBeenCalledWith(
      'document-topic-search',
      'discovered',
    )
  })

  it('forwards the dedicated project architecture analysis action', async () => {
    const user = userEvent.setup()
    const onAnalyzeProjectArchitecture = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      onAnalyzeProjectArchitecture,
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Analyze architecture' }))

    expect(onAnalyzeProjectArchitecture).toHaveBeenCalledTimes(1)
  })

  it('forwards the stored sessions analysis action', async () => {
    const user = userEvent.setup()
    const onAnalyzeProjectSessions = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      onAnalyzeProjectSessions,
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Analyze sessions' }))

    expect(onAnalyzeProjectSessions).toHaveBeenCalledTimes(1)
  })

  it('allows spaces while renaming a session', async () => {
    const user = userEvent.setup()
    const onRename = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      onRename,
    })

    fireEvent.contextMenu(
      screen.getByRole('button', { name: /why you don't show session title/i }),
    )

    await user.click(screen.getByRole('button', { name: 'Rename session' }))

    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'triage ECG 205709')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(onRename).toHaveBeenCalledWith('session-1', 'triage ECG 205709')
  })

  it('shows a session attention badge when a reply is needed', () => {
    const project = buildProject()
    project.sessions[0]!.runtime.attention = 'needs-user-decision'

    renderSidebar({
      projects: [project],
    })

    expect(screen.getByText('Reply')).toBeInTheDocument()
    expect(screen.getByText("why you don't show session title")).toBeInTheDocument()
  })

  it('keeps library setup feedback inline while hiding sync diagnostics', async () => {
    const user = userEvent.setup()

    renderSidebar({
      skillLibrarySettings: {
        ...buildSkillLibrarySettings(),
        libraryRoot: '',
      },
      skillSyncStatus: {
        issues: [
          {
            severity: 'error',
            code: 'missing-library-root',
            message: 'Library root is not configured.',
            root: 'library',
          },
          {
            severity: 'warning',
            code: 'duplicate-discovered-skill',
            message:
              'Detected 2 copies of "document-topic-search" across .codex/skills, .claude/skills, or .copilot/skills. Using the newest copy from C:\\Users\\hduan10\\.codex\\skills.',
            skillName: 'document-topic-search',
            root: 'discovered',
            rootLabel: 'Discovered folders',
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
            skillNames: ['document-topic-search'],
            folderCount: 2,
          },
        ],
        lastSyncResult: {
          startedAt: '2026-03-12T18:00:00.000Z',
          completedAt: '2026-03-12T18:00:02.000Z',
          success: false,
          issues: [],
          conflicts: [],
          synchronizedSkills: [],
          roots: [
            {
              root: 'library',
              label: 'Library',
              rootPath: '',
              synchronizedSkills: [],
              changedSkills: [],
              changed: false,
              skipped: true,
            },
          ],
        },
      },
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByText('Library root is not configured.')).toBeInTheDocument()
    expect(screen.queryByText('Validation')).not.toBeInTheDocument()
    expect(screen.queryByText(/Detected 2 copies of "document-topic-search"/)).not.toBeInTheDocument()
    expect(screen.queryByText('Last sync')).not.toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
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

  it('exposes Copilot in the merge agent selectors', async () => {
    const user = userEvent.setup()
    const onSetPrimaryMergeAgent = vi.fn().mockResolvedValue(undefined)
    const onSetReviewMergeAgent = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      onSetPrimaryMergeAgent,
      onSetReviewMergeAgent,
    })

    await user.click(screen.getByRole('button', { name: 'Settings' }))

    await user.click(screen.getByRole('button', { name: 'Primary agent' }))
    await user.click(screen.getByRole('option', { name: 'Copilot' }))
    await user.click(screen.getByRole('button', { name: 'Secondary agent' }))
    await user.click(screen.getByRole('option', { name: 'Copilot' }))

    expect(onSetPrimaryMergeAgent).toHaveBeenCalledWith('copilot')
    expect(onSetReviewMergeAgent).toHaveBeenCalledWith('copilot')
  })
})
