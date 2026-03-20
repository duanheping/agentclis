import { execFile, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import type { shell as electronShell } from 'electron'

import type {
  ProjectGitChangeKind,
  ProjectGitDiff,
  ProjectGitFileChange,
  ProjectGitOverview,
  ProjectGitTotals,
  ProjectOpenTarget,
} from '../src/shared/projectTools'
import {
  buildShellArgs,
  resolveCommandPromptCommand,
  resolveExecutable,
  resolveShellCommand,
} from './windowsShell'

const GIT_EXECUTABLE = 'git'
const GIT_INTERNAL_DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color']

interface FileStat {
  path: string
  status: ProjectGitChangeKind
}

interface NumstatEntry {
  additions: number
  deletions: number
}

function normalizeProjectPath(projectPath: string): string {
  const normalized = projectPath.trim()
  if (!normalized) {
    throw new Error('Project path is required.')
  }

  return normalized
}

async function assertProjectPathExists(projectPath: string): Promise<void> {
  try {
    await access(projectPath)
  } catch {
    throw new Error(`Project path does not exist: ${projectPath}`)
  }
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        GIT_EXECUTABLE,
        args,
        {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(error)
            return
          }

          resolve({
            stdout,
            stderr,
          })
        },
      )
    },
  )

  return result.stdout.trimEnd()
}

async function tryRunGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGit(args, cwd)
  } catch {
    return null
  }
}

function mapGitStatus(code: string, pair: string): ProjectGitChangeKind {
  if (pair.includes('U') || pair === 'AA' || pair === 'DD') {
    return 'conflicted'
  }

  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    case '?':
      return 'untracked'
    default:
      return 'modified'
  }
}

function parseStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed.includes(' -> ')) {
    return trimmed.split(' -> ').at(-1) ?? trimmed
  }

  return trimmed
}

function parseGitStatus(output: string): {
  staged: Map<string, FileStat>
  unstaged: Map<string, FileStat>
} {
  const staged = new Map<string, FileStat>()
  const unstaged = new Map<string, FileStat>()

  for (const line of output.split(/\r?\n/u)) {
    if (!line) {
      continue
    }

    if (line.startsWith('?? ')) {
      const filePath = parseStatusPath(line.slice(3))
      unstaged.set(filePath, {
        path: filePath,
        status: 'untracked',
      })
      continue
    }

    if (line.length < 4) {
      continue
    }

    const stagedCode = line[0] ?? ' '
    const unstagedCode = line[1] ?? ' '
    const pair = `${stagedCode}${unstagedCode}`
    const filePath = parseStatusPath(line.slice(3))

    if (stagedCode !== ' ') {
      staged.set(filePath, {
        path: filePath,
        status: mapGitStatus(stagedCode, pair),
      })
    }

    if (unstagedCode !== ' ') {
      unstaged.set(filePath, {
        path: filePath,
        status: mapGitStatus(unstagedCode, pair),
      })
    }
  }

  return { staged, unstaged }
}

function parseNumstat(output: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>()

  for (const line of output.split(/\r?\n/u)) {
    if (!line) {
      continue
    }

    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
    const filePath = pathParts.join('\t').trim()
    if (!filePath) {
      continue
    }

    entries.set(filePath, {
      additions: rawAdditions === '-' ? 0 : Number.parseInt(rawAdditions ?? '0', 10),
      deletions: rawDeletions === '-' ? 0 : Number.parseInt(rawDeletions ?? '0', 10),
    })
  }

  return entries
}

