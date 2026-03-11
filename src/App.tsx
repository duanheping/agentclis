import { useEffect, useState } from 'react'

import './App.css'
import { CreateSessionDialog } from './components/CreateSessionDialog'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalWorkspace } from './components/TerminalWorkspace'
import { terminalRegistry } from './lib/terminalRegistry'
import type { CreateSessionInput, SessionStatus } from './shared/session'
import { useSessionsStore } from './store/useSessionsStore'

const statusLabels: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Exited',
  error: 'Error',
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error.'
}

function App() {
  const agentCli = window.agentCli
  const sessions = useSessionsStore((state) => state.sessions)
  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  const hydrated = useSessionsStore((state) => state.hydrated)
  const setInitialData = useSessionsStore((state) => state.setInitialData)
  const upsertSession = useSessionsStore((state) => state.upsertSession)
  const setActiveSession = useSessionsStore((state) => state.setActiveSession)
  const updateRuntime = useSessionsStore((state) => state.updateRuntime)
  const removeSession = useSessionsStore((state) => state.removeSession)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    agentCli
      ? null
      : 'Agent bridge is unavailable. The preload script did not load.',
  )

  const activeSession =
    sessions.find((session) => session.config.id === activeSessionId) ?? null

  useEffect(() => {
    if (!agentCli) {
      setInitialData({
        sessions: [],
        activeSessionId: null,
      })
      return
    }

    const unsubscribeData = agentCli.onSessionData(({ sessionId, chunk }) => {
      terminalRegistry.write(sessionId, chunk)
    })

    const unsubscribeRuntime = agentCli.onSessionRuntime(({ runtime }) => {
      updateRuntime(runtime)
    })

    void (async () => {
      try {
        const payload = await agentCli.restoreSessions()
        setInitialData(payload)
      } catch (error) {
        setErrorMessage(getErrorMessage(error))
        setInitialData({
          sessions: [],
          activeSessionId: null,
        })
      }
    })()

    return () => {
      unsubscribeData()
      unsubscribeRuntime()
    }
  }, [agentCli, setInitialData, updateRuntime])

  const handleCreateSession = async (input: CreateSessionInput) => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    setErrorMessage(null)
    try {
      const snapshot = await agentCli.createSession(input)
      upsertSession(snapshot)
    } catch (error) {
      const message = getErrorMessage(error)
      setErrorMessage(message)
      throw new Error(message)
    }
  }

  const handleActivateSession = async (id: string) => {
    if (!agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    if (id === activeSessionId) {
      terminalRegistry.focus(id)
      return
    }

    try {
      setErrorMessage(null)
      await agentCli.activateSession(id)
      setActiveSession(id)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleRenameSession = async (id: string, title: string) => {
    if (!agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    try {
      setErrorMessage(null)
      const snapshot = await agentCli.renameSession(id, title)
      upsertSession(snapshot)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleCloseSession = async (id: string) => {
    if (!agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    try {
      setErrorMessage(null)
      const result = await agentCli.closeSession(id)
      terminalRegistry.forget(id)
      removeSession(result)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleRestartSession = async (id: string) => {
    if (!agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    try {
      setErrorMessage(null)
      terminalRegistry.clear(id)
      const snapshot = await agentCli.restartSession(id)
      upsertSession(snapshot)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  return (
    <div className="app-shell">
      <div className="app-shell__background" aria-hidden="true" />

      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onCreate={() => setDialogOpen(true)}
        onSelect={handleActivateSession}
        onRename={handleRenameSession}
        onClose={handleCloseSession}
      />

      <main className="workspace-shell">
        <header className="workspace-shell__header">
          {activeSession ? (
            <>
              <div className="workspace-shell__meta is-compact">
                <h2 className="workspace-shell__title">{activeSession.config.title}</h2>
                <p className="workspace-shell__path">{activeSession.config.cwd}</p>
              </div>

              <div className="workspace-shell__actions">
                <span className={`status-pill is-${activeSession.runtime.status}`}>
                  {statusLabels[activeSession.runtime.status]}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    void handleRestartSession(activeSession.config.id)
                  }}
                >
                  Restart
                </button>
                <button
                  type="button"
                  className="ghost-button danger-button"
                  onClick={() => {
                    void handleCloseSession(activeSession.config.id)
                  }}
                >
                  Close
                </button>
              </div>
            </>
          ) : (
            <div className="workspace-shell__meta is-compact">
              <h2 className="workspace-shell__title">No active session</h2>
              <p className="workspace-shell__path">
                Select an opened agent CLI from the left list.
              </p>
            </div>
          )}
        </header>

        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <section className="workspace-shell__body">
          {!hydrated ? (
            <div className="workspace-loading">
              <div>
                <p className="eyebrow">Restoring</p>
                <h2>Restoring previously opened sessions…</h2>
              </div>
            </div>
          ) : (
            <TerminalWorkspace
              sessions={sessions}
              activeSessionId={activeSessionId}
            />
          )}
        </section>
      </main>

      <CreateSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleCreateSession}
      />
    </div>
  )
}

export default App
