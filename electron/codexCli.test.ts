// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildCodexResumeCommand,
  extractCodexSessionMeta,
  supportsCodexSessionResume,
  tokenizeCommand,
} from './codexCli'

describe('codexCli', () => {
  it('tokenizes quoted commands without dropping spaced arguments', () => {
    expect(tokenizeCommand('codex -C "C:\\repo path" --profile dev'))
      .toEqual(['codex', '-C', 'C:\\repo path', '--profile', 'dev'])
  })

  it('recognizes interactive Codex commands as resumable', () => {
    expect(supportsCodexSessionResume('codex --profile dev')).toBe(true)
    expect(supportsCodexSessionResume('codex exec "review this diff"')).toBe(false)
  })

  it('builds a resume command while preserving global options', () => {
    expect(
      buildCodexResumeCommand(
        'codex -C "C:\\repo path" --profile dev',
        '019cdd85-2982-74c1-bb26-94119101b35c',
      ),
    ).toBe(
      'codex -C "C:\\repo path" --profile dev resume 019cdd85-2982-74c1-bb26-94119101b35c',
    )
  })

  it('extracts session metadata from the persisted Codex session prefix', () => {
    expect(
      extractCodexSessionMeta(
        '{"timestamp":"2026-03-11T15:33:58.860Z","type":"session_meta","payload":{"id":"019cdd85-2982-74c1-bb26-94119101b35c","timestamp":"2026-03-11T15:30:17.652Z","cwd":"C:\\\\Users\\\\hduan10\\\\Documents\\\\repo\\\\agenclis","originator":"codex_cli_rs"}}',
      ),
    ).toEqual({
      sessionId: '019cdd85-2982-74c1-bb26-94119101b35c',
      timestamp: '2026-03-11T15:30:17.652Z',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\agenclis',
    })
  })
})
