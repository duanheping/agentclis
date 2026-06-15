// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildOpencodeResumeCommand,
  extractOpencodeSessionMeta,
  supportsOpencodeSessionResume,
  withOpencodeFullAccess,
} from './opencodeCli'

describe('opencodeCli', () => {
  it('recognizes interactive opencode commands as resumable', () => {
    expect(supportsOpencodeSessionResume('opencode')).toBe(true)
    expect(supportsOpencodeSessionResume('opencode --model anthropic/claude')).toBe(
      true,
    )
  })

  it('rejects non-interactive subcommands', () => {
    for (const sub of ['run', 'serve', 'web', 'auth', 'models', 'session', 'upgrade']) {
      expect(supportsOpencodeSessionResume(`opencode ${sub}`)).toBe(false)
    }
  })

  it('rejects non-interactive flags', () => {
    expect(supportsOpencodeSessionResume('opencode --help')).toBe(false)
    expect(supportsOpencodeSessionResume('opencode --version')).toBe(false)
  })

  it('builds a resume command while preserving resume-safe options', () => {
    expect(
      buildOpencodeResumeCommand(
        'opencode --model anthropic/claude',
        'ses_abc123',
      ),
    ).toBe('opencode --model anthropic/claude --session ses_abc123')
  })

  it('strips existing session/continue flags from resume command', () => {
    expect(
      buildOpencodeResumeCommand('opencode --session old --model m', 'new'),
    ).toBe('opencode --model m --session new')
    expect(buildOpencodeResumeCommand('opencode -c', 'new')).toBe(
      'opencode --session new',
    )
  })

  it('adds full-access flag when requested', () => {
    expect(withOpencodeFullAccess('opencode --model m')).toBe(
      'opencode --model m --dangerously-skip-permissions',
    )
  })

  it('does not duplicate an existing full-access flag', () => {
    expect(
      withOpencodeFullAccess('opencode --dangerously-skip-permissions'),
    ).toBe('opencode --dangerously-skip-permissions')
  })

  it('rejects non-opencode executables', () => {
    expect(supportsOpencodeSessionResume('node index.js')).toBe(false)
    expect(supportsOpencodeSessionResume('codex --model gpt')).toBe(false)
    expect(buildOpencodeResumeCommand('node index.js', 'ses-1')).toBeNull()
  })

  it('recognizes opencode.exe as executable', () => {
    expect(
      supportsOpencodeSessionResume('C:\\tools\\opencode.exe --model m'),
    ).toBe(true)
  })

  it('extracts session metadata from a single session record', () => {
    expect(
      extractOpencodeSessionMeta(
        JSON.stringify({
          id: 'ses_abc123',
          title: 'Add opencode support',
          directory: 'C:\\Users\\hduan10\\Documents\\repo\\agentclis_2',
          time: { created: 1700000000000 },
        }),
      ),
    ).toEqual({
      sessionId: 'ses_abc123',
      timestamp: new Date(1700000000000).toISOString(),
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\agentclis_2',
      summary: 'Add opencode support',
    })
  })

  it('extracts session metadata from the first entry of an array', () => {
    const result = extractOpencodeSessionMeta(
      JSON.stringify([
        {
          id: 'ses_first',
          directory: '/home/user/project',
          time: { created: '2026-01-01T00:00:00Z' },
        },
        { id: 'ses_second' },
      ]),
    )
    expect(result).toEqual({
      sessionId: 'ses_first',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: '/home/user/project',
      summary: undefined,
    })
  })

  it('returns null when required fields are missing or invalid JSON', () => {
    expect(extractOpencodeSessionMeta('not json')).toBeNull()
    expect(
      extractOpencodeSessionMeta(JSON.stringify({ id: 'ses_x' })),
    ).toBeNull()
  })
})
