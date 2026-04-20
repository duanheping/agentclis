// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const commandLine = args.join(' ')

      if (commandLine.includes('rev-parse --show-toplevel')) {
        callback(null, 'C:\\repo\\agenclis\n', '')
        return
      }

      if (commandLine.includes('symbolic-ref --quiet --short HEAD')) {
        callback(null, 'feature/session-recovery\n', '')
        return
      }

      if (commandLine.includes('worktree add')) {
        callback(null, '', '')
        return
      }

      if (commandLine.includes('worktree remove --force')) {
        callback(null, '', '')
        return
      }

      if (commandLine.includes('branch -D')) {
        callback(null, '', '')
        return
      }

      callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
    },
  ),
  mkdir: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: mocks.mkdir,
  }
})

vi.mock('node:os', () => ({
  default: {
    homedir: () => 'C:\\Users\\tester',
  },
}))

import {
  createProjectSessionWorktree,
  removeProjectSessionWorktree,
} from './projectWorktree'

beforeEach(() => {
  mocks.execFile.mockReset()
  mocks.execFile.mockImplementation(
    (
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const commandLine = args.join(' ')

      if (commandLine.includes('rev-parse --show-toplevel')) {
        callback(null, 'C:\\repo\\agenclis\n', '')
        return
      }

      if (commandLine.includes('symbolic-ref --quiet --short HEAD')) {
        callback(null, 'feature/session-recovery\n', '')
        return
      }

      if (commandLine.includes('worktree add')) {
        callback(null, '', '')
        return
      }

      if (commandLine.includes('worktree remove --force')) {
        callback(null, '', '')
        return
      }

      if (commandLine.includes('branch -D')) {
        callback(null, '', '')
        return
      }

      callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
    },
  )
  mocks.mkdir.mockClear()
})

