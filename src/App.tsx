import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'

import './App.css'
import { CreateSessionDialog } from './components/CreateSessionDialog'
import { ProjectDiffPanel } from './components/ProjectDiffPanel'
import { SessionSidebar } from './components/SessionSidebar'
import { TerminalWorkspace } from './components/TerminalWorkspace'
import {
  buildWindowsCommandPromptTerminalId,
  terminalRegistry,
} from './lib/terminalRegistry'
import type {
  ProjectGitFileChange,
  ProjectGitOverview,
  ProjectOpenTarget,
} from './shared/projectTools'
import type {
  SkillAiMergeAgent,
  SkillAiMergeProposal,
  SkillAiReviewAgent,
  SkillLibrarySettings,
  SkillSyncRoot,
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
const DIFF_PANEL_OPEN_KEY = 'agenclis:diff-panel-open'
const SIDEBAR_WIDTH_KEY = 'agenclis:sidebar-width'
const DIFF_PANEL_WIDTH_KEY = 'agenclis:diff-panel-width'
const DEFAULT_SIDEBAR_WIDTH = 288
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 520
const DEFAULT_DIFF_PANEL_WIDTH = 420
const MIN_DIFF_PANEL_WIDTH = 320
const MAX_DIFF_PANEL_WIDTH = 720
const MIN_DESKTOP_CENTER_PANE_WIDTH = 420
const RESIZER_KEYBOARD_STEP = 24
const COMPACT_LAYOUT_MEDIA_QUERY = '(max-width: 980px)'
const APP_BRAND_NAME = 'agentclis'
type CreateDialogIntent = 'session' | 'project'
type CreateDialogMode = 'default' | 'project-context'

interface ProjectDiffSelection {
  path: string
  staged: boolean
}

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
  return readBooleanPreference(SHOW_PROJECT_PATHS_KEY, true)
}

function readSidebarOpenPreference(): boolean {
  return readBooleanPreference(SIDEBAR_OPEN_KEY, true)
}

function readDiffPanelOpenPreference(): boolean {
  return readBooleanPreference(DIFF_PANEL_OPEN_KEY, false)
}

function readSidebarWidthPreference(): number {
  return readNumberPreference(
    SIDEBAR_WIDTH_KEY,
    DEFAULT_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
  )
}

function readDiffPanelWidthPreference(): number {
  return readNumberPreference(
    DIFF_PANEL_WIDTH_KEY,
    DEFAULT_DIFF_PANEL_WIDTH,
    MIN_DIFF_PANEL_WIDTH,
    MAX_DIFF_PANEL_WIDTH,
  )
}
function readBooleanPreference(key: string, defaultValue: boolean): boolean {
  if (typeof window === 'undefined') {
    return defaultValue
  }

  try {
    const storedValue = window.localStorage.getItem(key)
    return storedValue === null ? defaultValue : storedValue === 'true'
  } catch {
    return defaultValue
  }
}

