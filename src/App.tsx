import { useEffect, useState } from 'react'

import './App.css'
import { CreateSessionDialog } from './components/CreateSessionDialog'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalWorkspace } from './components/TerminalWorkspace'
import {
  buildWindowsCommandPromptTerminalId,
  terminalRegistry,
} from './lib/terminalRegistry'
import type {
  CreateProjectInput,
  CreateSessionInput,
  ProjectSnapshot,
  SessionSnapshot,
} from './shared/session'
import { useSessionsStore } from './store/useSessionsStore'

const SHOW_PROJECT_PATHS_KEY = 'agenclis:show-project-paths'
type CreateDialogIntent = 'session' | 'project'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error.'
}

function flattenSessions(projects: ProjectSnapshot[]): SessionSnapshot[] {
  return projects.flatMap((project) => project.sessions)
}

function findActiveProject(
  projects: ProjectSnapshot[],
  activeSessionId: string | null,
): ProjectSnapshot | null {
  return (
    projects.find((project) =>
      project.sessions.some((session) => session.config.id === activeSessionId),
    ) ?? null
  )
}

function readShowProjectPathsPreference(): boolean {
  if (typeof window === 'undefined') {
    return true
  }

  try {
    const storedValue = window.localStorage.getItem(SHOW_PROJECT_PATHS_KEY)
    return storedValue === null ? true : storedValue === 'true'
  } catch {
    return true
  }
}

