import type {
  CreateSessionInput,
  ListSessionsResponse,
  SessionCloseResult,
  SessionDataEvent,
  SessionExitMeta,
  SessionRuntimeEvent,
  SessionSnapshot,
} from './session'

export const IPC_CHANNELS = {
  restoreSessions: 'session:restore',
  listSessions: 'session:list',
  createSession: 'session:create',
  renameSession: 'session:rename',
  activateSession: 'session:activate',
  restartSession: 'session:restart',
  closeSession: 'session:close',
  writeToSession: 'session:write',
  resizeSession: 'session:resize',
  sessionData: 'session:data',
  sessionRuntime: 'session:runtime',
  sessionExit: 'session:exit',
} as const

export interface AgentCliApi {
  restoreSessions(): Promise<ListSessionsResponse>
  listSessions(): Promise<ListSessionsResponse>
  createSession(input: CreateSessionInput): Promise<SessionSnapshot>
  renameSession(id: string, title: string): Promise<SessionSnapshot>
  activateSession(id: string): Promise<void>
  restartSession(id: string): Promise<SessionSnapshot>
  closeSession(id: string): Promise<SessionCloseResult>
  writeToSession(id: string, data: string): Promise<void>
  resizeSession(id: string, cols: number, rows: number): Promise<void>
  onSessionData(listener: (event: SessionDataEvent) => void): () => void
  onSessionRuntime(listener: (event: SessionRuntimeEvent) => void): () => void
  onSessionExit(listener: (event: SessionExitMeta) => void): () => void
}
