// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildCopilotResumeCommand,
  extractCopilotSessionMeta,
  supportsCopilotSessionResume,
  withCopilotAdditionalMcpConfig,
} from './copilotCli'

describe('copilotCli', () => {
  it('recognizes interactive Copilot commands as resumable', () => {
    expect(supportsCopilotSessionResume('copilot --model gpt-5.2')).toBe(true)
    expect(supportsCopilotSessionResume('copilot -p "review this diff"')).toBe(
      false,
    )
  })

  it('builds a resume command while preserving resume-safe options', () => {
    expect(
      buildCopilotResumeCommand(
        'copilot --model gpt-5.2 --allow-all -i "Fix this"',
        '938fdaf9-c35d-42ab-bca3-566ab3d91f79',
      ),
    ).toBe(
      'copilot --model gpt-5.2 --allow-all --resume 938fdaf9-c35d-42ab-bca3-566ab3d91f79',
    )
  })

  it('extracts session metadata from workspace.yaml', () => {
    expect(
      extractCopilotSessionMeta(
        [
          'id: 938fdaf9-c35d-42ab-bca3-566ab3d91f79',
          'cwd: C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
          'summary: Review ECG2 Callout Analysis',
          'created_at: 2026-03-11T17:15:35.021Z',
        ].join('\n'),
      ),
    ).toEqual({
      sessionId: '938fdaf9-c35d-42ab-bca3-566ab3d91f79',
      timestamp: '2026-03-11T17:15:35.021Z',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
      summary: 'Review ECG2 Callout Analysis',
    })
  })

  it('rejects non-copilot executables', () => {
    expect(supportsCopilotSessionResume('node index.js')).toBe(false)
    expect(supportsCopilotSessionResume('codex --model gpt')).toBe(false)
  })

  it('recognizes copilot.exe as executable', () => {
    expect(supportsCopilotSessionResume('C:\\tools\\copilot.exe --model gpt')).toBe(true)
  })

  it('rejects all non-interactive subcommands', () => {
    for (const sub of ['help', 'init', 'login', 'plugin', 'update', 'version']) {
      expect(supportsCopilotSessionResume(`copilot ${sub}`)).toBe(false)
    }
  })

  it('rejects non-interactive flags', () => {
    expect(supportsCopilotSessionResume('copilot --acp')).toBe(false)
    expect(supportsCopilotSessionResume('copilot --help')).toBe(false)
    expect(supportsCopilotSessionResume('copilot --version')).toBe(false)
    expect(supportsCopilotSessionResume('copilot --prompt "do X"')).toBe(false)
  })

  it('strips interactive prompt flag from resume command', () => {
    const result = buildCopilotResumeCommand(
      'copilot --model gpt -i "fix bug"',
      'sess-1',
    )
    expect(result).toBe('copilot --model gpt --resume sess-1')
  })

  it('strips existing resume/continue flags from resume command', () => {
    const result = buildCopilotResumeCommand(
      'copilot --model gpt --resume old-session',
      'new-session',
    )
    expect(result).toBe('copilot --model gpt --resume new-session')
  })

  it('preserves flag options in resume command', () => {
    const result = buildCopilotResumeCommand(
      'copilot --allow-all --no-color --model gpt',
      'sess-1',
    )
    expect(result).toBe('copilot --allow-all --no-color --model gpt --resume sess-1')
  })

  it('preserves multi-value options in resume command', () => {
    const result = buildCopilotResumeCommand(
      'copilot --add-dir dir1 dir2 --model gpt',
      'sess-1',
    )
    expect(result).toBe('copilot --add-dir dir1 dir2 --model gpt --resume sess-1')
  })

  it('handles inline option values (=)', () => {
    expect(supportsCopilotSessionResume('copilot --model=gpt-5.2')).toBe(true)
    const result = buildCopilotResumeCommand('copilot --model=gpt-5.2', 'sess-1')
    expect(result).toBe('copilot --model=gpt-5.2 --resume sess-1')
  })

  it('returns null for buildCopilotResumeCommand on non-copilot', () => {
    expect(buildCopilotResumeCommand('node index.js', 'sess-1')).toBeNull()
  })

  it('extractCopilotSessionMeta returns null for missing fields', () => {
    expect(extractCopilotSessionMeta('id: abc\ncwd: C:\\repo')).toBeNull()
    expect(extractCopilotSessionMeta('just random text')).toBeNull()
    expect(extractCopilotSessionMeta('')).toBeNull()
  })

  it('extractCopilotSessionMeta uses updated_at when created_at is missing', () => {
    const result = extractCopilotSessionMeta(
      'id: sess-1\ncwd: C:\\repo\nupdated_at: 2026-01-01T00:00:00Z',
    )
    expect(result).toEqual({
      sessionId: 'sess-1',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: 'C:\\repo',
      summary: undefined,
    })
  })

  it('extractCopilotSessionMeta omits summary when empty', () => {
    const result = extractCopilotSessionMeta(
      'id: sess-1\ncwd: C:\\repo\ncreated_at: 2026-01-01T00:00:00Z\nsummary:  ',
    )
    expect(result?.summary).toBeUndefined()
  })

  it('stops parsing at -- separator', () => {
    expect(supportsCopilotSessionResume('copilot --model gpt -- help')).toBe(true)
  })

  it('adds an additional MCP config to an interactive Copilot command', () => {
    const result = withCopilotAdditionalMcpConfig(
      'copilot --model gpt-5.2 --allow-all',
      'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\copilot-mcp\\abcd\\mempalace.json',
    )

    expect(result).toBe(
      'copilot --model gpt-5.2 --allow-all --additional-mcp-config @C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\copilot-mcp\\abcd\\mempalace.json',
    )
  })

  it('does not add an MCP config when MCP servers are explicitly disabled', () => {
    const command = 'copilot --model gpt-5.2 --disable-mcp-server github'
    expect(
      withCopilotAdditionalMcpConfig(
        command,
        'C:\\Users\\hduan10\\AppData\\Roaming\\agentclis\\copilot-mcp\\abcd\\mempalace.json',
      ),
    ).toBe(command)
  })
})
