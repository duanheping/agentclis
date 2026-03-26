// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  filePath: 'Applications/SipAddon/StartApplication/Appl/Source/GNP.c',
  repoRoot: 'C:/repo/MSAR43_S32G',
  access: vi.fn().mockResolvedValue(undefined),
  spawn: vi.fn(),
  execFileImpl: vi.fn(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const commandLine = args.join(' ')

      if (command !== 'git') {
        callback(new Error(`Unexpected command: ${command}`), '', '')
        return
      }

      if (commandLine.includes('rev-parse --show-toplevel')) {
        callback(null, `${mocks.repoRoot}\n`, '')
        return
      }

      if (commandLine.includes('symbolic-ref --short HEAD')) {
        callback(null, 'ECG-206483\n', '')
        return
      }

      if (commandLine.includes('rev-parse --short HEAD')) {
        callback(null, 'abc1234\n', '')
        return
      }

      if (commandLine.includes('status --short --untracked-files=all')) {
        callback(null, ` M ${mocks.filePath}\n`, '')
        return
      }

      if (
        commandLine.includes(
          'diff --no-ext-diff --no-textconv --no-color --cached --numstat',
        )
      ) {
        callback(null, '', '')
        return
      }

      if (
        commandLine.includes('diff --no-ext-diff --no-textconv --no-color --numstat')
      ) {
        callback(null, `71\t16\t${mocks.filePath}\n`, '')
        return
      }

      if (
        commandLine.includes(
          'diff --no-ext-diff --no-textconv --no-color --unified=3',
        )
      ) {
        callback(
          null,
          `diff --git a/${mocks.filePath} b/${mocks.filePath}\n+retry write\n`,
          '',
        )
        return
      }

      callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
    },
  ),
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.execFileImpl,
  spawn: mocks.spawn,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    access: mocks.access,
  }
})

import {
  getProjectGitDiff,
  getProjectGitOverview,
  openProjectInTarget,
  revertProjectGitFile,
} from './projectTools'

function installDefaultExecFileImpl(): void {
  mocks.execFileImpl.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const commandLine = args.join(' ')

      if (command !== 'git') {
        callback(new Error(`Unexpected command: ${command}`), '', '')
        return
      }

      if (commandLine.includes('rev-parse --show-toplevel')) {
        callback(null, `${mocks.repoRoot}\n`, '')
        return
      }

      if (commandLine.includes('symbolic-ref --short HEAD')) {
        callback(null, 'ECG-206483\n', '')
        return
      }

      if (commandLine.includes('rev-parse --short HEAD')) {
        callback(null, 'abc1234\n', '')
        return
      }

      if (commandLine.includes('status --short --untracked-files=all')) {
        callback(null, ` M ${mocks.filePath}\n`, '')
        return
      }

      if (
        commandLine.includes(
          'diff --no-ext-diff --no-textconv --no-color --cached --numstat',
        )
      ) {
        callback(null, '', '')
        return
      }

      if (
        commandLine.includes('diff --no-ext-diff --no-textconv --no-color --numstat')
      ) {
        callback(null, `71\t16\t${mocks.filePath}\n`, '')
        return
      }

      if (
        commandLine.includes(
          'diff --no-ext-diff --no-textconv --no-color --unified=3',
        )
      ) {
        callback(
          null,
          `diff --git a/${mocks.filePath} b/${mocks.filePath}\n+retry write\n`,
          '',
        )
        return
      }

      callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
    },
  )
}

