import { createRequire } from 'node:module'
import os from 'node:os'

import Store from 'electron-store'

import {
  buildRuntime,
  deriveSessionTitle,
  resolveSessionCwd,
  type CreateSessionInput,
  type ListSessionsResponse,
  type SessionCloseResult,
  type SessionConfig,
  type SessionDataEvent,
  type SessionExitMeta,
  type SessionRuntime,
  type SessionRuntimeEvent,
  type SessionSnapshot,
} from '../src/shared/session'
import { buildShellArgs, resolveShellCommand } from './windowsShell'

type IPty = import('node-pty').IPty

const require = createRequire(import.meta.url)
const nodePty = require('node-pty') as typeof import('node-pty')

interface PersistedSessionState {
  sessions: SessionConfig[]
  activeSessionId: string | null
}

interface SessionManagerEvents {
  onData: (event: SessionDataEvent) => void
  onRuntime: (event: SessionRuntimeEvent) => void
  onExit: (event: SessionExitMeta) => void
}

export class SessionManager {
  private readonly store = new Store<PersistedSessionState>({
    name: 'agenclis-sessions',
    defaults: {
      sessions: [],
      activeSessionId: null,
    },
  })

  private readonly configs = new Map<string, SessionConfig>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly terminals = new Map<string, IPty>()
  private readonly suppressedExit = new Set<string>()
  private readonly events: SessionManagerEvents

  private activeSessionId: string | null
  private restored = false

  constructor(events: SessionManagerEvents) {
    this.events = events
    const persisted = this.store.store
    this.activeSessionId = persisted.activeSessionId

    for (const config of persisted.sessions) {
      this.configs.set(config.id, config)
      this.runtimes.set(config.id, buildRuntime(config.id))
    }

    if (this.activeSessionId && !this.configs.has(this.activeSessionId)) {
      this.activeSessionId = this.getOrderedConfigs()[0]?.id ?? null
      this.persist()
    }
  }

  listSessions(): ListSessionsResponse {
    return {
      sessions: this.getOrderedConfigs().map((config) => this.snapshotFor(config.id)),
      activeSessionId: this.activeSessionId,
    }
  }

  async restoreSessions(): Promise<ListSessionsResponse> {
    if (!this.restored) {
      this.restored = true
      for (const config of this.getOrderedConfigs()) {
        await this.startSession(config)
      }
    }

    return this.listSessions()
  }

  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    const shell = resolveShellCommand()
    const cwd = resolveSessionCwd(input.cwd, os.homedir())

    const config: SessionConfig = {
      id,
      title: deriveSessionTitle(input.title, input.startupCommand, cwd),
      startupCommand: input.startupCommand.trim(),
      cwd,
      shell,
      createdAt: now,
      updatedAt: now,
    }

    this.configs.set(id, config)
    this.runtimes.set(id, buildRuntime(id))
    this.activeSessionId = id
    this.persist()

