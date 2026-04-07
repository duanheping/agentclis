// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildShellArgs,
  parseWhereOutput,
  resolveCommandPromptCommand,
  resolveShellCommand,
  supportsInlineShellCommand,
} from './windowsShell'

describe('windowsShell', () => {
  it('parses the first executable from where.exe output', () => {
    expect(parseWhereOutput('C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\nC:\\backup\\pwsh.exe'))
      .toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('falls back to powershell when the preferred command is missing', () => {
    expect(resolveShellCommand('this-command-does-not-exist.exe').toLowerCase())
      .toMatch(/(pwsh|powershell)\.exe$/)
  })

  it('resolves a Windows command prompt executable', () => {
    expect(resolveCommandPromptCommand().toLowerCase()).toMatch(/cmd\.exe$/)
  })

  it('builds inline PowerShell launch arguments for startup commands', () => {
    const encoded = Buffer.from('codex resume 123', 'utf16le').toString('base64')
    expect(buildShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'codex resume 123'))
      .toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', encoded])
  })

  it('builds inline command prompt launch arguments for startup commands', () => {
    expect(buildShellArgs('C:\\Windows\\System32\\cmd.exe', 'codex resume 123'))
      .toEqual(['/Q', '/K', 'codex resume 123'])
  })

  it('reports whether the shell supports inline startup commands', () => {
    expect(supportsInlineShellCommand('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
      .toBe(true)
    expect(supportsInlineShellCommand('C:\\Windows\\System32\\cmd.exe'))
      .toBe(true)
    expect(supportsInlineShellCommand('C:\\custom\\bash.exe')).toBe(false)
  })

  it('parseWhereOutput returns null for empty input', () => {
    expect(parseWhereOutput('')).toBeNull()
    expect(parseWhereOutput('\n\r\n  ')).toBeNull()
  })

  it('parseWhereOutput trims leading whitespace', () => {
    expect(parseWhereOutput('  C:\\Program Files\\pwsh.exe\r\n'))
      .toBe('C:\\Program Files\\pwsh.exe')
  })

  it('buildShellArgs returns -NoLogo for pwsh without startup command', () => {
    expect(buildShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe'))
      .toEqual(['-NoLogo'])
  })

  it('buildShellArgs returns empty for cmd without startup command', () => {
    expect(buildShellArgs('C:\\Windows\\System32\\cmd.exe'))
      .toEqual([])
  })

  it('buildShellArgs returns -NoLogo for powershell.exe without startup command', () => {
    expect(buildShellArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
      .toEqual(['-NoLogo'])
  })

  it('buildShellArgs handles whitespace-only startup command as no command', () => {
    expect(buildShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', '   '))
      .toEqual(['-NoLogo'])
  })

  it('buildShellArgs handles powershell.exe with startup command', () => {
    const encoded = Buffer.from('codex', 'utf16le').toString('base64')
    expect(buildShellArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'codex'))
      .toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', encoded])
  })

  it('buildShellArgs with EncodedCommand preserves backticks in memory text', () => {
    const cmd = 'codex -c "developer_instructions=Cast `unknown` to type"'
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64')
    expect(buildShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', cmd))
      .toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', encoded])
  })

  it('buildShellArgs returns -NoLogo for unknown shell with startup command', () => {
    expect(buildShellArgs('C:\\custom\\bash.exe', 'some cmd'))
      .toEqual(['-NoLogo'])
  })

  it('supportsInlineShellCommand is case-insensitive on shell path', () => {
    expect(supportsInlineShellCommand('C:\\WINDOWS\\System32\\CMD.EXE'))
      .toBe(true)
    expect(supportsInlineShellCommand('C:\\PROGRAM FILES\\POWERSHELL\\7\\PWSH.EXE'))
      .toBe(true)
  })
})
