// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { parseWhereOutput, resolveShellCommand } from './windowsShell'

describe('windowsShell', () => {
  it('parses the first executable from where.exe output', () => {
    expect(parseWhereOutput('C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\nC:\\backup\\pwsh.exe'))
      .toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })

  it('falls back to powershell when the preferred command is missing', () => {
    expect(resolveShellCommand('this-command-does-not-exist.exe').toLowerCase())
      .toContain('powershell.exe')
  })
})
