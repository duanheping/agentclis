import { describe, expect, it } from 'vitest'

import {
  buildRuntime,
  deriveProjectTitle,
  deriveSessionTitle,
  resolveProjectRoot,
  resolveSessionCwd,
  summarizeCommand,
} from './session'

describe('session helpers', () => {
  it('derives the project title from the root path when title is empty', () => {
    expect(deriveProjectTitle('', 'E:\\repo\\workspace')).toBe('workspace')
  })

  it('prefers a manual title when provided', () => {
    expect(deriveSessionTitle('Agent Alpha', 'agent --profile dev', 'E:\\repo'))
      .toBe('Agent Alpha')
  })

  it('derives the title from the startup command when title is empty', () => {
    expect(deriveSessionTitle('', 'agent --profile dev', 'E:\\repo'))
      .toBe('agent')
  })

  it('falls back to the cwd name when the command is blank', () => {
    expect(deriveSessionTitle(undefined, '   ', 'E:\\repo\\workspace'))
      .toBe('workspace')
  })

  it('resolves an optional cwd against a fallback directory', () => {
    expect(resolveSessionCwd(undefined, 'C:\\Users\\Shiyu')).toBe('C:\\Users\\Shiyu')
    expect(resolveSessionCwd('  E:\\repo\\project  ', 'C:\\Users\\Shiyu'))
      .toBe('E:\\repo\\project')
  })

  it('resolves an optional project root against a fallback directory', () => {
    expect(resolveProjectRoot(undefined, 'C:\\Users\\Shiyu')).toBe('C:\\Users\\Shiyu')
    expect(resolveProjectRoot('  E:\\repo\\project  ', 'C:\\Users\\Shiyu'))
      .toBe('E:\\repo\\project')
  })

  it('summarizes long commands without removing short ones', () => {
    expect(summarizeCommand('agent --profile dev')).toBe('agent --profile dev')
    expect(summarizeCommand('agent --profile dev --workspace E:\\repo\\very-long-path', 18))
      .toBe('agent --profile …')
  })

  it('derives project title from Unix-style path', () => {
    expect(deriveProjectTitle(undefined, '/home/user/projects/myapp')).toBe('myapp')
  })

  it('falls back to New Project for empty root path parts', () => {
    expect(deriveProjectTitle('', '')).toBe('New Project')
    expect(deriveProjectTitle(undefined, '/')).toBe('New Project')
  })

  it('strips trailing slashes before extracting project title', () => {
    expect(deriveProjectTitle(undefined, 'C:\\repo\\workspace\\\\')).toBe('workspace')
    expect(deriveProjectTitle(undefined, '/home/user/project//')).toBe('project')
  })

  it('trims whitespace-only title to empty and falls back to path', () => {
    expect(deriveProjectTitle('   ', 'C:\\repo\\workspace')).toBe('workspace')
  })

  it('falls back to New Session for empty session cwd', () => {
    expect(deriveSessionTitle(undefined, '', '')).toBe('New Session')
    expect(deriveSessionTitle(undefined, '   ', '/')).toBe('New Session')
  })

  it('derives session title from multi-word command', () => {
    expect(deriveSessionTitle('', 'npx codex --profile dev', 'C:\\repo')).toBe('npx')
  })

  it('resolveSessionCwd returns trimmed cwd when provided', () => {
    expect(resolveSessionCwd('  D:\\work  ', 'C:\\default')).toBe('D:\\work')
  })

  it('resolveProjectRoot returns trimmed root when provided', () => {
    expect(resolveProjectRoot('  D:\\work  ', 'C:\\default')).toBe('D:\\work')
  })

  it('summarizeCommand normalizes internal whitespace', () => {
    expect(summarizeCommand('agent   --profile   dev')).toBe('agent --profile dev')
  })

  it('summarizeCommand breaks at word boundary when possible', () => {
    const result = summarizeCommand('agent --profile super-long-name --opt value', 30)
    expect(result).toContain('…')
    expect(result.length).toBeLessThanOrEqual(32)
  })

  it('summarizeCommand hard-cuts when no good break point', () => {
    const result = summarizeCommand('abcdefghijklmnopqrstuvwxyz1234567890abcdefghij', 10)
    expect(result).toBe('abcdefghi…')
  })

  it('summarizeCommand returns empty string for empty input', () => {
    expect(summarizeCommand('')).toBe('')
    expect(summarizeCommand('   ')).toBe('')
  })

  it('buildRuntime creates a runtime with correct defaults', () => {
    const runtime = buildRuntime('test-session')
    expect(runtime.sessionId).toBe('test-session')
    expect(runtime.status).toBe('exited')
    expect(runtime.attention).toBeNull()
    expect(runtime.lastActiveAt).toBeTruthy()
  })

  it('buildRuntime accepts a custom status', () => {
    const runtime = buildRuntime('test-session', 'running')
    expect(runtime.status).toBe('running')
  })
})