function readNumberPreference(
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (typeof window === 'undefined') {
    return defaultValue
  }

  try {
    const storedValue = window.localStorage.getItem(key)
    if (storedValue === null) {
      return defaultValue
    }

    const parsedValue = Number(storedValue)
    return Number.isFinite(parsedValue)
      ? clampNumber(parsedValue, min, max)
      : defaultValue
  } catch {
    return defaultValue
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isCompactLayout(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  return window.matchMedia(COMPACT_LAYOUT_MEDIA_QUERY).matches
}

function getSidebarMaxWidth(containerWidth: number): number {
  return Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(
      MAX_SIDEBAR_WIDTH,
      containerWidth - MIN_DESKTOP_CENTER_PANE_WIDTH,
    ),
  )
}

function getDiffPanelMaxWidth(containerWidth: number): number {
  return Math.max(
    MIN_DIFF_PANEL_WIDTH,
    Math.min(
      MAX_DIFF_PANEL_WIDTH,
      containerWidth - MIN_DESKTOP_CENTER_PANE_WIDTH,
    ),
  )
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
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
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readSidebarWidthPreference(),
  )
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    readSidebarOpenPreference(),
  )
  const [diffPanelOpen, setDiffPanelOpen] = useState<boolean>(() =>
    readDiffPanelOpenPreference(),
  )
  const [diffPanelWidth, setDiffPanelWidth] = useState<number>(() =>
    readDiffPanelWidthPreference(),
  )
  const [windowsCommandPromptSessionIds, setWindowsCommandPromptSessionIds] =
    useState<string[]>([])
  const [projectOpenMenuOpen, setProjectOpenMenuOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(() =>
    agentCli
      ? null
      : 'Agent bridge is unavailable. The preload script did not load.',
  )
  const [projectGitOverview, setProjectGitOverview] =
    useState<ProjectGitOverview | null>(null)
  const [projectGitLoading, setProjectGitLoading] = useState(false)
  const [projectGitErrorMessage, setProjectGitErrorMessage] =
    useState<string | null>(null)
  const [selectedProjectDiff, setSelectedProjectDiff] =
    useState<ProjectDiffSelection | null>(null)
  const [projectGitDiffContent, setProjectGitDiffContent] = useState<string | null>(null)
  const [projectGitDiffLoading, setProjectGitDiffLoading] = useState(false)
  const [projectGitDiffErrorMessage, setProjectGitDiffErrorMessage] =
    useState<string | null>(null)
  const [skillLibrarySettings, setSkillLibrarySettings] =
    useState<SkillLibrarySettings | null>(null)
  const [skillSyncStatus, setSkillSyncStatus] = useState<SkillSyncStatus | null>(null)
  const [skillsLoading, setSkillsLoading] = useState(Boolean(agentCli))
  const [skillsBusy, setSkillsBusy] = useState(false)
  const [skillsResolving, setSkillsResolving] = useState<string | null>(null)
  const [skillsGeneratingMerge, setSkillsGeneratingMerge] = useState<string | null>(null)
  const [skillsApplyingMerge, setSkillsApplyingMerge] = useState(false)
  const [projectMemoryImporting, setProjectMemoryImporting] = useState(false)
  const [projectMemoryImportStatus, setProjectMemoryImportStatus] =
    useState<string | null>(null)
  const [skillAiMergeProposal, setSkillAiMergeProposal] =
    useState<SkillAiMergeProposal | null>(null)
  const [skillsErrorMessage, setSkillsErrorMessage] = useState<string | null>(null)
  const [skillsSyncing, setSkillsSyncing] = useState(false)
  const appShellRef = useRef<HTMLDivElement | null>(null)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const workspaceBodyRef = useRef<HTMLElement | null>(null)
  const paneResizeCleanupRef = useRef<(() => void) | null>(null)
  const pendingWindowsCommandPromptCloseSessionIdsRef = useRef<Set<string>>(
    new Set(),
  )
  const sessionIdsRef = useRef<Set<string>>(new Set())

  const sessions = flattenSessions(projects)
  sessionIdsRef.current = new Set(sessions.map((session) => session.config.id))
  const activeProject = findActiveProject(projects, activeSessionId)
  const activeSession =
    sessions.find((session) => session.config.id === activeSessionId) ?? null
  const activeWorkspacePath =
    activeSession?.config.cwd ?? activeProject?.config.rootPath ?? null
  const activeSessionHasWindowsCommandPrompt =
    activeSessionId !== null &&
    windowsCommandPromptSessionIds.includes(activeSessionId)
  const showDiffPanel = hydrated && diffPanelOpen && Boolean(activeWorkspacePath)
  const featuredProject = activeProject ?? projects[0] ?? null
  const showWelcomeWorkspace = hydrated && sessions.length === 0

  const clampSidebarWidth = (nextWidth: number): number => {
    const containerWidth = appShellRef.current?.getBoundingClientRect().width
    const maxWidth =
      containerWidth && !isCompactLayout()
        ? getSidebarMaxWidth(containerWidth)
        : MAX_SIDEBAR_WIDTH

    return clampNumber(nextWidth, MIN_SIDEBAR_WIDTH, maxWidth)
  }

  const clampDiffPanelWidth = (nextWidth: number): number => {
    const containerWidth = workspaceBodyRef.current?.getBoundingClientRect().width
    const maxWidth =
      containerWidth && !isCompactLayout()
        ? getDiffPanelMaxWidth(containerWidth)
        : MAX_DIFF_PANEL_WIDTH

    return clampNumber(nextWidth, MIN_DIFF_PANEL_WIDTH, maxWidth)
  }

  const beginPaneResize = (
    event: ReactPointerEvent<HTMLButtonElement>,
    resize: (clientX: number) => void,
  ) => {
    if (isCompactLayout()) {
      return
    }

    event.preventDefault()
    paneResizeCleanupRef.current?.()

    const originalCursor = document.body.style.cursor
    const originalUserSelect = document.body.style.userSelect

    const handlePointerMove = (moveEvent: PointerEvent) => {
      resize(moveEvent.clientX)
    }

    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      document.body.style.cursor = originalCursor
      document.body.style.userSelect = originalUserSelect
      paneResizeCleanupRef.current = null
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    paneResizeCleanupRef.current = stopResize
  }

  const handleSidebarResizerPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!appShellRef.current) {
      return
    }

    const shellRect = appShellRef.current.getBoundingClientRect()
    beginPaneResize(event, (clientX) => {
      setSidebarWidth(clampSidebarWidth(clientX - shellRect.left))
    })
  }

  const handleDiffResizerPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!workspaceBodyRef.current) {
      return
    }

    const bodyRect = workspaceBodyRef.current.getBoundingClientRect()
    beginPaneResize(event, (clientX) => {
      setDiffPanelWidth(clampDiffPanelWidth(bodyRect.right - clientX))
    })
  }

  const handleSidebarResizerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (isCompactLayout()) {
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSidebarWidth((current) =>
        clampSidebarWidth(current - RESIZER_KEYBOARD_STEP),
      )
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSidebarWidth((current) =>
        clampSidebarWidth(current + RESIZER_KEYBOARD_STEP),
      )
    }
  }

  const handleDiffResizerKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    if (isCompactLayout()) {
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setDiffPanelWidth((current) =>
        clampDiffPanelWidth(current - RESIZER_KEYBOARD_STEP),
      )
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setDiffPanelWidth((current) =>
        clampDiffPanelWidth(current + RESIZER_KEYBOARD_STEP),
      )
    }
  }

  const refreshWorkspace = useCallback(async () => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const payload = await agentCli.listSessions()
    setInitialData(payload)
  }, [agentCli, setInitialData])

  const hideWindowsCommandPrompt = useCallback((sessionId: string) => {
    terminalRegistry.forget(buildWindowsCommandPromptTerminalId(sessionId))
    setWindowsCommandPromptSessionIds((current) =>
      current.filter((id) => id !== sessionId),
    )
  }, [])

  const showWindowsCommandPrompt = useCallback((sessionId: string) => {
    setWindowsCommandPromptSessionIds((current) =>
      current.includes(sessionId) ? current : [...current, sessionId],
    )
  }, [])

  const closeSessionInWorkspace = useCallback(
    async (id: string) => {
      if (!agentCli) {
        throw new Error('Agent bridge is unavailable.')
      }

      await agentCli.closeSession(id)
      terminalRegistry.forget(id)
      pendingWindowsCommandPromptCloseSessionIdsRef.current.delete(id)
      hideWindowsCommandPrompt(id)
      await refreshWorkspace()
    },
    [agentCli, hideWindowsCommandPrompt, refreshWorkspace],
  )

  const refreshSkillState = useCallback(async () => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const [settings, status] = await Promise.all([
      agentCli.getSkillLibrarySettings(),
      agentCli.getSkillSyncStatus(),
    ])

    setSkillLibrarySettings(settings)
    setSkillSyncStatus(status)
  }, [agentCli])

  const refreshProjectGitState = async (projectPath = activeWorkspacePath) => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    if (!projectPath) {
      setProjectGitOverview(null)
      setProjectGitErrorMessage(null)
      return null
    }

    const overview = await agentCli.getProjectGitOverview(projectPath)
    setProjectGitOverview(overview)
    setProjectGitErrorMessage(null)
    return overview
  }

  const persistSkillSettings = async (settings: SkillLibrarySettings) => {
    if (!agentCli) {
      throw new Error('Agent bridge is unavailable.')
    }

    const nextSettings = await agentCli.updateSkillLibrarySettings(settings)
    setSkillLibrarySettings(nextSettings)
    setSkillSyncStatus(await agentCli.getSkillSyncStatus())
    setProjectMemoryImportStatus(null)
    setSkillAiMergeProposal(null)
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

    const unsubscribeExit = agentCli.onSessionExit(({ sessionId }) => {
      void closeSessionInWorkspace(sessionId).catch((error) => {
        setErrorMessage(getErrorMessage(error))
      })
    })

    const unsubscribeWindowsCommandPromptExit = agentCli.onWindowsCommandPromptExit(
      ({ sessionId }) => {
        pendingWindowsCommandPromptCloseSessionIdsRef.current.delete(sessionId)
        hideWindowsCommandPrompt(sessionId)
      },
    )

    const unsubscribeFullSyncProgress = agentCli.onFullSyncProgress((event) => {
      setSkillsSyncing(!event.done)
    })

    const unsubscribeFullSyncDone = agentCli.onFullSyncDone(() => {
      setSkillsSyncing(false)
      void refreshSkillState().catch((error) => {
        setSkillsErrorMessage(getErrorMessage(error))
      })
    })

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
        const [settings, status, fullSyncState] = await Promise.all([
          agentCli.getSkillLibrarySettings(),
          agentCli.getSkillSyncStatus(),
          agentCli.getFullSyncState(),
        ])
        setSkillLibrarySettings(settings)
        setSkillSyncStatus(status)
        setSkillsSyncing(fullSyncState.running)
        setSkillsErrorMessage(null)
      } catch (error) {
        setSkillLibrarySettings(null)
        setSkillSyncStatus(null)
        setSkillsSyncing(false)
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
      unsubscribeExit()
      unsubscribeWindowsCommandPromptExit()
      unsubscribeFullSyncProgress()
      unsubscribeFullSyncDone()
    }
  }, [
    agentCli,
    closeSessionInWorkspace,
    hideWindowsCommandPrompt,
    refreshSkillState,
    setInitialData,
    updateConfig,
    updateRuntime,
  ])

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
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    } catch {
      // Ignore preference persistence failures and keep the in-memory state.
    }
  }, [sidebarWidth])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen))
    } catch {
      // Ignore preference persistence failures and keep the in-memory state.
    }
  }, [sidebarOpen])

  useEffect(() => {
    try {
      window.localStorage.setItem(DIFF_PANEL_OPEN_KEY, String(diffPanelOpen))
    } catch {
      // Ignore preference persistence failures and keep the in-memory state.
    }
  }, [diffPanelOpen])

  useEffect(() => {
    try {
      window.localStorage.setItem(DIFF_PANEL_WIDTH_KEY, String(diffPanelWidth))
    } catch {
      // Ignore preference persistence failures and keep the in-memory state.
    }
  }, [diffPanelWidth])

  useEffect(() => {
    return () => {
      paneResizeCleanupRef.current?.()
    }
  }, [])

  useEffect(() => {
    const syncPaneWidths = () => {
      if (isCompactLayout()) {
        return
      }

      if (sidebarOpen && appShellRef.current) {
        setSidebarWidth((current) => clampSidebarWidth(current))
      }

      if (showDiffPanel && workspaceBodyRef.current) {
        setDiffPanelWidth((current) => clampDiffPanelWidth(current))
      }
    }

    syncPaneWidths()
    window.addEventListener('resize', syncPaneWidths)

    return () => {
      window.removeEventListener('resize', syncPaneWidths)
    }
  }, [showDiffPanel, sidebarOpen])

  useEffect(() => {
    if (!projectOpenMenuOpen) {
      return
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) {
        setProjectOpenMenuOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProjectOpenMenuOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [projectOpenMenuOpen])

  useEffect(() => {
    setProjectOpenMenuOpen(false)
  }, [activeWorkspacePath])

  useEffect(() => {
    if (!agentCli || !activeWorkspacePath) {
      setProjectGitOverview(null)
      setProjectGitLoading(false)
      setProjectGitErrorMessage(null)
      setSelectedProjectDiff(null)
      setProjectGitDiffContent(null)
      setProjectGitDiffErrorMessage(null)
      return
    }

    let cancelled = false

    const loadOverview = async (background = false) => {
      if (!background) {
        setProjectGitLoading(true)
      }

      try {
        const overview = await agentCli.getProjectGitOverview(activeWorkspacePath)
        if (cancelled) {
          return
        }

        setProjectGitOverview(overview)
        setProjectGitErrorMessage(null)
      } catch (error) {
        if (cancelled) {
          return
        }

        setProjectGitOverview(null)
        setProjectGitErrorMessage(getErrorMessage(error))
      } finally {
        if (!cancelled) {
          setProjectGitLoading(false)
        }
      }
    }

    void loadOverview()

    const intervalId = window.setInterval(
      () => {
        void loadOverview(true)
      },
      diffPanelOpen ? 5000 : 15000,
    )

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [activeWorkspacePath, agentCli, diffPanelOpen])

  useEffect(() => {
    const availableFiles = [
      ...(projectGitOverview?.unstagedFiles ?? []),
      ...(projectGitOverview?.stagedFiles ?? []),
    ]

    if (availableFiles.length === 0) {
      setSelectedProjectDiff(null)
      setProjectGitDiffContent(null)
      setProjectGitDiffErrorMessage(null)
      return
    }

    const selectionStillExists = selectedProjectDiff
      ? availableFiles.some(
          (file) =>
            file.path === selectedProjectDiff.path &&
            file.staged === selectedProjectDiff.staged,
        )
      : false

    if (!selectionStillExists) {
      const nextSelection = availableFiles[0] ?? null
      setSelectedProjectDiff(
        nextSelection
          ? {
              path: nextSelection.path,
              staged: nextSelection.staged,
            }
          : null,
      )
    }
  }, [projectGitOverview, selectedProjectDiff])

  useEffect(() => {
    if (!agentCli || !activeWorkspacePath || !diffPanelOpen || !selectedProjectDiff) {
      setProjectGitDiffLoading(false)
      setProjectGitDiffContent(null)
      setProjectGitDiffErrorMessage(null)
      return
    }

    let cancelled = false

    void (async () => {
      setProjectGitDiffLoading(true)

      try {
        const diff = await agentCli.getProjectGitDiff(
          activeWorkspacePath,
          selectedProjectDiff.path,
          selectedProjectDiff.staged,
        )
        if (cancelled) {
          return
        }

        setProjectGitDiffContent(diff.patch)
        setProjectGitDiffErrorMessage(null)
      } catch (error) {
        if (cancelled) {
          return
        }

        setProjectGitDiffContent(null)
        setProjectGitDiffErrorMessage(getErrorMessage(error))
      } finally {
        if (!cancelled) {
          setProjectGitDiffLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeWorkspacePath, agentCli, diffPanelOpen, selectedProjectDiff])

  useEffect(() => {
    if (!skillAiMergeProposal || !skillSyncStatus) {
      return
    }

    const stillConflicting = skillSyncStatus.conflicts.some(
      (conflict) => conflict.skillName === skillAiMergeProposal.skillName,
    )

    if (!stillConflicting) {
      setSkillAiMergeProposal(null)
    }
  }, [skillAiMergeProposal, skillSyncStatus])

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
      await closeSessionInWorkspace(id)
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

    const closePending = pendingWindowsCommandPromptCloseSessionIdsRef.current.has(id)
    const currentlyOpen = windowsCommandPromptSessionIds.includes(id)

    try {
      setErrorMessage(null)

      if (closePending) {
        return
      }

      if (currentlyOpen) {
        pendingWindowsCommandPromptCloseSessionIdsRef.current.add(id)
        hideWindowsCommandPrompt(id)

        void agentCli.closeWindowsCommandPrompt(id)
          .catch((error) => {
            if (sessionIdsRef.current.has(id)) {
              showWindowsCommandPrompt(id)
            }

            setErrorMessage(getErrorMessage(error))
          })
          .finally(() => {
            pendingWindowsCommandPromptCloseSessionIdsRef.current.delete(id)
          })
        return
      }

      await agentCli.openWindowsCommandPrompt(id, session.config.cwd)
      showWindowsCommandPrompt(id)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleOpenProject = async (target: ProjectOpenTarget) => {
    if (!agentCli || !activeWorkspacePath) {
      setErrorMessage('There is no active workspace to open.')
      return
    }

    try {
      setErrorMessage(null)
      setProjectOpenMenuOpen(false)
      await agentCli.openProject(target, activeWorkspacePath)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleToggleActiveWindowsCommandPrompt = async () => {
    if (!activeSession) {
      setErrorMessage('There is no active session.')
      return
    }

    await handleToggleWindowsCommandPrompt(activeSession.config.id)
  }

  const handleToggleDiffPanel = () => {
    setDiffPanelOpen((current) => !current)
  }

  const handleRefreshProjectDiff = async () => {
    if (!agentCli || !activeWorkspacePath) {
      return
    }

    setProjectGitLoading(true)

    try {
      const overview = await refreshProjectGitState(activeWorkspacePath)
      setProjectGitErrorMessage(null)

      if (!diffPanelOpen && overview?.isGitRepository) {
        setDiffPanelOpen(true)
      }
    } catch (error) {
      setProjectGitOverview(null)
      setProjectGitErrorMessage(getErrorMessage(error))
    } finally {
      setProjectGitLoading(false)
    }
  }

  const handleSelectProjectDiffFile = (file: ProjectGitFileChange) => {
    setSelectedProjectDiff({
      path: file.path,
      staged: file.staged,
    })
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

  const handleSetPrimaryMergeAgent = async (agent: SkillAiMergeAgent) => {
    await mutateSkillSettings((current) => ({
      ...current,
      primaryMergeAgent: agent,
      reviewMergeAgent:
        current.reviewMergeAgent === agent ? 'none' : current.reviewMergeAgent,
    }))
  }

  const handleSetReviewMergeAgent = async (agent: SkillAiReviewAgent) => {
    await mutateSkillSettings((current) => ({
      ...current,
      reviewMergeAgent: agent === current.primaryMergeAgent ? 'none' : agent,
    }))
  }

  const handleSyncSkills = async () => {
    if (!agentCli) {
      setSkillsErrorMessage('Agent bridge is unavailable.')
      return
    }

    setSkillsErrorMessage(null)
    setSkillsSyncing(true)

    try {
      await agentCli.openSkillSyncWindow(true)
    } catch (error) {
      setSkillsSyncing(false)
      setSkillsErrorMessage(getErrorMessage(error))
    }
  }

  const handleImportHistoricalProjectMemory = async () => {
    if (!agentCli) {
      setSkillsErrorMessage('Agent bridge is unavailable.')
      return
    }

    setProjectMemoryImporting(true)
    setProjectMemoryImportStatus(null)
    setSkillsErrorMessage(null)

    try {
      const result = await agentCli.importHistoricalProjectMemory()
      setProjectMemoryImportStatus(
        result.queuedSessionCount > 0
          ? `Queued ${formatCountLabel(result.queuedSessionCount, 'session', 'sessions')} for background import.`
          : 'No stored sessions were available for import.',
      )
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    } finally {
      setProjectMemoryImporting(false)
    }
  }

  const handleResolveSkillConflict = async (
    skillName: string,
    sourceRoot: SkillSyncRoot,
  ) => {
    if (!agentCli) {
      setSkillsErrorMessage('Agent bridge is unavailable.')
      return
    }

    setSkillsResolving(skillName)
    setSkillsErrorMessage(null)

    try {
      await agentCli.resolveSkillConflict(skillName, sourceRoot)
      await refreshSkillState()
      setSkillAiMergeProposal(null)
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    } finally {
      setSkillsResolving(null)
    }
  }

  const handleGenerateSkillAiMerge = async (skillName: string) => {
    if (!agentCli) {
      setSkillsErrorMessage('Agent bridge is unavailable.')
      return
    }

    setSkillsGeneratingMerge(skillName)
    setSkillsErrorMessage(null)
    setSkillAiMergeProposal(null)

    try {
      const proposal = await agentCli.generateSkillAiMerge(skillName)
      setSkillAiMergeProposal(proposal)
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    } finally {
      setSkillsGeneratingMerge(null)
    }
  }

  const handleApplySkillAiMerge = async () => {
    if (!agentCli || !skillAiMergeProposal) {
      return
    }

    setSkillsApplyingMerge(true)
    setSkillsErrorMessage(null)

    try {
      await agentCli.applySkillAiMerge(skillAiMergeProposal)
      await refreshSkillState()
      setSkillAiMergeProposal(null)
    } catch (error) {
      setSkillsErrorMessage(getErrorMessage(error))
    } finally {
      setSkillsApplyingMerge(false)
    }
  }

  const handleDismissSkillAiMerge = () => {
    setSkillAiMergeProposal(null)
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

  const openFeaturedSessionDialog = () => {
    if (featuredProject) {
      openCreateSessionDialog(featuredProject.config.id, 'project-context')
      return
    }

    openCreateSessionDialog()
  }

  const totalProjectAdditions =
    (projectGitOverview?.unstagedTotals.additions ?? 0) +
    (projectGitOverview?.stagedTotals.additions ?? 0)
  const totalProjectDeletions =
    (projectGitOverview?.unstagedTotals.deletions ?? 0) +
    (projectGitOverview?.stagedTotals.deletions ?? 0)
  const totalProjectChanges =
    (projectGitOverview?.unstagedFiles.length ?? 0) +
    (projectGitOverview?.stagedFiles.length ?? 0)
  const appShellStyle = {
    '--sidebar-width': sidebarOpen ? `${sidebarWidth}px` : '0px',
  } as CSSProperties
  const workspaceBodyStyle = {
    '--diff-panel-width': `${diffPanelWidth}px`,
  } as CSSProperties

  return (
    <div
      ref={appShellRef}
      className={`app-shell${sidebarOpen ? '' : ' app-shell--sidebar-collapsed'}`}
      style={appShellStyle}
    >
      <div className="app-shell__background" aria-hidden="true" />

      <header className="titlebar">
        <button
          type="button"
          className="titlebar__sidebar-toggle"
          aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen((current) => !current)}
        >
          <span className="titlebar__sidebar-toggle-icon" aria-hidden="true" />
        </button>

        <div className="titlebar__brand">
          <div className="titlebar__brand-copy">
            <span className="titlebar__name">{APP_BRAND_NAME}</span>
          </div>
        </div>

        <div className="titlebar__actions">
          <div className="titlebar-menu" ref={projectMenuRef}>
            <button
              type="button"
              className={`titlebar-action titlebar-action--menu${projectOpenMenuOpen ? ' is-active' : ''}`}
              aria-label="Open project"
              aria-expanded={projectOpenMenuOpen}
              disabled={!activeWorkspacePath}
              onClick={() => setProjectOpenMenuOpen((current) => !current)}
            >
              <span className="titlebar-action__label">Open</span>
              <span className="titlebar-action__chevron" aria-hidden="true">
                v
              </span>
            </button>

            {projectOpenMenuOpen ? (
              <div className="titlebar-menu__panel" role="menu" aria-label="Open project">
                <button
                  type="button"
                  className="titlebar-menu__item"
                  role="menuitem"
                  onClick={() => void handleOpenProject('vscode')}
                >
                  <span className="titlebar-menu__item-title">VS Code</span>
                </button>
                <button
                  type="button"
                  className="titlebar-menu__item"
                  role="menuitem"
                  onClick={() => void handleOpenProject('explorer')}
                >
                  <span className="titlebar-menu__item-title">File Explorer</span>
                </button>
                <button
                  type="button"
                  className="titlebar-menu__item"
                  role="menuitem"
                  onClick={() => void handleOpenProject('terminal')}
                >
                  <span className="titlebar-menu__item-title">Terminal</span>
                </button>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={`titlebar-action${activeSessionHasWindowsCommandPrompt ? ' is-active' : ''}`}
            aria-label="Toggle cmd"
            disabled={!activeSession}
            onClick={() => void handleToggleActiveWindowsCommandPrompt()}
          >
            <span className="titlebar-action__label">
              {activeSessionHasWindowsCommandPrompt ? 'Console on' : 'Console'}
            </span>
          </button>

          <button
            type="button"
            className={`titlebar-action${diffPanelOpen ? ' is-active' : ''}`}
            aria-label="Toggle diff panel"
            disabled={!activeWorkspacePath}
            onClick={handleToggleDiffPanel}
          >
            <span className="titlebar-action__label">Diff</span>
            {totalProjectChanges > 0 ? (
              <span className="titlebar-action__counts">
                <span className="titlebar-action__count is-added">
                  +{totalProjectAdditions}
                </span>
                <span className="titlebar-action__count is-removed">
                  -{totalProjectDeletions}
                </span>
              </span>
            ) : null}
          </button>
        </div>
      </header>

      {sidebarOpen ? (
        <SessionSidebar
          projects={projects}
          activeSessionId={activeSessionId}
          showProjectPaths={showProjectPaths}
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
          skillsResolving={skillsResolving}
          skillsGeneratingMerge={skillsGeneratingMerge}
          skillsApplyingMerge={skillsApplyingMerge}
          projectMemoryImporting={projectMemoryImporting}
          projectMemoryImportStatus={projectMemoryImportStatus}
          skillAiMergeProposal={skillAiMergeProposal}
          skillsErrorMessage={skillsErrorMessage}
          onPickSkillLibraryRoot={handlePickSkillLibraryRoot}
          onClearSkillLibraryRoot={handleClearSkillLibraryRoot}
          onOpenSkillLibraryRoot={handleOpenSkillLibraryRoot}
          onSetPrimaryMergeAgent={handleSetPrimaryMergeAgent}
          onSetReviewMergeAgent={handleSetReviewMergeAgent}
          onSyncSkills={handleSyncSkills}
          onImportHistoricalProjectMemory={handleImportHistoricalProjectMemory}
          onResolveSkillConflict={handleResolveSkillConflict}
          onGenerateSkillAiMerge={handleGenerateSkillAiMerge}
          onApplySkillAiMerge={handleApplySkillAiMerge}
          onDismissSkillAiMerge={handleDismissSkillAiMerge}
        />
      ) : null}

      {sidebarOpen ? (
        <button
          type="button"
          className="pane-resizer app-shell__sidebar-resizer"
          aria-label="Resize sidebar"
          onKeyDown={handleSidebarResizerKeyDown}
          onPointerDown={handleSidebarResizerPointerDown}
        />
      ) : null}

      <main className="workspace-shell">
        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <section
          ref={workspaceBodyRef}
          className={`workspace-shell__body${showDiffPanel ? ' workspace-shell__body--with-diff' : ''}`}
          style={workspaceBodyStyle}
        >
          {!hydrated ? (
            <div className="workspace-loading">
              <div>
                <p className="eyebrow">Restoring</p>
                <h2>Restoring previously opened sessions…</h2>
              </div>
            </div>
          ) : showWelcomeWorkspace ? (
            <div className="workspace-home">
              <div className="workspace-home__header">
                <div>
                  <p className="workspace-home__eyebrow">New thread</p>
                  <h1 className="workspace-home__title">Ready to build locally</h1>
                </div>
                <div className="workspace-home__stats" aria-label="Workspace summary">
                  <div className="workspace-home__stat">
                    <span>Projects</span>
                    <strong>{formatCountLabel(projects.length, 'repo', 'repos')}</strong>
                  </div>
                  <div className="workspace-home__stat">
                    <span>Sessions</span>
                    <strong>{formatCountLabel(sessions.length, 'session', 'sessions')}</strong>
                  </div>
                </div>
              </div>

              <div className="workspace-home__hero">
                <div className="workspace-home__logo" aria-hidden="true">
                  <span className="workspace-home__logo-core" />
                </div>
                <div className="workspace-home__hero-copy">
                  <h2>Let&apos;s build</h2>
                  <button
                    type="button"
                    className="workspace-home__repo-button"
                    onClick={featuredProject ? openFeaturedSessionDialog : openCreateProjectDialog}
                  >
                    {featuredProject?.config.title ?? 'agentclis'}
                  </button>
                  <p>
                    Launch a local agent CLI, keep projects grouped in one rail,
                    and inspect diffs without leaving the app.
                  </p>
                </div>
              </div>

              <div className="workspace-home__suggestions">
                <button
                  type="button"
                  className="workspace-home__suggestion"
                  onClick={openFeaturedSessionDialog}
                >
                  <span
                    className="workspace-home__suggestion-icon workspace-home__suggestion-icon--terminal"
                    aria-hidden="true"
                  />
                  <span className="workspace-home__suggestion-title">
                    Start a Codex or Copilot session
                  </span>
                  <span className="workspace-home__suggestion-copy">
                    Open the session flow and launch an agent inside your current repo.
                  </span>
                </button>
                <button
                  type="button"
                  className="workspace-home__suggestion"
                  onClick={openCreateProjectDialog}
                >
                  <span
                    className="workspace-home__suggestion-icon workspace-home__suggestion-icon--folder"
                    aria-hidden="true"
                  />
                  <span className="workspace-home__suggestion-title">
                    Create a project from a local folder
                  </span>
                  <span className="workspace-home__suggestion-copy">
                    Group future sessions under a repo root the way Codex threads do.
                  </span>
                </button>
                <button
                  type="button"
                  className="workspace-home__suggestion"
                  onClick={() => openCreateSessionDialog()}
                >
                  <span
                    className="workspace-home__suggestion-icon workspace-home__suggestion-icon--spark"
                    aria-hidden="true"
                  />
                  <span className="workspace-home__suggestion-title">
                    Choose a project and agent CLI
                  </span>
                  <span className="workspace-home__suggestion-copy">
                    Start a managed session by picking an existing project and provider.
                  </span>
                </button>
              </div>

              <div className="workspace-home__composer">
                <button
                  type="button"
                  className="workspace-home__composer-main"
                  onClick={openFeaturedSessionDialog}
                >
                  {featuredProject
                    ? `Launch a session in ${featuredProject.config.title}`
                    : 'Create your first local agent session'}
                </button>
                <div className="workspace-home__composer-footer">
                  <span className="workspace-home__composer-chip">
                    {featuredProject?.config.rootPath ?? 'Choose a repo root'}
                  </span>
                  <button
                    type="button"
                    className="workspace-home__composer-action"
                    onClick={openCreateProjectDialog}
                  >
                    New project
                  </button>
                  <button
                    type="button"
                    className="workspace-home__composer-action"
                    onClick={() => openCreateSessionDialog()}
                  >
                    New session
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <TerminalWorkspace
              sessions={sessions}
              activeSessionId={activeSessionId}
              windowsCommandPromptSessionIds={windowsCommandPromptSessionIds}
            />
          )}

          {showDiffPanel ? (
            <button
              type="button"
              className="pane-resizer workspace-shell__resizer"
              aria-label="Resize diff panel"
              onKeyDown={handleDiffResizerKeyDown}
              onPointerDown={handleDiffResizerPointerDown}
            />
          ) : null}
          {showDiffPanel ? (
            <ProjectDiffPanel
              overview={projectGitOverview}
              loading={projectGitLoading}
              errorMessage={projectGitErrorMessage}
              selectedFile={selectedProjectDiff}
              diffContent={projectGitDiffContent}
              diffLoading={projectGitDiffLoading}
              diffErrorMessage={projectGitDiffErrorMessage}
              onRefresh={() => void handleRefreshProjectDiff()}
              onSelectFile={handleSelectProjectDiffFile}
            />
          ) : null}
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
