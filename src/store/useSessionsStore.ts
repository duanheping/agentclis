import { create } from 'zustand'

import type {
  ListSessionsResponse,
  PermissionLevel,
  ProjectSnapshot,
  SessionConfig,
  SessionRuntime,
} from '../shared/session'

interface SessionState {
  projects: ProjectSnapshot[]
  activeSessionId: string | null
  permissionLevel: PermissionLevel
  hydrated: boolean
  setInitialData: (payload: ListSessionsResponse) => void
  setActiveSession: (sessionId: string | null) => void
  setPermissionLevel: (level: PermissionLevel) => void
  updateConfig: (config: SessionConfig) => void
  updateRuntime: (runtime: SessionRuntime) => void
}

const PERMISSION_LEVEL_KEY = 'agenclis:permission-level'

function sameExternalSession(
  left: SessionConfig['externalSession'],
  right: SessionConfig['externalSession'],
): boolean {
  if (!left && !right) {
    return true
  }

  if (!left || !right) {
    return false
  }

  return (
    left.provider === right.provider &&
    left.sessionId === right.sessionId
  )
}

function sameConfig(left: SessionConfig, right: SessionConfig): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.locationId === right.locationId &&
    left.title === right.title &&
    left.startupCommand === right.startupCommand &&
    left.pendingFirstPromptTitle === right.pendingFirstPromptTitle &&
    sameExternalSession(left.externalSession, right.externalSession) &&
    left.permissionLevel === right.permissionLevel &&
    left.cwd === right.cwd &&
    left.shell === right.shell &&
    left.projectMemoryMode === right.projectMemoryMode &&
    left.projectMemoryFallbackReason === right.projectMemoryFallbackReason &&
    left.projectContextAttachedAt === right.projectContextAttachedAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  )
}

function sameRuntimeForUi(left: SessionRuntime, right: SessionRuntime): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.status === right.status &&
    (left.attention ?? null) === (right.attention ?? null) &&
    (left.awaitingResponse ?? false) === (right.awaitingResponse ?? false) &&
    left.pid === right.pid &&
    left.exitCode === right.exitCode
  )
}

function readPermissionLevelPreference(): PermissionLevel {
  try {
    const stored = window.localStorage.getItem(PERMISSION_LEVEL_KEY)
    if (stored === 'default' || stored === 'full-access') {
      return stored
    }
  } catch {
    // ignore
  }
  return 'default'
}

export const useSessionsStore = create<SessionState>((set) => ({
  projects: [],
  activeSessionId: null,
  permissionLevel: readPermissionLevelPreference(),
  hydrated: false,
  setInitialData: (payload) => {
    set({
      projects: payload.projects,
      activeSessionId: payload.activeSessionId,
      hydrated: true,
    })
  },
  setActiveSession: (sessionId) => {
    set({
      activeSessionId: sessionId,
    })
  },
  setPermissionLevel: (level) => {
    try {
      window.localStorage.setItem(PERMISSION_LEVEL_KEY, level)
    } catch {
      // ignore
    }
    set({ permissionLevel: level })
  },
  updateConfig: (config) => {
    set((state) => {
      let changed = false

      const projects = state.projects.map((project) => {
        let projectChanged = false

        const sessions = project.sessions.map((session) => {
          if (session.config.id !== config.id) {
            return session
          }

          if (sameConfig(session.config, config)) {
            return session
          }

          changed = true
          projectChanged = true
          return {
            ...session,
            config,
          }
        })

        return projectChanged ? { ...project, sessions } : project
      })

      return changed ? { projects } : state
    })
  },
  updateRuntime: (runtime) => {
    set((state) => {
      let changed = false

      const projects = state.projects.map((project) => {
        let projectChanged = false

        const sessions = project.sessions.map((session) => {
          if (session.config.id !== runtime.sessionId) {
            return session
          }

          if (sameRuntimeForUi(session.runtime, runtime)) {
            return session
          }

          changed = true
          projectChanged = true
          return {
            ...session,
            runtime,
          }
        })

        return projectChanged ? { ...project, sessions } : project
      })

      return changed ? { projects } : state
    })
  },
}))
