import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectDiffPanel } from './ProjectDiffPanel'
import type { ProjectGitOverview } from '../shared/projectTools'

function buildOverview(): ProjectGitOverview {
  return {
    projectPath: 'C:\\repo\\agenclis',
    isGitRepository: true,
    repoRoot: 'C:\\repo\\agenclis',
    branch: 'feature/diff-panel',
    branches: ['feature/diff-panel', 'main'],
    unstagedFiles: [
      {
        path: 'src/App.tsx',
        status: 'modified',
        additions: 4,
        deletions: 2,
        staged: false,
      },
    ],
    stagedFiles: [
      {
        path: 'README.md',
        status: 'added',
        additions: 10,
        deletions: 0,
        staged: true,
      },
    ],
    unstagedTotals: {
      additions: 4,
      deletions: 2,
    },
    stagedTotals: {
      additions: 10,
      deletions: 0,
    },
  }
}

describe('ProjectDiffPanel', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows one combined file list while preserving staged file selection', async () => {
    const user = userEvent.setup()
    const onSelectFile = vi.fn()

    render(
      <ProjectDiffPanel
        overview={buildOverview()}
        loading={false}
        errorMessage={null}
        selectedFile={{
          path: 'src/App.tsx',
          staged: false,
        }}
        revertingFile={null}
        diffContent="diff --git a/src/App.tsx b/src/App.tsx"
        diffLoading={false}
        diffErrorMessage={null}
        onRefresh={vi.fn()}
        onSelectFile={onSelectFile}
        onRevertFile={vi.fn()}
      />,
    )

    expect(screen.queryByText('Unstaged')).not.toBeInTheDocument()
    expect(screen.queryByText('Staged')).not.toBeInTheDocument()
    expect(screen.getAllByText('src/App.tsx')).toHaveLength(2)
    expect(screen.getByText('README.md')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /README\.md/i }))

    expect(onSelectFile).toHaveBeenCalledWith({
      path: 'README.md',
      status: 'added',
      additions: 10,
      deletions: 0,
      staged: true,
    })
  })

  it('renders diff lines with different classes for metadata, hunks, additions, and removals', () => {
    render(
      <ProjectDiffPanel
        overview={buildOverview()}
        loading={false}
        errorMessage={null}
        selectedFile={{
          path: 'src/App.tsx',
          staged: false,
        }}
        revertingFile={null}
        diffContent={[
          'diff --git a/src/App.tsx b/src/App.tsx',
          '@@ -1,2 +1,2 @@',
          '-const oldValue = false',
          '+const nextValue = true',
          ' unchanged',
        ].join('\n')}
        diffLoading={false}
        diffErrorMessage={null}
        onRefresh={vi.fn()}
        onSelectFile={vi.fn()}
        onRevertFile={vi.fn()}
      />,
    )

    expect(screen.getByText('Patch preview')).toBeInTheDocument()
    expect(screen.getByText(/diff --git a\/src\/App\.tsx/i)).toHaveClass(
      'project-diff-panel__code-line--meta',
    )
    expect(screen.getByText('@@ -1,2 +1,2 @@')).toHaveClass(
      'project-diff-panel__code-line--hunk',
    )
    expect(screen.getByText('-const oldValue = false')).toHaveClass(
      'project-diff-panel__code-line--removed',
    )
    expect(screen.getByText('+const nextValue = true')).toHaveClass(
      'project-diff-panel__code-line--added',
    )
  })

  it('opens a context menu and forwards revert actions for a file', async () => {
    const user = userEvent.setup()
    const onRevertFile = vi.fn()

    render(
      <ProjectDiffPanel
        overview={buildOverview()}
        loading={false}
        errorMessage={null}
        selectedFile={{
          path: 'src/App.tsx',
          staged: false,
        }}
        revertingFile={null}
        diffContent="diff --git a/src/App.tsx b/src/App.tsx"
        diffLoading={false}
        diffErrorMessage={null}
        onRefresh={vi.fn()}
        onSelectFile={vi.fn()}
        onRevertFile={onRevertFile}
      />,
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: /README\.md/i }), {
      clientX: 80,
      clientY: 120,
    })

    await user.click(screen.getByRole('menuitem', { name: 'Revert changes' }))

    expect(onRevertFile).toHaveBeenCalledWith({
      path: 'README.md',
      status: 'added',
      additions: 10,
      deletions: 0,
      staged: true,
    })
  })
})
