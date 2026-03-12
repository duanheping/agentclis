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
  SkillLibrarySettings,
  SkillTargetProvider,
  SkillSyncStatus,
} from './shared/skills'
import type {
  CreateProjectInput,
  CreateSessionInput,
  ProjectSnapshot,
  SessionSnapshot,
} from './shared/session'
import { useSessionsStore } from './store/useSessionsStore'

const SHOW_PROJECT_PATHS_KEY = 'agenclis:show-project-paths'
const SIDEBAR_OPEN_KEY = 'agenclis:sidebar-open'
type CreateDialogIntent = 'session' | 'project'
type CreateDialogMode = 'default' | 'project-context'

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

function readSidebarOpenPreference(): boolean {
  if (typeof window === 'undefined') {
    return true
  }

  try {
    const storedValue = window.localStorage.getItem(SIDEBAR_OPEN_KEY)
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
  const [createDialogMode, setCreateDialogMode] =
    useState<CreateDialogMode>('default')
  const [dialogProjectId, setDialogProjectId] = useState<string | null>(null)
  const [showProjectPaths, setShowProjectPaths] = useState<boolean>(() =>
    readShowProjectPathsPreference(),
  )
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    readSidebarOpenPreference(),
  )
  const [windowsCommandPromptSessionIds, setWindowsCommandPromptSessionIds] =
    useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    agentCli
      ? null
      : 'Agent bridge is unavailable. The preload script did not load.',
  )
  const [skillLibrarySettings, setSkillLibrarySettings] =
    useState<SkillLibrarySettings | null>(null)
  const [skillSyncStatus, setSkillSyncStatus] = useState<SkillSyncStatus | null>(null)
  const [skillsLoading, setSkillsLoading] = useState(Boolean(agentCli))
  const [skillsBusy, setSkillsBusy] = useState(false)
  const [skillsSyncing, setSkillsSyncing] = useState(false)
  const [skillsErrorMessage, setSkillsErrorMessage] = useState<string | null>(null)

  const sessions = flattenSessions(projects)
  const activeProject = findActiveProject(projects, activeSessionId)

  const refreshWorkspace = async () => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const payload = await agentCli.listSessions()
    setInitialData(payload)
  }

  const refreshSkillState = async () => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const [settings, status] = await Promise.all([
      agentCli.getSkillLibrarySettings(),
      agentCli.getSkillSyncStatus(),
    ])

    setSkillLibrarySettings(settings)
    setSkillSyncStatus(status)
  }

  const persistSkillSettings = async (settings: SkillLibrarySettings) => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const nextSettings = await agentCli.updateSkillLibrarySettings(settings)
    setSkillLibrarySettings(nextSettings)
    setSkillSyncStatus(await agentCli.getSkillSyncStatus())
  }

  const mutateSkillSettings = async (
    transform: (current: SkillLibrarySettings) => SkillLibrarySettings,
  ) => {
    if (!skillLibrarySettings) {
      setSkillsErrorMessage('Skill settings are still loading.')
      return
    }

    setSkillsBusy(true)
    setSkillsErrorMessage(null)

    try {
      await persistSkillSettings(transform(skillLibrarySettings))
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    } finally {
      setSkillsBusy(false)
    }
  }

  useEffect(() => {
    if (!agentCli) {
      setInitialData({
        projects: [],
        activeSessionId: null,
      })
      setSkillLibrarySettings(null)
      setSkillSyncStatus(null)
      setSkillsLoading(false)
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

    void (async () => {
      setSkillsLoading(true)

      try {
        const [settings, status] = await Promise.all([
          agentCli.getSkillLibrarySettings(),
          agentCli.getSkillSyncStatus(),
        ])
        setSkillLibrarySettings(settings)
        setSkillSyncStatus(status)
        setSkillsErrorMessage(null)
      } catch (error) {
        setSkillLibrarySettings(null)
        setSkillSyncStatus(null)
        setSkillsErrorMessage(getErrorMessage(error))
      } finally {
        setSkillsLoading(false)
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

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen))
    } catch {
      // Ignore preference persistence failures and keep the in-memory state.
    }
  }, [sidebarOpen])

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

  const handlePickSkillLibraryRoot = async () => {
    if (!agentCli || !skillLibrarySettings) {
      setSkillsErrorMessage('Skill settings are unavailable.')
      return
    }

    try {
      setSkillsErrorMessage(null)
      const selectedPath = await agentCli.pickDirectory(
        skillLibrarySettings.libraryRoot || undefined,
      )

      if (!selectedPath) {
        return
      }

      await mutateSkillSettings((current) => ({
        ...current,
        libraryRoot: selectedPath,
      }))
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    }
  }

  const handleClearSkillLibraryRoot = async () => {
    await mutateSkillSettings((current) => ({
      ...current,
      libraryRoot: '',
    }))
  }

  const handleOpenSkillLibraryRoot = async () => {
    if (!agentCli || !skillLibrarySettings?.libraryRoot.trim()) {
      return
    }

    try {
      setSkillsErrorMessage(null)
      await agentCli.openPath(skillLibrarySettings.libraryRoot)
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    }
  }

  const handleToggleSkillAutoSync = async () => {
    await mutateSkillSettings((current) => ({
      ...current,
      autoSyncOnAppStart: !current.autoSyncOnAppStart,
    }))
  }

  const handlePickSkillTargetRoot = async (provider: SkillTargetProvider) => {
    if (!agentCli || !skillLibrarySettings) {
      setSkillsErrorMessage('Skill settings are unavailable.')
      return
    }

    try {
      setSkillsErrorMessage(null)
      const selectedPath = await agentCli.pickDirectory(
        skillLibrarySettings.providers[provider].targetRoot ||
          skillLibrarySettings.libraryRoot ||
          undefined,
      )

      if (!selectedPath) {
        return
      }

      await mutateSkillSettings((current) => ({
        ...current,
        providers: {
          ...current.providers,
          [provider]: {
            targetRoot: selectedPath,
          },
        },
      }))
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    }
  }

  const handleClearSkillTargetRoot = async (provider: SkillTargetProvider) => {
    await mutateSkillSettings((current) => ({
      ...current,
      providers: {
        ...current.providers,
        [provider]: {
          targetRoot: '',
        },
      },
    }))
  }

  const handleOpenSkillTargetRoot = async (provider: SkillTargetProvider) => {
    if (!agentCli || !skillLibrarySettings?.providers[provider].targetRoot.trim()) {
      return
    }

    try {
      setSkillsErrorMessage(null)
      await agentCli.openPath(skillLibrarySettings.providers[provider].targetRoot)
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    }
  }

  const handleSyncSkills = async () => {
    if (!agentCli) {
      setSkillsErrorMessage('Agent bridge is unavailable.')
      return
    }

    setSkillsSyncing(true)
    setSkillsErrorMessage(null)

    try {
      await agentCli.syncSkills()
      await refreshSkillState()
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    } finally {
      setSkillsSyncing(false)
    }
  }

  const openCreateSessionDialog = (
    projectId: string | null = null,
    mode: CreateDialogMode = 'default',
  ) => {
    setCreateDialogIntent('session')
    setCreateDialogMode(mode)
    setDialogProjectId(projectId)
    setDialogOpen(true)
  }

  const openCreateProjectDialog = () => {
    setCreateDialogIntent('project')
    setCreateDialogMode('default')
    setDialogProjectId(null)
    setDialogOpen(true)
  }

  const closeCreateSessionDialog = () => {
    setDialogOpen(false)
    setCreateDialogIntent('session')
    setCreateDialogMode('default')
    setDialogProjectId(null)
  }

  return (
    <div className={`app-shell${sidebarOpen ? '' : ' app-shell--sidebar-collapsed'}`}>
      <div className="app-shell__background" aria-hidden="true" />

      <header className="titlebar">
        {!sidebarOpen ? (
          <button
            type="button"
            className="titlebar__sidebar-toggle"
            aria-label="Expand sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <span className="titlebar__sidebar-toggle-icon" aria-hidden="true" />
            <span className="titlebar__sidebar-toggle-label">Show sidebar</span>
          </button>
        ) : null}

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

      {sidebarOpen ? (
        <SessionSidebar
          projects={projects}
          activeSessionId={activeSessionId}
          showProjectPaths={showProjectPaths}
          onToggleSidebar={() => setSidebarOpen(false)}
          onCreateSession={() => openCreateSessionDialog()}
          onCreateProject={openCreateProjectDialog}
          onCreateForProject={(projectId) =>
            openCreateSessionDialog(projectId, 'project-context')
          }
          onSelect={handleActivateSession}
          onRename={handleRenameSession}
          onClose={handleCloseSession}
          windowsCommandPromptSessionIds={windowsCommandPromptSessionIds}
          onToggleWindowsCommandPrompt={handleToggleWindowsCommandPrompt}
          onToggleProjectPaths={() =>
            setShowProjectPaths((current) => !current)
          }
          skillLibrarySettings={skillLibrarySettings}
          skillSyncStatus={skillSyncStatus}
          skillsLoading={skillsLoading}
          skillsBusy={skillsBusy}
          skillsSyncing={skillsSyncing}
          skillsErrorMessage={skillsErrorMessage}
          onPickSkillLibraryRoot={handlePickSkillLibraryRoot}
          onClearSkillLibraryRoot={handleClearSkillLibraryRoot}
          onOpenSkillLibraryRoot={handleOpenSkillLibraryRoot}
          onToggleSkillAutoSync={handleToggleSkillAutoSync}
          onPickSkillTargetRoot={handlePickSkillTargetRoot}
          onClearSkillTargetRoot={handleClearSkillTargetRoot}
          onOpenSkillTargetRoot={handleOpenSkillTargetRoot}
          onSyncSkills={handleSyncSkills}
        />
      ) : null}

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
        mode={createDialogMode}
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
