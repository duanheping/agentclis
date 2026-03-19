// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

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

import { createProjectSessionWorktree } from './projectWorktree'

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
})
