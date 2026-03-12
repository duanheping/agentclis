import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { SessionSidebar } from './SessionSidebar'
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

describe('SessionSidebar', () => {
  it('collapses the active project when its header is clicked', async () => {
    const user = userEvent.setup()

    render(
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
      />,
    )

    const projectHeader = screen.getByRole('button', { name: /AGENCLIS/i })

    expect(projectHeader).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText("why you don't show session title")).toBeInTheDocument()

    await user.click(projectHeader)

    expect(projectHeader).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText("why you don't show session title")).not.toBeInTheDocument()
  })
})