function App() {
  const agentCli = window.agentCli
  const projects = useSessionsStore((state) => state.projects)
  const activeSessionId = useSessionsStore((state) => state.activeSessionId)
  const hydrated = useSessionsStore((state) => state.hydrated)
  const setInitialData = useSessionsStore((state) => state.setInitialData)
  const setActiveSession = useSessionsStore((state) => state.setActiveSession)
  const updateConfig = useSessionsStore((state) => state.updateConfig)
  const updateRuntime = useSessionsStore((state) => state.updateRuntime)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [createDialogIntent, setCreateDialogIntent] =
    useState<CreateDialogIntent>('session')
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null)
  const [showProjectPaths, setShowProjectPaths] = useState<boolean>(() =>
    readShowProjectPathsPreference(),
  )
  const [windowsCommandPromptSessionIds, setWindowsCommandPromptSessionIds] =
    useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    agentCli
      ? null
      : 'Agent bridge is unavailable. The preload script did not load.',
  )

  const sessions = flattenSessions(projects)
  const activeProject = findActiveProject(projects, activeSessionId)

  useEffect(() => {
    if (!agentCli) {
      setInitialData({
        projects: [],
        activeSessionId: null,
      })
      return
    }

    const unsubscribeData = agentCli.onSessionData(({ sessionId, chunk }) => {
      terminalRegistry.write(sessionId, chunk)
    })

    const unsubscribeConfig = agentCli.onSessionConfig(({ config }) => {
      updateConfig(config)
    })

    const unsubscribeWindowsCommandPromptData = agentCli.onWindowsCommandPromptData(
      ({ sessionId, chunk }) => {
        terminalRegistry.write(
          buildWindowsCommandPromptTerminalId(sessionId),
          chunk,
        )
      },
    )

    const unsubscribeRuntime = agentCli.onSessionRuntime(({ runtime }) => {
      updateRuntime(runtime)
    })

    const unsubscribeWindowsCommandPromptExit = agentCli.onWindowsCommandPromptExit(
      ({ sessionId }) => {
        terminalRegistry.forget(buildWindowsCommandPromptTerminalId(sessionId))
        setWindowsCommandPromptSessionIds((current) =>
          current.filter((id) => id !== sessionId),
        )
      },
    )

    void (async () => {
      try {
        const payload = await agentCli.listSessions()
        const openWindowsCommandPrompts =
          await agentCli.listWindowsCommandPrompts()
        setInitialData(payload)
        setWindowsCommandPromptSessionIds(openWindowsCommandPrompts)
        void agentCli.restoreSessions().catch((error) => {
          setErrorMessage(getErrorMessage(error))
        })
      } catch (error) {
        setErrorMessage(getErrorMessage(error))
        setInitialData({
          projects: [],
          activeSessionId: null,
        })
        setWindowsCommandPromptSessionIds([])
      }
    })()

    return () => {
      unsubscribeData()
      unsubscribeConfig()
      unsubscribeWindowsCommandPromptData()
      unsubscribeRuntime()
      unsubscribeWindowsCommandPromptExit()
    }
  }, [agentCli, setInitialData, updateConfig, updateRuntime])

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SHOW_PROJECT_PATHS_KEY,
        String(showProjectPaths),
      )
    } catch {
      // Ignore preference persistence failures and keep the in-memory state.
    }
  }, [showProjectPaths])

  const refreshWorkspace = async () => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const payload = await agentCli.listSessions()
    setInitialData(payload)
  }

  const handleCreateSession = async (input: CreateSessionInput) => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    setErrorMessage(null)
    try {
      await agentCli.createSession(input)
      await refreshWorkspace()
    } catch (error) {
      const message = getErrorMessage(error)
      setErrorMessage(message)
      throw new Error(message)
    }
  }

  const handleCreateProject = async (input: CreateProjectInput) => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    setErrorMessage(null)
    try {
      await agentCli.createProject(input)
      await refreshWorkspace()
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
      await agentCli.renameSession(id, title)
      await refreshWorkspace()
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
      await agentCli.closeSession(id)
      terminalRegistry.forget(id)
      terminalRegistry.forget(buildWindowsCommandPromptTerminalId(id))
      setWindowsCommandPromptSessionIds((current) =>
        current.filter((sessionId) => sessionId !== id),
      )
      await refreshWorkspace()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleToggleWindowsCommandPrompt = async (id: string) => {
    if (!agentCli) {
      setErrorMessage('Agent bridge is unavailable.')
      return
    }

    const session = sessions.find((entry) => entry.config.id === id)
    if (!session) {
      setErrorMessage('Session not found.')
      return
    }

    const terminalId = buildWindowsCommandPromptTerminalId(id)
    const currentlyOpen = windowsCommandPromptSessionIds.includes(id)

    try {
      setErrorMessage(null)

      if (currentlyOpen) {
        await agentCli.closeWindowsCommandPrompt(id)
        terminalRegistry.forget(terminalId)
        setWindowsCommandPromptSessionIds((current) =>
          current.filter((sessionId) => sessionId !== id),
        )
        return
      }

      await agentCli.openWindowsCommandPrompt(id, session.config.cwd)
      setWindowsCommandPromptSessionIds((current) =>
        current.includes(id) ? current : [...current, id],
      )
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const openCreateSessionDialog = (projectId: string | null = null) => {
    setCreateDialogIntent('session')
    setDialogProjectId(projectId)
    setDialogOpen(true)
  }

  const openCreateProjectDialog = () => {
    setCreateDialogIntent('project')
    setDialogProjectId(null)
    setDialogOpen(true)
  }

  const closeCreateSessionDialog = () => {
    setDialogOpen(false)
    setCreateDialogIntent('session')
    setDialogProjectId(null)
  }

  return (
    <div className="app-shell">
      <div className="app-shell__background" aria-hidden="true" />

      <header className="titlebar">
        <div className="titlebar__brand">
          <span className="titlebar__name">Agent CLIs</span>
          <span className="titlebar__separator" aria-hidden="true">
            /
          </span>
          <span className="titlebar__section">
            {activeProject?.config.title ?? 'Workspace'}
          </span>
        </div>
      </header>

      <SessionSidebar
        projects={projects}
        activeSessionId={activeSessionId}
        showProjectPaths={showProjectPaths}
        onCreateSession={() => openCreateSessionDialog()}
        onCreateProject={openCreateProjectDialog}
        onCreateForProject={(projectId) => openCreateSessionDialog(projectId)}
        onSelect={handleActivateSession}
        onRename={handleRenameSession}
        onClose={handleCloseSession}
        windowsCommandPromptSessionIds={windowsCommandPromptSessionIds}
        onToggleWindowsCommandPrompt={handleToggleWindowsCommandPrompt}
        onToggleProjectPaths={() =>
          setShowProjectPaths((current) => !current)
        }
      />

      <main className="workspace-shell">
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
              windowsCommandPromptSessionIds={windowsCommandPromptSessionIds}
            />
          )}
        </section>
      </main>

      <CreateSessionDialog
        open={dialogOpen}
        initialIntent={createDialogIntent}
        projects={projects}
        activeProjectId={
          dialogProjectId ??
          activeProject?.config.id ??
          projects[0]?.config.id ??
          null
        }
        onClose={closeCreateSessionDialog}
        onCreateProject={handleCreateProject}
        onCreateSession={handleCreateSession}
      />
    </div>
  )
}

export default App