function toFileChanges(
  files: Map<string, FileStat>,
  numstats: Map<string, NumstatEntry>,
  staged: boolean,
): ProjectGitFileChange[] {
  return [...files.values()]
    .map((file) => {
      const stats = numstats.get(file.path) ?? {
        additions: 0,
        deletions: 0,
      }

      return {
        path: file.path,
        status: file.status,
        additions: stats.additions,
        deletions: stats.deletions,
        staged,
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function calculateTotals(files: ProjectGitFileChange[]): ProjectGitTotals {
  return files.reduce<ProjectGitTotals>(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    {
      additions: 0,
      deletions: 0,
    },
  )
}

function spawnDetached(command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function launchExternalCommand(
  executable: string,
  args: string[],
  cwd: string,
): void {
  spawnDetached(
    resolveCommandPromptCommand(),
    ['/c', 'start', '', executable, ...args],
    cwd,
  )
}

async function openInExplorer(
  projectPath: string,
  shell: Pick<typeof electronShell, 'openPath'>,
): Promise<void> {
  const message = await shell.openPath(projectPath)
  if (message) {
    throw new Error(message)
  }
}

function buildVsCodeUri(projectPath: string): string {
  const fileUrl = pathToFileURL(projectPath)
  return `vscode://file${fileUrl.pathname}`
}

async function openInVsCode(
  projectPath: string,
  shell: Pick<typeof electronShell, 'openExternal'>,
): Promise<void> {
  try {
    await shell.openExternal(buildVsCodeUri(projectPath))
    return
  } catch {
    const codeCommand =
      resolveExecutable('code.exe') ??
      resolveExecutable('code') ??
      resolveExecutable('code.cmd')

    if (!codeCommand) {
      throw new Error(
        'VS Code could not be opened. Install VS Code or add the `code` shell command.',
      )
    }

    launchExternalCommand(codeCommand, [projectPath], projectPath)
  }
}

function openInTerminal(projectPath: string): void {
  const windowsTerminal = resolveExecutable('wt.exe')
  if (windowsTerminal) {
    launchExternalCommand(windowsTerminal, ['-d', projectPath], projectPath)
    return
  }

  const shellCommand = resolveShellCommand()
  launchExternalCommand(shellCommand, buildShellArgs(shellCommand), projectPath)
}

export async function openProjectInTarget(
  target: ProjectOpenTarget,
  projectPath: string,
  shell: Pick<typeof electronShell, 'openPath' | 'openExternal'>,
): Promise<void> {
  const normalizedPath = normalizeProjectPath(projectPath)
  await assertProjectPathExists(normalizedPath)

  switch (target) {
    case 'explorer':
      await openInExplorer(normalizedPath, shell)
      return
    case 'vscode':
      await openInVsCode(normalizedPath, shell)
      return
    case 'terminal':
      openInTerminal(normalizedPath)
      return
  }
}

export async function getProjectGitOverview(
  projectPath: string,
): Promise<ProjectGitOverview> {
  const normalizedPath = normalizeProjectPath(projectPath)
  await assertProjectPathExists(normalizedPath)

  const repoRoot = await tryRunGit(
    ['-C', normalizedPath, 'rev-parse', '--show-toplevel'],
    normalizedPath,
  )

  if (!repoRoot) {
    return {
      projectPath: normalizedPath,
      isGitRepository: false,
      repoRoot: null,
      branch: null,
      stagedFiles: [],
      unstagedFiles: [],
      stagedTotals: {
        additions: 0,
        deletions: 0,
      },
      unstagedTotals: {
        additions: 0,
        deletions: 0,
      },
    }
  }

  const [branchName, detachedHead, statusOutput, stagedNumstatOutput, unstagedNumstatOutput] =
    await Promise.all([
      tryRunGit(['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], repoRoot),
      tryRunGit(['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], repoRoot),
      runGit(
        ['-C', repoRoot, 'status', '--short', '--untracked-files=all'],
        repoRoot,
      ),
      runGit(
        ['-C', repoRoot, 'diff', ...GIT_INTERNAL_DIFF_OPTIONS, '--cached', '--numstat'],
        repoRoot,
      ),
      runGit(
        ['-C', repoRoot, 'diff', ...GIT_INTERNAL_DIFF_OPTIONS, '--numstat'],
        repoRoot,
      ),
    ])

  const parsedStatus = parseGitStatus(statusOutput)
  const stagedFiles = toFileChanges(
    parsedStatus.staged,
    parseNumstat(stagedNumstatOutput),
    true,
  )
  const unstagedFiles = toFileChanges(
    parsedStatus.unstaged,
    parseNumstat(unstagedNumstatOutput),
    false,
  )

  return {
    projectPath: normalizedPath,
    isGitRepository: true,
    repoRoot,
    branch: branchName || detachedHead,
    stagedFiles,
    unstagedFiles,
    stagedTotals: calculateTotals(stagedFiles),
    unstagedTotals: calculateTotals(unstagedFiles),
  }
}

export async function getProjectGitDiff(
  projectPath: string,
  filePath: string,
  staged: boolean,
): Promise<ProjectGitDiff> {
  const normalizedPath = normalizeProjectPath(projectPath)
  const normalizedFilePath = filePath.trim()

  if (!normalizedFilePath) {
    throw new Error('A file path is required to load a git diff.')
  }

  await assertProjectPathExists(normalizedPath)

  const repoRoot = await runGit(
    ['-C', normalizedPath, 'rev-parse', '--show-toplevel'],
    normalizedPath,
  )
  const diffArgs = [
    '-C',
    repoRoot,
    'diff',
    ...GIT_INTERNAL_DIFF_OPTIONS,
    '--unified=3',
  ]
  if (staged) {
    diffArgs.push('--cached')
  }
  diffArgs.push('--', normalizedFilePath)

  const patch = await runGit(diffArgs, repoRoot)

  return {
    filePath: normalizedFilePath,
    staged,
    patch,
  }
}

export function getProjectDisplayName(projectPath: string): string {
  const normalizedPath = projectPath.trim().replace(/[\\/]+$/u, '')
  const pathParts = normalizedPath.split(/[\\/]/u).filter(Boolean)
  return pathParts.at(-1) ?? normalizedPath
}
