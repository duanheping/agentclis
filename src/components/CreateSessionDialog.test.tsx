import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSnapshot } from '../shared/session'
import { CreateSessionDialog } from './CreateSessionDialog'

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
  afterEach(() => {
    cleanup()
  })

  it('uses a compact default session flow with project and agent cli only', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreateProject = vi.fn().mockResolvedValue(undefined)
    const onCreateSession = vi.fn().mockResolvedValue(undefined)

    render(
      <CreateSessionDialog
        open
        initialIntent="session"
        projects={[buildProject()]}
        activeProjectId="project-1"
        onClose={onClose}
        onCreateProject={onCreateProject}
        onCreateSession={onCreateSession}
      />,
    )

    expect(screen.getByRole('heading', { name: 'New session' })).toBeInTheDocument()
    expect(screen.queryByText('New Session')).not.toBeInTheDocument()
    expect(
      screen.queryByText('C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Session title (optional)')).not.toBeInTheDocument()
    expect(screen.queryByText('Startup command')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Session working directory (optional)'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Command: codex')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Project' }))
    expect(screen.queryByText('Create new project')).not.toBeInTheDocument()
    expect(
      screen.queryByText('C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Copilot CLI/i }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreateProject).not.toHaveBeenCalled()
    expect(onCreateSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      startupCommand: 'copilot',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses a compact project context flow that locks the project and starts in the project root', async () => {
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

    expect(screen.getByRole('heading', { name: 'New session' })).toBeInTheDocument()
    expect(screen.queryByText('New Session')).not.toBeInTheDocument()
    expect(screen.getByText('MSAR43_S32G')).toBeInTheDocument()
    expect(
      screen.queryByText('C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('A fresh git worktree and branch will be created for this session.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Session title (optional)')).not.toBeInTheDocument()
    expect(screen.queryByText('Startup command')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Session working directory (optional)'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Command: codex')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Copilot CLI/i }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreateProject).not.toHaveBeenCalled()
    expect(onCreateSession).toHaveBeenCalledWith({
      projectId: 'project-1',
      startupCommand: 'copilot',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
      attachProjectContext: true,
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

    expect(screen.getByRole('dialog', { name: 'New Project' })).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Create project' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Project name (optional)')).not.toBeInTheDocument()
    expect(screen.queryByText('First session title (optional)')).not.toBeInTheDocument()
    expect(
      screen.queryByText('First session startup command (optional)'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('First session working directory (optional)'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Project root path')).not.toBeInTheDocument()
    expect(screen.queryByText('Choose folder')).not.toBeInTheDocument()
    expect(
      screen.queryByText('Use the native folder picker to choose the project root.'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Project root folder' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreateProject).toHaveBeenCalledWith({
      rootPath: 'C:\\Users\\hduan10\\Documents\\repo\\agenclis',
    })
    expect(onCreateSession).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
