import { describe, expect, it } from 'vitest'

import { deriveSessionTitle, resolveSessionCwd, summarizeCommand } from './session'

describe('session helpers', () => {
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

  it('summarizes long commands without removing short ones', () => {
    expect(summarizeCommand('agent --profile dev')).toBe('agent --profile dev')
    expect(summarizeCommand('agent --profile dev --workspace E:\\repo\\very-long-path', 18))
      .toBe('agent --profile …')
  })
})
