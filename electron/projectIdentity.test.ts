// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFileImpl: vi.fn(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (command !== 'git') {
        callback(new Error(`Unexpected command: ${command}`), '', '')
        return
      }

      const commandLine = args.join(' ')

      if (commandLine.includes('rev-parse --show-toplevel')) {
        callback(null, 'C:\\repo\\main-copy\n', '')
        return
      }

      if (commandLine.includes('rev-parse --git-common-dir')) {
        callback(null, '.git\n', '')
        return
      }

      if (commandLine.includes('config --get remote.origin.url')) {
        callback(null, 'git@github.com:openai/agenclis.git\n', '')
        return
      }

      callback(new Error(`Unexpected git args: ${commandLine}`), '', '')
    },
  ),
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.execFileImpl,
}))

import {
  normalizeRemoteFingerprint,
  ProjectIdentityResolver,
} from './projectIdentity'

describe('projectIdentity', () => {
  beforeEach(() => {
    mocks.execFileImpl.mockClear()
  })

  it('normalizes SSH and HTTPS remotes into a stable fingerprint', () => {
    expect(normalizeRemoteFingerprint('git@github.com:OpenAI/agenclis.git')).toBe(
      'github.com/openai/agenclis',
    )
    expect(
      normalizeRemoteFingerprint('https://token@github.com/OpenAI/agenclis.git'),
    ).toBe('github.com/openai/agenclis')
    expect(normalizeRemoteFingerprint('ssh://git@github.com/OpenAI/agenclis.git')).toBe(
      'github.com/openai/agenclis',
    )
  })

  it('inspects repo identity data for a project root', async () => {
    const resolver = new ProjectIdentityResolver()

    await expect(resolver.inspect('C:\\repo\\main-copy')).resolves.toEqual({
      rootPath: 'C:\\repo\\main-copy',
      label: 'main-copy',
      repoRoot: 'C:\\repo\\main-copy',
      gitCommonDir: 'C:\\repo\\main-copy\\.git',
      remoteFingerprint: 'github.com/openai/agenclis',
    })
  })

  it('normalizes HTTPS remote URLs with tokens', () => {
    expect(normalizeRemoteFingerprint('https://x-access-token:ghs_abc@github.com/org/repo.git'))
      .toBe('github.com/org/repo')
  })

  it('normalizes ssh:// remote URLs', () => {
    expect(normalizeRemoteFingerprint('ssh://git@github.com/org/repo.git'))
      .toBe('github.com/org/repo')
  })

  it('returns null for empty or whitespace remote URLs', () => {
    expect(normalizeRemoteFingerprint('')).toBeNull()
    expect(normalizeRemoteFingerprint('   ')).toBeNull()
  })

  it('returns null for malformed URLs without host', () => {
    expect(normalizeRemoteFingerprint('just-a-string')).toBeNull()
  })

  it('strips .git suffix case insensitively', () => {
    expect(normalizeRemoteFingerprint('git@github.com:Org/Repo.GIT'))
      .toBe('github.com/org/repo')
  })

  it('normalizes backslashes in SCP paths', () => {
    expect(normalizeRemoteFingerprint('git@github.com:org\\repo.git'))
      .toBe('github.com/org/repo')
  })

  it('handles HTTPS URLs without .git suffix', () => {
    expect(normalizeRemoteFingerprint('https://github.com/org/repo'))
      .toBe('github.com/org/repo')
  })

  it('lowercases both host and path', () => {
    expect(normalizeRemoteFingerprint('https://GitHub.COM/ORG/REPO.git'))
      .toBe('github.com/org/repo')
  })

  it('handles Azure DevOps style URLs', () => {
    const result = normalizeRemoteFingerprint('https://dev.azure.com/org/project/_git/repo')
    expect(result).toBe('dev.azure.com/org/project/_git/repo')
  })

  it('returns null for SCP-like URL with no pathname', () => {
    expect(normalizeRemoteFingerprint('git@github.com:')).toBeNull()
  })
})
