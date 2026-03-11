import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const FALLBACK_SHELL = 'powershell.exe'

export function parseWhereOutput(output: string): string | null {
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  return firstLine ?? null
}

function resolveExecutable(command: string): string | null {
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

export function buildShellArgs(): string[] {
  return ['-NoLogo']
}
