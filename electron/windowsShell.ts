import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const FALLBACK_COMMAND_PROMPT = 'cmd.exe'
const FALLBACK_SHELL = 'powershell.exe'

export function parseWhereOutput(output: string): string | null {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return firstLine ?? null
}

export function resolveExecutable(command: string): string | null {
  const result = spawnSync('where.exe', [command], {
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.status !== 0) {
    return null
  }

  return parseWhereOutput(result.stdout)
}

export function resolveShellCommand(preferredShell?: string): string {
  if (preferredShell?.trim()) {
    const normalized = preferredShell.trim()
    if (normalized.includes('\\') || normalized.includes('/')) {
      if (existsSync(normalized)) {
        return normalized
      }
    } else {
      const resolvedPreferred = resolveExecutable(normalized)
      if (resolvedPreferred) {
        return resolvedPreferred
      }
    }
  }

  const pwsh = resolveExecutable('pwsh.exe')
  if (pwsh) {
    return pwsh
  }

  const fallback = resolveExecutable(FALLBACK_SHELL)
  return fallback ?? path.join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    FALLBACK_SHELL,
  )
}

export function resolveCommandPromptCommand(): string {
  const resolvedCommandPrompt = resolveExecutable(FALLBACK_COMMAND_PROMPT)
  if (resolvedCommandPrompt) {
    return resolvedCommandPrompt
  }

  const comSpec = process.env.ComSpec?.trim()
  if (comSpec && existsSync(comSpec)) {
    return comSpec
  }

  return path.join(
    process.env.WINDIR ?? 'C:\\Windows',
    'System32',
    FALLBACK_COMMAND_PROMPT,
  )
}

function getShellBasename(shellCommand: string): string {
  return path.basename(shellCommand).toLowerCase()
}

export function supportsInlineShellCommand(shellCommand: string): boolean {
  const basename = getShellBasename(shellCommand)
  return (
    basename === 'pwsh.exe' ||
    basename === 'powershell.exe' ||
    basename === 'cmd.exe'
  )
}

export function buildShellArgs(
  shellCommand: string,
  startupCommand?: string,
): string[] {
  const basename = getShellBasename(shellCommand)

  if (!startupCommand?.trim()) {
    return basename === 'cmd.exe' ? [] : ['-NoLogo']
  }

  if (basename === 'pwsh.exe' || basename === 'powershell.exe') {
    const encoded = Buffer.from(startupCommand, 'utf16le').toString('base64')
    return ['-NoLogo', '-NoExit', '-EncodedCommand', encoded]
  }

  if (basename === 'cmd.exe') {
    return ['/Q', '/K', startupCommand]
  }

  return basename === 'cmd.exe' ? [] : ['-NoLogo']
}
