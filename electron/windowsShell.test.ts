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
    expect(buildShellArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'codex resume 123'))
      .toEqual(['-NoLogo', '-NoExit', '-Command', 'codex resume 123'])
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
})
