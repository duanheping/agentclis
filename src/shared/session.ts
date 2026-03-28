import type {
  ProjectIdentity,
  ProjectLocation,
} from './projectMemory'

export const SESSION_STATUSES = ['starting', 'running', 'exited', 'error'] as const

export type SessionStatus = (typeof SESSION_STATUSES)[number]
export const SESSION_ATTENTION_KINDS = [
  'task-complete',
  'needs-user-decision',
] as const

export type SessionAttentionKind = (typeof SESSION_ATTENTION_KINDS)[number]
export const MANAGED_CLI_PROVIDERS = ['codex', 'copilot'] as const

export type ManagedCliProvider = (typeof MANAGED_CLI_PROVIDERS)[number]

export const PERMISSION_LEVELS = ['default', 'full-access'] as const

export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]

export const PERMISSION_LEVEL_LABELS: Record<PermissionLevel, string> = {
  'default': 'Default permissions',
  'full-access': 'Full access',
}

export const PERMISSION_LEVEL_DESCRIPTIONS: Record<PermissionLevel, string> = {
  'default': 'Agent requires approval for file changes and commands',
  'full-access': 'Agent can read, write, and execute without approval',
}

export interface ManagedCliSessionRef {
  provider: ManagedCliProvider
  sessionId: string
  detectedAt: string
}

export interface ProjectConfig {
  id: string
  title: string
  rootPath: string
  createdAt: string
  updatedAt: string
  primaryLocationId?: string | null
  identity?: ProjectIdentity
}

export interface SessionConfig {
  id: string
  projectId: string
  locationId?: string
  title: string
  startupCommand: string
  pendingFirstPromptTitle: boolean
  externalSession?: ManagedCliSessionRef
  permissionLevel?: PermissionLevel
  cwd: string
  shell: string
  projectContextAttachedAt?: string
  createdAt: string
  updatedAt: string
}

export interface SessionRuntime {
  sessionId: string
  status: SessionStatus
  attention?: SessionAttentionKind | null
  pid?: number
  exitCode?: number
  lastActiveAt: string
}

export interface SessionSnapshot {
  config: SessionConfig
  runtime: SessionRuntime
}

export interface ProjectSnapshot {
  config: ProjectConfig
  locations?: ProjectLocation[]
  sessions: SessionSnapshot[]
}

export interface WorkspaceSnapshot {
  projects: ProjectSnapshot[]
  activeSessionId: string | null
}

export type ListSessionsResponse = WorkspaceSnapshot

export interface CreateProjectInput {
  title?: string
  rootPath: string
}

export interface CreateSessionInput {
  projectId?: string
  projectTitle?: string
  projectRootPath?: string
  title?: string
  startupCommand: string
  cwd?: string
  createWithWorktree?: boolean
  attachProjectContext?: boolean
  permissionLevel?: PermissionLevel
}

export interface SessionCloseResult {
  closedSessionId: string
  activeSessionId: string | null
}

export interface ProjectCloseResult {
  closedProjectId: string
  closedSessionIds: string[]
  activeSessionId: string | null
}

export interface SessionExitMeta {
  sessionId: string
  exitCode: number
}

export interface SessionDataEvent {
  sessionId: string
  chunk: string
}

export interface SessionConfigEvent {
  sessionId: string
  config: SessionConfig
}

export interface SessionRuntimeEvent {
  sessionId: string
  runtime: SessionRuntime
}

export function deriveProjectTitle(
  title: string | undefined,
  rootPath: string,
): string {
  const manualTitle = title?.trim()
  if (manualTitle) {
    return manualTitle
  }

  const normalizedPath = rootPath.trim().replace(/[\\/]+$/, '')
  const pathParts = normalizedPath.split(/[\\/]/).filter(Boolean)
  return pathParts.at(-1) ?? 'New Project'
}

export function deriveSessionTitle(
  title: string | undefined,
  startupCommand: string,
  cwd: string,
): string {
  const manualTitle = title?.trim()
  if (manualTitle) {
    return manualTitle
  }

  const commandLabel = startupCommand.trim().split(/\s+/)[0]
  if (commandLabel) {
    return commandLabel
  }

  const normalizedPath = cwd.trim().replace(/[\\/]+$/, '')
  const pathParts = normalizedPath.split(/[\\/]/).filter(Boolean)
  return pathParts.at(-1) ?? 'New Session'
}

export function resolveProjectRoot(
  rootPath: string | undefined,
  fallbackPath: string,
): string {
  const normalized = rootPath?.trim()
  if (normalized) {
    return normalized
  }

  return fallbackPath.trim()
}

export function resolveSessionCwd(
  cwd: string | undefined,
  fallbackCwd: string,
): string {
  const normalized = cwd?.trim()
  if (normalized) {
    return normalized
  }

  return fallbackCwd.trim()
}

export function summarizeCommand(command: string, limit = 42): string {
  const normalized = command.trim().replace(/\s+/g, ' ')
  if (normalized.length <= limit) {
    return normalized
  }

  const preview = normalized.slice(0, limit - 1)
  const breakPoint = preview.lastIndexOf(' ')

  if (breakPoint > Math.floor(limit / 2)) {
    return `${preview.slice(0, breakPoint)} …`
  }

  return `${preview}…`
}

export function buildRuntime(
  sessionId: string,
  status: SessionStatus = 'exited',
): SessionRuntime {
  return {
    sessionId,
    status,
    attention: null,
    lastActiveAt: new Date().toISOString(),
  }
}