describe('createProjectSessionWorktree', () => {
  it('creates a new git worktree and branch beneath the Codex worktree root', async () => {
    const worktree = await createProjectSessionWorktree({
      projectRootPath: 'C:\\repo\\agenclis',
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      createdAt: '2026-03-17T15:30:45.000Z',
    })

    expect(worktree).toEqual({
      branchName: 'agenclis/feature-session-recovery/20260317-153045-12345678',
      cwd: 'C:\\Users\\tester\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
    })
    expect(mocks.mkdir).toHaveBeenCalledWith(
      'C:\\Users\\tester\\.codex\\worktrees\\agenclis',
      { recursive: true },
    )
    expect(mocks.execFile).toHaveBeenLastCalledWith(
      'git',
      [
        '-C',
        'C:\\repo\\agenclis',
        'worktree',
        'add',
        '-b',
        'agenclis/feature-session-recovery/20260317-153045-12345678',
        'C:\\Users\\tester\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
        'HEAD',
      ],
      expect.objectContaining({
        cwd: 'C:\\repo\\agenclis',
        encoding: 'utf8',
        windowsHide: true,
      }),
      expect.any(Function),
    )
  })

  it('fails with a clear error when the project root is not a git repository', async () => {
    mocks.execFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('fatal'), '', 'fatal: not a git repository')
      },
    )

    await expect(
      createProjectSessionWorktree({
        projectRootPath: 'C:\\repo\\plain-folder',
        sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
        createdAt: '2026-03-17T15:30:45.000Z',
      }),
    ).rejects.toThrow(
      'Git worktrees require the project root to be inside a git repository.',
    )
  })

  it('sanitizes special characters in branch name segments', async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')
        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, 'C:\\repo\\my-project\n', '')
          return
        }
        if (commandLine.includes('symbolic-ref --quiet --short HEAD')) {
          callback(null, 'feature/CAPS & special!chars\n', '')
          return
        }
        if (commandLine.includes('worktree add')) {
          callback(null, '', '')
          return
        }
        callback(new Error(`Unexpected: ${commandLine}`), '', '')
      },
    )

    const worktree = await createProjectSessionWorktree({
      projectRootPath: 'C:\\repo\\my-project',
      sessionId: 'abcdef01-0000-0000-0000-000000000000',
      createdAt: '2026-06-15T10:00:00.000Z',
    })

    expect(worktree.branchName).toMatch(/^agenclis\//)
    expect(worktree.branchName).not.toMatch(/[A-Z&!]/)
  })

  it('handles invalid createdAt by falling back to current date', async () => {
    const worktree = await createProjectSessionWorktree({
      projectRootPath: 'C:\\repo\\agenclis',
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      createdAt: 'invalid-date',
    })

    expect(worktree.branchName).toMatch(/^agenclis\//)
    expect(worktree.cwd).toContain('worktrees')
  })

  it('falls back to short HEAD when symbolic-ref fails', async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')
        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, 'C:\\repo\\agenclis\n', '')
          return
        }
        if (commandLine.includes('symbolic-ref --quiet --short HEAD')) {
          callback(new Error('fatal: not on a branch'), '', 'fatal: not on a branch')
          return
        }
        if (commandLine.includes('rev-parse --short HEAD')) {
          callback(null, 'abc1234\n', '')
          return
        }
        if (commandLine.includes('worktree add')) {
          callback(null, '', '')
          return
        }
        callback(new Error(`Unexpected: ${commandLine}`), '', '')
      },
    )

    const worktree = await createProjectSessionWorktree({
      projectRootPath: 'C:\\repo\\agenclis',
      sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      createdAt: '2026-03-17T15:30:45.000Z',
    })

    expect(worktree.branchName).toContain('abc1234')
  })

  it('attempts cleanup when git worktree add fails after creating partial state', async () => {
    mocks.execFile.mockImplementation(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')

        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, 'C:\\repo\\agenclis\n', '')
          return
        }

        if (commandLine.includes('symbolic-ref --quiet --short HEAD')) {
          callback(null, 'feature/session-recovery\n', '')
          return
        }

        if (commandLine.includes('worktree add')) {
          callback(new Error('fatal'), '', 'fatal: worktree add failed')
          return
        }

        if (commandLine.includes('worktree remove --force')) {
          callback(null, '', '')
          return
        }

        if (commandLine.includes('branch -D')) {
          callback(null, '', '')
          return
        }

        callback(new Error(`Unexpected: ${commandLine}`), '', '')
      },
    )

    await expect(
      createProjectSessionWorktree({
        projectRootPath: 'C:\\repo\\agenclis',
        sessionId: '12345678-aaaa-bbbb-cccc-1234567890ab',
        createdAt: '2026-03-17T15:30:45.000Z',
      }),
    ).rejects.toThrow('fatal: worktree add failed')

    expect(mocks.execFile).toHaveBeenNthCalledWith(
      3,
      'git',
      [
        '-C',
        'C:\\repo\\agenclis',
        'worktree',
        'add',
        '-b',
        'agenclis/feature-session-recovery/20260317-153045-12345678',
        'C:\\Users\\tester\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
        'HEAD',
      ],
      expect.anything(),
      expect.any(Function),
    )
    expect(mocks.execFile).toHaveBeenNthCalledWith(
      5,
      'git',
      [
        '-C',
        'C:\\repo\\agenclis',
        'worktree',
        'remove',
        '--force',
        'C:\\Users\\tester\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
      ],
      expect.anything(),
      expect.any(Function),
    )
    expect(mocks.execFile).toHaveBeenNthCalledWith(
      6,
      'git',
      [
        '-C',
        'C:\\repo\\agenclis',
        'branch',
        '-D',
        'agenclis/feature-session-recovery/20260317-153045-12345678',
      ],
      expect.anything(),
      expect.any(Function),
    )
  })
})

describe('removeProjectSessionWorktree', () => {
  it('removes the git worktree and deletes its branch', async () => {
    await removeProjectSessionWorktree({
      projectRootPath: 'C:\\repo\\agenclis',
      branchName: 'agenclis/feature-session-recovery/20260317-153045-12345678',
      cwd: 'C:\\Users\\tester\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
    })

    expect(mocks.execFile).toHaveBeenNthCalledWith(
      1,
      'git',
      ['-C', 'C:\\repo\\agenclis', 'rev-parse', '--show-toplevel'],
      expect.objectContaining({
        cwd: 'C:\\repo\\agenclis',
        encoding: 'utf8',
        windowsHide: true,
      }),
      expect.any(Function),
    )
    expect(mocks.execFile).toHaveBeenNthCalledWith(
      2,
      'git',
      [
        '-C',
        'C:\\repo\\agenclis',
        'worktree',
        'remove',
        '--force',
        'C:\\Users\\tester\\.codex\\worktrees\\agenclis\\20260317-153045-12345678',
      ],
      expect.objectContaining({
        cwd: 'C:\\repo\\agenclis',
        encoding: 'utf8',
        windowsHide: true,
      }),
      expect.any(Function),
    )
    expect(mocks.execFile).toHaveBeenNthCalledWith(
      3,
      'git',
      [
        '-C',
        'C:\\repo\\agenclis',
        'branch',
        '-D',
        'agenclis/feature-session-recovery/20260317-153045-12345678',
      ],
      expect.objectContaining({
        cwd: 'C:\\repo\\agenclis',
        encoding: 'utf8',
        windowsHide: true,
      }),
      expect.any(Function),
    )
  })
})