describe('projectTools', () => {
  beforeEach(() => {
    mocks.access.mockClear()
    mocks.execFileImpl.mockReset()
    installDefaultExecFileImpl()
    mocks.spawn.mockClear()
  })

  it('opens VS Code using the vscode URI handler first', async () => {
    const shell = {
      openExternal: vi.fn().mockResolvedValue(undefined),
      openPath: vi.fn().mockResolvedValue(''),
    }

    await openProjectInTarget('vscode', process.cwd(), shell)

    expect(shell.openExternal).toHaveBeenCalledTimes(1)
    expect(shell.openExternal.mock.calls[0]?.[0]).toMatch(/^vscode:\/\/file\//)
  })

  it('loads git overview numstat using Git internal diff output', async () => {
    const overview = await getProjectGitOverview(mocks.repoRoot)

    expect(overview.branch).toBe('ECG-206483')
    expect(overview.unstagedFiles).toEqual([
      {
        additions: 71,
        deletions: 16,
        path: mocks.filePath,
        staged: false,
        status: 'modified',
      },
    ])

    const numstatCalls = mocks.execFileImpl.mock.calls.filter(([, args]) =>
      args.includes('--numstat'),
    )

    expect(numstatCalls).toHaveLength(2)
    expect(
      numstatCalls.every(([, args]) =>
        args.includes('--no-ext-diff') &&
        args.includes('--no-textconv') &&
        args.includes('--no-color'),
      ),
    ).toBe(true)
  })

  it('loads per-file diffs using Git internal diff output', async () => {
    const diff = await getProjectGitDiff(mocks.repoRoot, mocks.filePath, false)

    expect(diff).toEqual({
      filePath: mocks.filePath,
      staged: false,
      patch: `diff --git a/${mocks.filePath} b/${mocks.filePath}\n+retry write`,
    })

    const diffCall = mocks.execFileImpl.mock.calls.find(([, args]) =>
      args.includes('--unified=3'),
    )

    expect(diffCall?.[1]).toEqual([
      '-C',
      mocks.repoRoot,
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--unified=3',
      '--',
      mocks.filePath,
    ])
  })

  it('reverts an unstaged tracked file from the worktree', async () => {
    mocks.execFileImpl.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')

        if (command !== 'git') {
          callback(new Error(`Unexpected command: ${command}`), '', '')
          return
        }

        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, `${mocks.repoRoot}\n`, '')
          return
        }

        if (commandLine.includes('restore --worktree --')) {
          callback(null, '', '')
          return
        }

        callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
      },
    )

    await revertProjectGitFile(mocks.repoRoot, {
      path: mocks.filePath,
      status: 'modified',
      additions: 71,
      deletions: 16,
      staged: false,
    })

    const restoreCall = mocks.execFileImpl.mock.calls.at(-1)
    expect(restoreCall?.[1]).toEqual([
      '-C',
      mocks.repoRoot,
      'restore',
      '--worktree',
      '--',
      mocks.filePath,
    ])
  })

  it('reverts conflicted files by restoring index and worktree from HEAD', async () => {
    mocks.execFileImpl.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')

        if (command !== 'git') {
          callback(new Error(`Unexpected command: ${command}`), '', '')
          return
        }

        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, `${mocks.repoRoot}\n`, '')
          return
        }

        if (commandLine.includes('restore --source=HEAD --staged --worktree --')) {
          callback(null, '', '')
          return
        }

        callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
      },
    )

    await revertProjectGitFile(mocks.repoRoot, {
      path: mocks.filePath,
      status: 'conflicted',
      additions: 0,
      deletions: 0,
      staged: false,
    })

    const restoreCall = mocks.execFileImpl.mock.calls.at(-1)
    expect(restoreCall?.[1]).toEqual([
      '-C',
      mocks.repoRoot,
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      mocks.filePath,
    ])
  })

  it('reverts staged renamed files by restoring both old and new paths from HEAD', async () => {
    mocks.execFileImpl.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')

        if (command !== 'git') {
          callback(new Error(`Unexpected command: ${command}`), '', '')
          return
        }

        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, `${mocks.repoRoot}\n`, '')
          return
        }

        if (commandLine.includes('restore --source=HEAD --staged --worktree --')) {
          callback(null, '', '')
          return
        }

        callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
      },
    )

    await revertProjectGitFile(mocks.repoRoot, {
      path: 'Applications/SipAddon/StartApplication/Appl/Source/GNP_New.c',
      previousPath: mocks.filePath,
      status: 'renamed',
      additions: 0,
      deletions: 0,
      staged: true,
    })

    const restoreCall = mocks.execFileImpl.mock.calls.at(-1)
    expect(restoreCall?.[1]).toEqual([
      '-C',
      mocks.repoRoot,
      'restore',
      '--source=HEAD',
      '--staged',
      '--worktree',
      '--',
      mocks.filePath,
      'Applications/SipAddon/StartApplication/Appl/Source/GNP_New.c',
    ])
  })

  it('removes untracked files with git clean', async () => {
    mocks.execFileImpl.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const commandLine = args.join(' ')

        if (command !== 'git') {
          callback(new Error(`Unexpected command: ${command}`), '', '')
          return
        }

        if (commandLine.includes('rev-parse --show-toplevel')) {
          callback(null, `${mocks.repoRoot}\n`, '')
          return
        }

        if (commandLine.includes('clean -f --')) {
          callback(null, '', '')
          return
        }

        callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
      },
    )

    await revertProjectGitFile(mocks.repoRoot, {
      path: 'Applications/SipAddon/StartApplication/notes.txt',
      status: 'untracked',
      additions: 0,
      deletions: 0,
      staged: false,
    })

    const cleanCall = mocks.execFileImpl.mock.calls.at(-1)
    expect(cleanCall?.[1]).toEqual([
      '-C',
      mocks.repoRoot,
      'clean',
      '-f',
      '--',
      'Applications/SipAddon/StartApplication/notes.txt',
    ])
  })
})
