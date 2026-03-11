import { create } from 'zustand'

import type {
  ListSessionsResponse,
  SessionCloseResult,
  SessionRuntime,
  SessionSnapshot,
} from '../shared/session'

interface SessionState {
  sessions: SessionSnapshot[]
  activeSessionId: string | null
  hydrated: boolean
  setInitialData: (payload: ListSessionsResponse) => void
  upsertSession: (snapshot: SessionSnapshot) => void
  setActiveSession: (sessionId: string | null) => void
  updateRuntime: (runtime: SessionRuntime) => void
  removeSession: (result: SessionCloseResult) => void
}

function upsertSnapshot(
  sessions: SessionSnapshot[],
  snapshot: SessionSnapshot,
): SessionSnapshot[] {
  const index = sessions.findIndex(
    (session) => session.config.id === snapshot.config.id,
  )

  if (index === -1) {
    return [...sessions, snapshot]
  }

  return sessions.map((session, sessionIndex) =>
    sessionIndex === index ? snapshot : session,
  )
}

export const useSessionsStore = create<SessionState>((set) => ({
  sessions: [],
  activeSessionId: null,
  hydrated: false,
  setInitialData: (payload) => {
    set({
      sessions: payload.sessions,
      activeSessionId: payload.activeSessionId,
      hydrated: true,
    })
  },
  upsertSession: (snapshot) => {
    set((state) => ({
      sessions: upsertSnapshot(state.sessions, snapshot),
      activeSessionId: snapshot.config.id,
    }))
  },
  setActiveSession: (sessionId) => {
    set({
      activeSessionId: sessionId,
    })
  },
  updateRuntime: (runtime) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.config.id === runtime.sessionId
          ? {
              ...session,
              runtime,
            }
          : session,
      ),
    }))
  },
  removeSession: (result) => {
    set((state) => ({
      sessions: state.sessions.filter(
        (session) => session.config.id !== result.closedSessionId,
      ),
      activeSessionId: result.activeSessionId,
    }))
  },
}))
