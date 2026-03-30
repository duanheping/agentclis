import { createRequire } from 'node:module'

import type { SessionDataEvent, SessionExitMeta } from '../src/shared/session'
import { killTerminalProcessTree } from './ptyProcessTree'
import { resolveCommandPromptCommand } from './windowsShell'

type IPty = import('node-pty').IPty

const require = createRequire(import.meta.url)
const nodePty = require('node-pty') as typeof import('node-pty')

interface WindowsCommandPromptEvents {
  onData: (event: SessionDataEvent) => void
  onExit: (event: SessionExitMeta) => void
}

export class WindowsCommandPromptManager {
  private readonly prompts = new Map<string, IPty>()
  private readonly suppressedExit = new Set<string>()
  private readonly events: WindowsCommandPromptEvents

  constructor(events: WindowsCommandPromptEvents) {
    this.events = events
  }

  listOpenSessionIds(): string[] {
    return Array.from(this.prompts.keys())
  }

  open(sessionId: string, cwd: string): void {
    if (this.prompts.has(sessionId)) {
      return
    }

    const normalizedCwd = cwd.trim()
    if (!normalizedCwd) {
      throw new Error('A working directory is required to open Windows cmd.')
    }

    if (process.platform !== 'win32') {
      throw new Error('Windows cmd panes are only available on Windows.')
    }

    const prompt = nodePty.spawn(resolveCommandPromptCommand(), [], {
      name: 'xterm-color',
      cols: 120,
      rows: 14,
      cwd: normalizedCwd,
      useConpty: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    })

    this.prompts.set(sessionId, prompt)

    prompt.onData((chunk) => {
      this.events.onData({
        sessionId,
        chunk,
      })
    })

    prompt.onExit(({ exitCode }) => {
      this.prompts.delete(sessionId)

      if (this.suppressedExit.delete(sessionId)) {
        return
      }

      this.events.onExit({
        sessionId,
        exitCode,
      })
    })
  }

  close(sessionId: string): void {
    const prompt = this.prompts.get(sessionId)
    if (!prompt) {
      return
    }

    this.suppressedExit.add(sessionId)
    this.prompts.delete(sessionId)

    try {
      killTerminalProcessTree(prompt)
    } catch {
      this.suppressedExit.delete(sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    this.prompts.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const prompt = this.prompts.get(sessionId)
    if (!prompt || cols < 2 || rows < 1) {
      return
    }

    prompt.resize(Math.floor(cols), Math.floor(rows))
  }

  dispose(): void {
    for (const sessionId of Array.from(this.prompts.keys())) {
      this.close(sessionId)
    }
  }
}
