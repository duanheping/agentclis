import { spawnSync } from 'node:child_process'

export interface PseudoTerminalProcess {
  pid?: number
  kill(): void
}

export function killTerminalProcessTree(
  terminal: PseudoTerminalProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    platform === 'win32' &&
    typeof terminal.pid === 'number' &&
    Number.isInteger(terminal.pid) &&
    terminal.pid > 0
  ) {
    const result = spawnSync(
      'taskkill.exe',
      ['/PID', String(terminal.pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )

    if (!result.error && result.status === 0) {
      return
    }
  }

  terminal.kill()
}
