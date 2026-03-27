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
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) =>
          session.config.id === config.id
            ? {
                ...session,
                config,
              }
            : session,
        ),
      })),
    }))
  },
  updateRuntime: (runtime) => {
    set((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        sessions: project.sessions.map((session) =>
          session.config.id === runtime.sessionId
            ? {
                ...session,
                runtime,
              }
            : session,
        ),
      })),
    }))
  },
}))
