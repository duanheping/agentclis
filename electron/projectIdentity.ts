import { execFile } from 'node:child_process'
import path from 'node:path'

import type { ProjectIdentity } from '../src/shared/projectMemory'

const GIT_EXECUTABLE = 'git'

export interface ProjectLocationIdentity extends ProjectIdentity {
  rootPath: string
  label: string
}

function sanitizeRootPath(rootPath: string): string {
  const normalized = rootPath.trim()
  if (!normalized) {
    throw new Error('Project root path is required.')
  }

  return normalized.replace(/[\\/]+$/, '')
}

function deriveLocationLabel(rootPath: string): string {
  const normalized = sanitizeRootPath(rootPath)
  const lastSegment = path.basename(normalized)
  return lastSegment || normalized
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
      (error, stdout) => {
        if (error) {
          reject(error)
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

function normalizeRemotePathname(value: string): string {
  const withoutGitSuffix = value.replace(/\.git$/i, '')
  const normalizedSlashes = withoutGitSuffix.replace(/\\/g, '/')
  const trimmed = normalizedSlashes.replace(/^\/+|\/+$/g, '')
  return trimmed.toLowerCase()
}

export function normalizeRemoteFingerprint(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim()
  if (!normalized) {
    return null
  }

  try {
    const url = new URL(normalized)
    const host = url.hostname.trim().toLowerCase()
    const pathname = normalizeRemotePathname(url.pathname)
    if (!host || !pathname) {
      return null
    }

    return `${host}/${pathname}`
  } catch {
    const scpLikeMatch = normalized.match(
      /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u,
    )
    if (!scpLikeMatch) {
      return null
    }

    const host = scpLikeMatch[1]?.trim().toLowerCase()
    const pathname = normalizeRemotePathname(scpLikeMatch[2] ?? '')
    if (!host || !pathname) {
      return null
    }

    return `${host}/${pathname}`
  }
}

function resolveGitCommonDir(projectPath: string, gitCommonDir: string | null): string | null {
  if (!gitCommonDir) {
    return null
  }

  return path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(projectPath, gitCommonDir)
}

export class ProjectIdentityResolver {
  async inspect(rootPath: string): Promise<ProjectLocationIdentity> {
    const normalizedRootPath = sanitizeRootPath(rootPath)
    const repoRoot = await tryRunGit(
      ['-C', normalizedRootPath, 'rev-parse', '--show-toplevel'],
      normalizedRootPath,
    )
    const gitCommonDir = repoRoot
      ? resolveGitCommonDir(
          repoRoot,
          await tryRunGit(
            ['-C', normalizedRootPath, 'rev-parse', '--git-common-dir'],
            normalizedRootPath,
          ),
        )
      : null
    const remoteUrl = repoRoot
      ? await tryRunGit(
          ['-C', normalizedRootPath, 'config', '--get', 'remote.origin.url'],
          normalizedRootPath,
        )
      : null

    return {
      rootPath: normalizedRootPath,
      label: deriveLocationLabel(normalizedRootPath),
      repoRoot: repoRoot ?? null,
      gitCommonDir,
      remoteFingerprint: remoteUrl ? normalizeRemoteFingerprint(remoteUrl) : null,
    }
  }
}