    await this.startSession(config)
    return this.snapshotFor(id)
  }

  renameSession(id: string, title: string): SessionSnapshot {
    const config = this.requireConfig(id)
    const nextTitle = deriveSessionTitle(title, config.startupCommand, config.cwd)
    const nextConfig: SessionConfig = {
      ...config,
      title: nextTitle,
      updatedAt: new Date().toISOString(),
    }

    this.configs.set(id, nextConfig)
    this.persist()
    return this.snapshotFor(id)
  }

  activateSession(id: string): void {
    this.requireConfig(id)
    this.activeSessionId = id
    this.touchRuntime(id)
    this.persist()
  }

  async restartSession(id: string): Promise<SessionSnapshot> {
    const config = this.requireConfig(id)
    await this.startSession(config)
    return this.snapshotFor(id)
  }

  closeSession(id: string): SessionCloseResult {
    const orderedIds = this.getOrderedConfigs().map((config) => config.id)
    const closingIndex = orderedIds.indexOf(id)
    if (closingIndex === -1) {
      throw new Error(`Unknown session: ${id}`)
    }

    this.stopSession(id, true)
    this.configs.delete(id)
    this.runtimes.delete(id)

    if (this.activeSessionId === id) {
      this.activeSessionId =
        orderedIds[closingIndex + 1] ??
        orderedIds[closingIndex - 1] ??
        null
    }

    this.persist()
    return {
      closedSessionId: id,
      activeSessionId: this.activeSessionId,
    }
  }

  writeToSession(id: string, data: string): void {
    this.touchRuntime(id)
    this.terminals.get(id)?.write(data)
  }

  resizeSession(id: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(id)
    if (!terminal || cols < 2 || rows < 1) {
      return
    }

    terminal.resize(Math.floor(cols), Math.floor(rows))
  }

  dispose(): void {
    for (const id of Array.from(this.terminals.keys())) {
      this.stopSession(id, true)
    }
  }

  private async startSession(config: SessionConfig): Promise<void> {
    this.stopSession(config.id, true)
    this.setRuntime(config.id, {
      status: 'starting',
      pid: undefined,
      exitCode: undefined,
    })

    try {
      const shell = resolveShellCommand(config.shell)
      if (shell !== config.shell) {
        this.configs.set(config.id, {
          ...config,
          shell,
          updatedAt: new Date().toISOString(),
        })
        this.persist()
      }

      const terminal = nodePty.spawn(shell, buildShellArgs(), {
        name: 'xterm-color',
        cols: 120,
        rows: 36,
        cwd: config.cwd,
        useConpty: true,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
        },
      })

      this.terminals.set(config.id, terminal)
      this.setRuntime(config.id, {
        status: 'running',
        pid: terminal.pid,
        exitCode: undefined,
      })

      terminal.onData((chunk) => {
        this.events.onData({
          sessionId: config.id,
          chunk,
        })
      })

      terminal.onExit(({ exitCode }) => {
        this.terminals.delete(config.id)

        if (this.suppressedExit.delete(config.id)) {
          return
        }

        const status = exitCode === 0 ? 'exited' : 'error'
        this.setRuntime(config.id, {
          status,
          pid: undefined,
          exitCode,
        })
        this.events.onExit({
          sessionId: config.id,
          exitCode,
        })
      })

      setTimeout(() => {
        terminal.write(`${config.startupCommand}\r`)
      }, 60)
    } catch (error) {
      this.setRuntime(config.id, {
        status: 'error',
        pid: undefined,
        exitCode: -1,
      })

      this.events.onData({
        sessionId: config.id,
        chunk: `\r\n[agenclis] Failed to start session: ${this.getErrorMessage(error)}\r\n`,
      })
      this.events.onExit({
        sessionId: config.id,
        exitCode: -1,
      })
    }
  }

  private stopSession(id: string, suppressExit: boolean): void {
    const terminal = this.terminals.get(id)
    if (!terminal) {
      return
    }

    if (suppressExit) {
      this.suppressedExit.add(id)
    }

    this.terminals.delete(id)
    try {
      terminal.kill()
    } catch {
      this.suppressedExit.delete(id)
    }
  }

  private touchRuntime(id: string): SessionRuntime {
    return this.setRuntime(id, {})
  }

  private setRuntime(
    id: string,
    patch: Partial<Omit<SessionRuntime, 'sessionId'>>,
  ): SessionRuntime {
    const current = this.runtimes.get(id) ?? buildRuntime(id)
    const nextRuntime: SessionRuntime = {
      ...current,
      ...patch,
      sessionId: id,
      lastActiveAt: new Date().toISOString(),
    }

    this.runtimes.set(id, nextRuntime)
    this.events.onRuntime({
      sessionId: id,
      runtime: nextRuntime,
    })
    return nextRuntime
  }

  private snapshotFor(id: string): SessionSnapshot {
    return {
      config: this.requireConfig(id),
      runtime: this.runtimes.get(id) ?? buildRuntime(id),
    }
  }

  private requireConfig(id: string): SessionConfig {
    const config = this.configs.get(id)
    if (!config) {
      throw new Error(`Unknown session: ${id}`)
    }

    return config
  }

  private getOrderedConfigs(): SessionConfig[] {
    return Array.from(this.configs.values())
  }

  private persist(): void {
    this.store.set({
      sessions: this.getOrderedConfigs(),
      activeSessionId: this.activeSessionId,
    })
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }

    return 'Unknown error'
  }
}
