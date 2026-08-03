// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildOpencodeResumeCommand,
  extractOpencodeSessionList,
  extractOpencodeSessionMeta,
  parseOpencodeJsonOutput,
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

  it('enables auto-approval for full-access without duplicating the flag', () => {
    expect(withOpencodeFullAccess('opencode --model m')).toBe(
      'opencode --model m --auto',
    )
    expect(withOpencodeFullAccess('opencode')).toBe('opencode --auto')
    expect(withOpencodeFullAccess('opencode --auto')).toBe('opencode --auto')
  })

  it('preserves auto-approval when building a resume command', () => {
    expect(buildOpencodeResumeCommand('opencode --auto', 'ses_abc123')).toBe(
      'opencode --auto --session ses_abc123',
    )
  })

  it('returns null from withOpencodeFullAccess for non-opencode commands', () => {
    expect(withOpencodeFullAccess('node index.js')).toBeNull()
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

  describe('parseOpencodeJsonOutput', () => {
    it('parses clean JSON output', () => {
      expect(parseOpencodeJsonOutput('[{"id":"ses_1"}]')).toEqual([
        { id: 'ses_1' },
      ])
      expect(parseOpencodeJsonOutput('  {"id":"ses_1"}  ')).toEqual({
        id: 'ses_1',
      })
    })

    it('tolerates a non-JSON preamble banner before the JSON array', () => {
      const stdout = [
        'Checking for proxy env variables...',
        'HTTP_PROXY=http://internet.ford.com:83/',
        'Proxy env vars detected, Bun will use those env vars for its configuration.',
        '[',
        '  { "id": "ses_133", "title": "Opencode support", "directory": "C:\\\\repo" }',
        ']',
      ].join('\n')

      expect(parseOpencodeJsonOutput(stdout)).toEqual([
        { id: 'ses_133', title: 'Opencode support', directory: 'C:\\repo' },
      ])
    })

    it('does not break on brackets inside string values', () => {
      const stdout =
        'banner line\n[{"id":"ses_1","title":"array [0] and obj {x}"}]'
      expect(parseOpencodeJsonOutput(stdout)).toEqual([
        { id: 'ses_1', title: 'array [0] and obj {x}' },
      ])
    })

    it('returns null when no JSON value is present', () => {
      expect(parseOpencodeJsonOutput('Checking for proxy env variables...')).toBeNull()
      expect(parseOpencodeJsonOutput('')).toBeNull()
    })

    it('lets extractOpencodeSessionMeta recover from a preamble banner', () => {
      const stdout = [
        'Checking for proxy env variables...',
        JSON.stringify({
          id: 'ses_xyz',
          title: 'Banner test',
          directory: 'C:\\repo',
          created: 1781539219552,
        }),
      ].join('\n')

      expect(extractOpencodeSessionMeta(stdout)).toEqual({
        sessionId: 'ses_xyz',
        timestamp: new Date(1781539219552).toISOString(),
        cwd: 'C:\\repo',
        summary: 'Banner test',
      })
    })
  })

  describe('extractOpencodeSessionList', () => {
    it('extracts the array from a resolved result', () => {
      expect(
        extractOpencodeSessionList({ stdout: '[{"id":"ses_1"},{"id":"ses_2"}]' }),
      ).toEqual([{ id: 'ses_1' }, { id: 'ses_2' }])
    })

    it('salvages stdout from a killed (timed out) query error', () => {
      // The opencode binary can print the full payload and then linger, which
      // trips execFile's timeout; the rejected error still carries stdout.
      const timeoutError = Object.assign(new Error('Command failed'), {
        killed: true,
        signal: 'SIGTERM',
        code: null,
        stdout: '[\n  { "id": "ses_133", "directory": "C:\\\\repo" }\n]\n',
        stderr: '',
      })

      expect(extractOpencodeSessionList(timeoutError)).toEqual([
        { id: 'ses_133', directory: 'C:\\repo' },
      ])
    })

    it('unwraps a { sessions: [...] } payload', () => {
      expect(
        extractOpencodeSessionList({ stdout: '{"sessions":[{"id":"ses_1"}]}' }),
      ).toEqual([{ id: 'ses_1' }])
    })

    it('wraps a single session object into an array', () => {
      expect(extractOpencodeSessionList({ stdout: '{"id":"ses_1"}' })).toEqual([
        { id: 'ses_1' },
      ])
    })

    it('returns an empty array when stdout is empty or missing', () => {
      expect(extractOpencodeSessionList({ stdout: '' })).toEqual([])
      expect(extractOpencodeSessionList({ stdout: 'no json here' })).toEqual([])
      expect(extractOpencodeSessionList({})).toEqual([])
      expect(extractOpencodeSessionList(null)).toEqual([])
      expect(extractOpencodeSessionList(undefined)).toEqual([])
    })
  })
})
