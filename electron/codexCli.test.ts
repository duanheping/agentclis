// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildCodexResumeCommand,
  extractCodexSessionMeta,
  supportsCodexSessionResume,
  tokenizeCommand,
  withCodexDangerousBypass,
  withCodexDeveloperInstructions,
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
        '{"timestamp":"2026-03-11T15:33:58.860Z","type":"session_meta","payload":{"id":"019cdd85-2982-74c1-bb26-94119101b35c","timestamp":"2026-03-11T15:30:17.652Z","cwd":"C:\\\\Users\\\\hduan10\\\\Documents\\\\repo\\\\agenclis","originator":"codex_cli_rs","source":"cli"}}',
      ),
    ).toEqual({
      sessionId: '019cdd85-2982-74c1-bb26-94119101b35c',
      timestamp: '2026-03-11T15:30:17.652Z',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\agenclis',
      originator: 'codex_cli_rs',
      source: 'cli',
    })
  })

  it('tokenizes single-quoted arguments', () => {
    expect(tokenizeCommand("codex -C 'path with spaces' --model gpt"))
      .toEqual(['codex', '-C', 'path with spaces', '--model', 'gpt'])
  })

  it('tokenizes escaped double quotes inside double quotes', () => {
    expect(tokenizeCommand('codex "say \\"hello\\"" done'))
      .toEqual(['codex', 'say "hello"', 'done'])
  })

  it('tokenizes empty string to empty array', () => {
    expect(tokenizeCommand('')).toEqual([])
    expect(tokenizeCommand('   ')).toEqual([])
  })

  it('tokenizes command with no quotes', () => {
    expect(tokenizeCommand('codex --model gpt'))
      .toEqual(['codex', '--model', 'gpt'])
  })

  it('handles unclosed quotes gracefully', () => {
    expect(tokenizeCommand('codex "unclosed')).toEqual(['codex', 'unclosed'])
  })

  it('recognizes all non-interactive subcommands', () => {
    for (const sub of ['exec', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'cloud', 'features', 'help']) {
      expect(supportsCodexSessionResume(`codex ${sub}`)).toBe(false)
    }
  })

  it('treats resume and fork subcommands as interactive', () => {
    expect(supportsCodexSessionResume('codex resume abc-123')).toBe(true)
    expect(supportsCodexSessionResume('codex fork abc-123')).toBe(true)
  })

  it('treats bare codex without subcommand as interactive', () => {
    expect(supportsCodexSessionResume('codex')).toBe(true)
  })

  it('rejects non-codex executables', () => {
    expect(supportsCodexSessionResume('node index.js')).toBe(false)
    expect(supportsCodexSessionResume('copilot --model gpt')).toBe(false)
  })

  it('recognizes codex.exe as executable', () => {
    expect(supportsCodexSessionResume('C:\\tools\\codex.exe --model gpt')).toBe(true)
  })

  it('preserves global flags in resume command', () => {
    expect(
      buildCodexResumeCommand('codex --oss --full-auto --model gpt', 'sess-1'),
    ).toBe('codex --oss --full-auto --model gpt resume sess-1')
  })

  it('rewrites full-auto sessions to the true bypass flag', () => {
    expect(
      withCodexDangerousBypass('codex --oss --full-auto --model gpt'),
    ).toBe(
      'codex --oss --model gpt --dangerously-bypass-approvals-and-sandbox',
    )
  })

  it('inserts the bypass flag before resume arguments', () => {
    expect(
      withCodexDangerousBypass('codex resume sess-1'),
    ).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox resume sess-1',
    )
  })

  it('stops parsing at -- separator', () => {
    expect(supportsCodexSessionResume('codex --model gpt -- exec')).toBe(true)
  })

  it('returns null for buildCodexResumeCommand on non-codex command', () => {
    expect(buildCodexResumeCommand('node server.js', 'sess-1')).toBeNull()
  })

  it('extractCodexSessionMeta returns null for non-matching content', () => {
    expect(extractCodexSessionMeta('random text without session meta')).toBeNull()
    expect(extractCodexSessionMeta('{}')).toBeNull()
  })

  it('extractCodexSessionMeta omits originator/source when absent', () => {
    const content = '{"type":"session_meta","payload":{"id":"abc","timestamp":"2026-01-01T00:00:00Z","cwd":"C:\\\\repo"}}'
    const result = extractCodexSessionMeta(content)
    expect(result).toEqual({
      sessionId: 'abc',
      timestamp: '2026-01-01T00:00:00Z',
      cwd: 'C:\\repo',
      originator: undefined,
      source: undefined,
    })
  })

  it('injects developer_instructions into a simple codex command', () => {
    expect(withCodexDeveloperInstructions('codex', 'Remember TypeScript')).toBe(
      'codex -c "developer_instructions=Remember TypeScript"',
    )
  })

  it('handles memory text with double quotes', () => {
    const result = withCodexDeveloperInstructions('codex --model gpt', 'He said "hi"')
    expect(result).toContain('developer_instructions=')
    expect(result).not.toBeNull()
    // The result should be a properly quoted command — tokenize it to verify
    const tokens = tokenizeCommand(result!)
    const configIndex = tokens.indexOf('-c')
    expect(configIndex).toBeGreaterThan(-1)
    expect(tokens[configIndex + 1]).toBe('developer_instructions=He said "hi"')
  })

  it('handles memory text with newlines', () => {
    const result = withCodexDeveloperInstructions('codex', 'line1\nline2')
    expect(result).not.toBeNull()
    const tokens = tokenizeCommand(result!)
    const configIndex = tokens.indexOf('-c')
    expect(tokens[configIndex + 1]).toContain('line1\nline2')
  })

  it('preserves quoted executable paths in developer_instructions', () => {
    const result = withCodexDeveloperInstructions(
      '"C:\\Program Files\\codex.exe" --model gpt',
      'test memory',
    )
    expect(result).not.toBeNull()
    const tokens = tokenizeCommand(result!)
    expect(tokens[0]).toBe('C:\\Program Files\\codex.exe')
  })

  it('replaces existing developer_instructions', () => {
    const result = withCodexDeveloperInstructions(
      'codex -c developer_instructions=old --model gpt',
      'new memory',
    )
    expect(result).not.toBeNull()
    const tokens = tokenizeCommand(result!)
    const configPairs = tokens.reduce((acc, token, i) => {
      if (token === '-c' && tokens[i + 1]?.startsWith('developer_instructions=')) {
        acc.push(tokens[i + 1])
      }
      return acc
    }, [] as string[])
    expect(configPairs).toHaveLength(1)
    expect(configPairs[0]).toBe('developer_instructions=new memory')
  })

  it('returns null for non-codex commands', () => {
    expect(withCodexDeveloperInstructions('node index.js', 'memory')).toBeNull()
  })
})
