import type {
  CreateProjectInput,
  CreateSessionInput,
  ListSessionsResponse,
  ProjectSnapshot,
  SessionCloseResult,
  SessionConfigEvent,
  SessionDataEvent,
  SessionExitMeta,
  SessionRuntimeEvent,
  SessionSnapshot,
} from './session'

export const IPC_CHANNELS = {
  restoreSessions: 'session:restore',
  listSessions: 'session:list',
  createProject: 'project:create',
  createSession: 'session:create',
  renameSession: 'session:rename',
  activateSession: 'session:activate',
  restartSession: 'session:restart',
  closeSession: 'session:close',
  writeToSession: 'session:write',
  resizeSession: 'session:resize',
  pickDirectory: 'dialog:pick-directory',
  listWindowsCommandPrompts: 'shell:list-windows-command-prompts',
  openWindowsCommandPrompt: 'shell:open-windows-command-prompt',
  closeWindowsCommandPrompt: 'shell:close-windows-command-prompt',
  writeToWindowsCommandPrompt: 'shell:write-windows-command-prompt',
  resizeWindowsCommandPrompt: 'shell:resize-windows-command-prompt',
  windowsCommandPromptData: 'shell:data-windows-command-prompt',
  windowsCommandPromptExit: 'shell:exit-windows-command-prompt',
  sessionData: 'session:data',
  sessionConfig: 'session:config',
  sessionRuntime: 'session:runtime',
  sessionExit: 'session:exit',
} as const

export interface AgentCliApi {
  restoreSessions(): Promise<ListSessionsResponse>
  listSessions(): Promise<ListSessionsResponse>
  createProject(input: CreateProjectInput): Promise<ProjectSnapshot>
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>
  renameSession(id: string, title: string): Promise<SessionSnapshot>
  activateSession(id: string): Promise<void>
  restartSession(id: string): Promise<SessionSnapshot>
  closeSession(id: string): Promise<SessionCloseResult>
  writeToSession(id: string, data: string): Promise<void>
  resizeSession(id: string, cols: number, rows: number): Promise<void>
  pickDirectory(defaultPath?: string): Promise<string | null>
  listWindowsCommandPrompts(): Promise<string[]>
  openWindowsCommandPrompt(sessionId: string, cwd: string): Promise<void>
  closeWindowsCommandPrompt(sessionId: string): Promise<void>
  writeToWindowsCommandPrompt(sessionId: string, data: string): Promise<void>
  resizeWindowsCommandPrompt(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void>
  onSessionData(listener: (event: SessionDataEvent) => void): () => void
  onSessionConfig(listener: (event: SessionConfigEvent) => void): () => void
  onSessionRuntime(listener: (event: SessionRuntimeEvent) => void): () => void
  onSessionExit(listener: (event: SessionExitMeta) => void): () => void
  onWindowsCommandPromptData(
    listener: (event: SessionDataEvent) => void,
  ): () => void
  onWindowsCommandPromptExit(
    listener: (event: SessionExitMeta) => void,
  ): () => void
}
