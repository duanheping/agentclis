import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CreateSessionDialog } from './CreateSessionDialog'
import type { ProjectSnapshot } from '../shared/session'

function buildProject(): ProjectSnapshot {
  return {
    config: {
      id: 'project-1',
      title: 'MSAR43_S32G',
      rootPath: 'C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
    },
    sessions: [],
  }
}

describe('CreateSessionDialog', () => {
  it('uses a compact project context flow that only asks for the agent cli', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreateProject = vi.fn().mockResolvedValue(undefined)
    const onCreateSession = vi.fn().mockResolvedValue(undefined)

    render(
      <CreateSessionDialog
        open
        initialIntent="session"
        mode="project-context"
        projects={[buildProject()]}
        activeProjectId="project-1"
        onClose={onClose}
        onCreateProject={onCreateProject}
        onCreateSession={onCreateSession}
      />,
    )

    expect(screen.getByText('MSAR43_S32G')).toBeInTheDocument()
    expect(
      screen.getByText('C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Session title (optional)')).not.toBeInTheDocument()
    expect(screen.queryByText('Startup command')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Session working directory (optional)'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Copilot CLI/i }))
    await user.click(screen.getByRole('button', { name: 'Create session' }))

    expect(onCreateProject).not.toHaveBeenCalled()
    expect(onCreateSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: '',
      startupCommand: 'copilot',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
      createWithWorktree: true,
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the new project flow focused on the project root path', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreateProject = vi.fn().mockResolvedValue(undefined)
    const onCreateSession = vi.fn().mockResolvedValue(undefined)
    window.agentCli = {
      pickDirectory: vi
        .fn()
        .mockResolvedValue('C:\\Users\\hduan10\\Documents\\repo\\agenclis'),
      persistTransientFile: vi.fn(),
    } as unknown as typeof window.agentCli

    render(
      <CreateSessionDialog
        open
        initialIntent="project"
        projects={[]}
        activeProjectId={null}
        onClose={onClose}
        onCreateProject={onCreateProject}
        onCreateSession={onCreateSession}
      />,
    )

    expect(screen.queryByText('Project name (optional)')).not.toBeInTheDocument()
    expect(screen.queryByText('First session title (optional)')).not.toBeInTheDocument()
    expect(
      screen.queryByText('First session startup command (optional)'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('First session working directory (optional)'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(onCreateProject).toHaveBeenCalledWith({
      rootPath: 'C:\\Users\\hduan10\\Documents\\repo\\agenclis',
    })
    expect(onCreateSession).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
