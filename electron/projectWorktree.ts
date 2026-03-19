import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const GIT_EXECUTABLE = 'git'
const WORKTREE_ROOT = path.join(os.homedir(), '.codex', 'worktrees')
const SEGMENT_LIMIT = 48
const BRANCH_PREFIX = 'agenclis'

interface CreateProjectSessionWorktreeInput {
  projectRootPath: string
  sessionId: string
  createdAt: string
}

interface ProjectSessionWorktree {
  branchName: string
  cwd: string
}

function buildGitErrorMessage(error: unknown, stderr: string): string {
  const details = stderr.trim()
  if (details) {
    return details
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  return 'Git command failed.'
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      GIT_EXECUTABLE,
      args,
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(buildGitErrorMessage(error, stderr)))
          return
        }

        resolve(stdout.trim())
      },
    )
  })
}

async function tryRunGit(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGit(args, cwd)
  } catch {
    return null
  }
}

function sanitizeGitNameSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, SEGMENT_LIMIT)
    .replace(/[._-]+$/g, '')

  return normalized || fallback
}

function buildTimestampSegment(createdAt: string): string {
  const timestamp = new Date(createdAt)
  const source = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp

  const year = source.getUTCFullYear()
  const month = `${source.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${source.getUTCDate()}`.padStart(2, '0')
  const hours = `${source.getUTCHours()}`.padStart(2, '0')
  const minutes = `${source.getUTCMinutes()}`.padStart(2, '0')
  const seconds = `${source.getUTCSeconds()}`.padStart(2, '0')

  return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

export async function createProjectSessionWorktree({
  projectRootPath,
  sessionId,
  createdAt,
}: CreateProjectSessionWorktreeInput): Promise<ProjectSessionWorktree> {
  const sourceRoot = await tryRunGit(
    ['-C', projectRootPath, 'rev-parse', '--show-toplevel'],
    projectRootPath,
  )
  if (!sourceRoot) {
    throw new Error(
      'Git worktrees require the project root to be inside a git repository.',
    )
  }

  const repoName = sanitizeGitNameSegment(path.basename(sourceRoot), 'workspace')
  const branchBase =
    (await tryRunGit(
      ['-C', projectRootPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
      projectRootPath,
    )) ??
    (await tryRunGit(
      ['-C', projectRootPath, 'rev-parse', '--short', 'HEAD'],
      projectRootPath,
    )) ??
    repoName
  const branchSegment = sanitizeGitNameSegment(branchBase, repoName)
  const sessionSegment = sanitizeGitNameSegment(sessionId.slice(0, 8), 'session')
  const timestampSegment = buildTimestampSegment(createdAt)
  const branchName = `${BRANCH_PREFIX}/${branchSegment}/${timestampSegment}-${sessionSegment}`
  const worktreeParent = path.join(WORKTREE_ROOT, repoName)
  const cwd = path.join(worktreeParent, `${timestampSegment}-${sessionSegment}`)

  await mkdir(worktreeParent, { recursive: true })
  await runGit(
    ['-C', sourceRoot, 'worktree', 'add', '-b', branchName, cwd, 'HEAD'],
    sourceRoot,
  )

  return {
    branchName,
    cwd,
  }
}
