import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
  type OpenDialogOptions,
} from 'electron'

import { IPC_CHANNELS, type PersistTransientFileInput } from '../src/shared/ipc'
import type { ProjectOpenTarget } from '../src/shared/projectTools'
import type { SessionAttentionKind } from '../src/shared/session'
import {
  formatWorkspaceWindowTitle,
  getSessionAttentionTitleLabel,
  selectHighestPriorityAttentionSession,
} from '../src/shared/sessionAttention'
import type {
  FullSyncDone,
  FullSyncProgress,
  FullSyncState,
} from '../src/shared/skills'
import { openExternalLinkTarget } from './externalLinks'
import { openFileReferenceTarget } from './fileReferences'
import {
  getProjectGitDiff,
  getProjectGitOverview,
  openProjectInTarget,
} from './projectTools'
import { ProjectArchitectureAgentExtractor } from './projectArchitectureAgent'
import { ProjectMemoryAgentExtractor } from './projectMemoryAgent'
import { ProjectMemoryManager } from './projectMemoryManager'
import { ProjectIdentityResolver } from './projectIdentity'
import { ProjectMemoryService } from './projectMemoryService'
import { SkillLibraryManager } from './skillLibraryManager'
import { SessionManager } from './sessionManager'
import { TransientFileStore } from './transientFileStore'
import { TranscriptStore } from './transcriptStore'
import { WindowsCommandPromptManager } from './windowsCommandPromptManager'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const gotSingleInstanceLock = app.requestSingleInstanceLock()
const APP_BRAND_NAME = 'Agent CLIs'

let mainWindow: BrowserWindow | null = null
let skillSyncWindow: BrowserWindow | null = null
let securityHeadersRegistered = false
let fullSyncRun: Promise<FullSyncDone> | null = null
let currentWindowAttentionKey: string | null = null
let fullSyncState: FullSyncState = {
  running: false,
  progress: null,
  result: null,
}

const skillLibraryManager = new SkillLibraryManager()
const transientFileStore = new TransientFileStore()
const projectIdentityResolver = new ProjectIdentityResolver()
const transcriptStore = new TranscriptStore()
const projectMemoryManager = new ProjectMemoryManager(
  () => skillLibraryManager.getSettings().libraryRoot,
  new ProjectMemoryAgentExtractor(
    () => skillLibraryManager.getSettings().primaryMergeAgent,
  ),
  new ProjectArchitectureAgentExtractor(
    () => skillLibraryManager.getSettings().primaryMergeAgent,
  ),
)
const projectMemoryService = new ProjectMemoryService(
  projectMemoryManager,
  transcriptStore,
)
const sessionManager = new SessionManager({
  onData: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionData, event)
  },
  onConfig: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionConfig, event)
    updateMainWindowShell()
  },
  onRuntime: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionRuntime, event)
    updateMainWindowShell()
  },
  onExit: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionExit, event)
  },
}, {
  identityResolver: projectIdentityResolver,
  transcriptStore,
  projectMemory: projectMemoryService,
})

const windowsCommandPromptManager = new WindowsCommandPromptManager({
  onData: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.windowsCommandPromptData, event)
  },
  onExit: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.windowsCommandPromptExit, event)
  },
})

function getPreloadPath(): string {
  return path.join(__dirname, 'preload.mjs')
}

function cloneFullSyncState(): FullSyncState {
  return structuredClone(fullSyncState)
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }

    window.webContents.send(channel, payload)
  }
}

function createAttentionOverlayIcon(
  attention: SessionAttentionKind,
) {
  const fill = attention === 'needs-user-decision' ? '#f59e0b' : '#22c55e'
  const centerMarkup =
    attention === 'needs-user-decision'
      ? '<path d="M32 17c-5.8 0-10.5 4.7-10.5 10.5h6c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5c0 1.9-1.1 3-3.4 4.5-2.9 1.9-4.6 4-4.6 8.5h6c0-2.3.7-3.2 2.5-4.4 2.6-1.7 5.5-4 5.5-8.6C42.5 21.7 37.8 17 32 17Z" fill="#fff"/><circle cx="32" cy="47.5" r="3.8" fill="#fff"/>'
      : '<path d="M19 33.5l8.2 8.2L45 24" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
    `<circle cx="32" cy="32" r="28" fill="${fill}"/>`,
    centerMarkup,
    '</svg>',
  ].join('')

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  )
}

const attentionOverlayIcons = {
  'needs-user-decision': createAttentionOverlayIcon('needs-user-decision'),
  'task-complete': createAttentionOverlayIcon('task-complete'),
} as const

function updateMainWindowShell(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    currentWindowAttentionKey = null
    return
  }

  const workspace = sessionManager.listSessions()
  mainWindow.setTitle(formatWorkspaceWindowTitle(workspace, APP_BRAND_NAME))

  const attentionSession = selectHighestPriorityAttentionSession(workspace)
  const attention = attentionSession?.runtime.attention ?? null
  const nextAttentionKey =
    attention && attentionSession
      ? `${attentionSession.config.id}:${attention}`
      : null

  if (process.platform === 'win32') {
    if (attention && attentionSession) {
      mainWindow.setOverlayIcon(
        attentionOverlayIcons[attention],
        `${getSessionAttentionTitleLabel(attention)}: ${attentionSession.config.title}`,
      )
    } else {
      mainWindow.setOverlayIcon(null, '')
    }
  }

  if (!attention) {
    mainWindow.flashFrame(false)
    currentWindowAttentionKey = null
    return
  }

  if (nextAttentionKey !== currentWindowAttentionKey && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true)
  }

  currentWindowAttentionKey = nextAttentionKey
}

async function loadRendererWindow(
  window: BrowserWindow,
  view: 'main' | 'skill-sync',
): Promise<void> {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL)

    if (view === 'skill-sync') {
      url.searchParams.set('view', 'skill-sync')
    }

    await window.loadURL(url.toString())
    return
  }

  await window.loadFile(path.join(__dirname, '../dist/index.html'), {
    search: view === 'skill-sync' ? '?view=skill-sync' : '',
  })
}

function createWindowOptions(title: string, width: number, height: number) {
  const useCustomTitleBar = process.platform === 'win32'

  return {
    width,
    height,
    backgroundColor: '#111111',
    title,
    autoHideMenuBar: true,
    titleBarStyle: useCustomTitleBar ? 'hidden' : 'default',
    titleBarOverlay: useCustomTitleBar
      ? {
          color: '#1b2026',
          symbolColor: '#f4f4f5',
          height: 38,
        }
      : false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  } as const
}

async function createSkillSyncWindow(): Promise<BrowserWindow> {
  if (skillSyncWindow && !skillSyncWindow.isDestroyed()) {
    return skillSyncWindow
  }

  skillSyncWindow = new BrowserWindow({
    ...createWindowOptions('Skill Sync', 860, 720),
    minWidth: 700,
    minHeight: 560,
  })
  skillSyncWindow.removeMenu()
  await loadRendererWindow(skillSyncWindow, 'skill-sync')
  skillSyncWindow.on('closed', () => {
    skillSyncWindow = null
  })

  return skillSyncWindow
}

function startFullSyncIfNeeded(): FullSyncState {
  if (fullSyncRun) {
    return cloneFullSyncState()
  }

  fullSyncState = {
    running: true,
    progress: null,
    result: null,
  }

  fullSyncRun = skillLibraryManager
    .fullSync((progress: FullSyncProgress) => {
      fullSyncState = {
        running: !progress.done,
        progress: structuredClone(progress),
        result: null,
      }
      broadcastToAllWindows(IPC_CHANNELS.fullSyncProgress, progress)
    })
    .then((result) => {
      fullSyncState = {
        running: false,
        progress: fullSyncState.progress,
        result: structuredClone(result),
      }
      broadcastToAllWindows(IPC_CHANNELS.fullSyncDone, result)
      return result
    })
    .finally(() => {
      fullSyncRun = null
    })

  return cloneFullSyncState()
}

async function openSkillSyncWindow(startSync = false): Promise<void> {
  if (startSync) {
    startFullSyncIfNeeded()
  }

  const window = await createSkillSyncWindow()

  if (window.isMinimized()) {
    window.restore()
  }

  window.show()
  window.focus()
}

function buildContentSecurityPolicy(): string {
  if (process.env.VITE_DEV_SERVER_URL) {
    return [
      "default-src 'self'",
      // Vite React injects an inline preamble in development.
      "script-src 'self' 'unsafe-inline' http://localhost:* http://127.0.0.1:*",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ')
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}

function registerSecurityHeaders(): void {
  if (securityHeadersRegistered) {
    return
  }

  securityHeadersRegistered = true
  const csp = buildContentSecurityPolicy()

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({ responseHeaders: details.responseHeaders })
      return
    }

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    ...createWindowOptions(APP_BRAND_NAME, 1480, 960),
    minWidth: 1180,
    minHeight: 760,
  })
  mainWindow.removeMenu()
  await loadRendererWindow(mainWindow, 'main')
  updateMainWindowShell()

  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false)
  })

  mainWindow.on('closed', () => {
    currentWindowAttentionKey = null
    mainWindow = null
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.restoreSessions, async () => {
    const result = await sessionManager.restoreSessions()
    updateMainWindowShell()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.listSessions, () => sessionManager.listSessions())
  ipcMain.handle(IPC_CHANNELS.createProject, (_event, input) =>
    sessionManager.createProject(input),
  )
  ipcMain.handle(IPC_CHANNELS.createSession, async (_event, input) => {
    const result = await sessionManager.createSession(input)
    updateMainWindowShell()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.renameSession, (_event, id, title) =>
    sessionManager.renameSession(id, title),
  )
  ipcMain.handle(IPC_CHANNELS.activateSession, async (_event, id) => {
    await sessionManager.activateSession(id)
    updateMainWindowShell()
  })
  ipcMain.handle(IPC_CHANNELS.restartSession, async (_event, id) => {
    const result = await sessionManager.restartSession(id)
    updateMainWindowShell()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.closeSession, async (_event, id) => {
    const result = await sessionManager.closeSession(id)
    windowsCommandPromptManager.close(id)
    updateMainWindowShell()
    return result
  })
  ipcMain.handle(IPC_CHANNELS.writeToSession, (_event, id, data) =>
    sessionManager.writeToSession(id, data),
  )
  ipcMain.handle(IPC_CHANNELS.resizeSession, (_event, id, cols, rows) =>
    sessionManager.resizeSession(id, cols, rows),
  )
  ipcMain.handle(IPC_CHANNELS.getSkillLibrarySettings, () =>
    skillLibraryManager.getSettings(),
  )
  ipcMain.handle(IPC_CHANNELS.updateSkillLibrarySettings, (_event, settings) =>
    {
      const nextSettings = skillLibraryManager.updateSettings(settings)
      projectMemoryService.resume()
      sessionManager.scheduleProjectMemoryBackfill()
      return nextSettings
    },
  )
  ipcMain.handle(IPC_CHANNELS.importHistoricalProjectMemory, async () =>
    sessionManager.queueHistoricalProjectMemoryImport(),
  )
  ipcMain.handle(IPC_CHANNELS.getSkillSyncStatus, () =>
    skillLibraryManager.getStatus(),
  )
  ipcMain.handle(IPC_CHANNELS.syncSkills, () => skillLibraryManager.sync())
  ipcMain.handle(
    IPC_CHANNELS.resolveSkillConflict,
    (_event, skillName: string, sourceRoot) =>
      skillLibraryManager.resolveConflict(skillName, sourceRoot),
  )
  ipcMain.handle(IPC_CHANNELS.generateSkillAiMerge, (_event, skillName: string) =>
    skillLibraryManager.generateAiMerge(skillName),
  )
  ipcMain.handle(IPC_CHANNELS.applySkillAiMerge, (_event, proposal) =>
    skillLibraryManager.applyAiMerge(proposal),
  )
  ipcMain.handle(IPC_CHANNELS.openSkillSyncWindow, (_event, startSync = false) =>
    openSkillSyncWindow(Boolean(startSync)),
  )
  ipcMain.handle(IPC_CHANNELS.startFullSync, () => startFullSyncIfNeeded())
  ipcMain.handle(IPC_CHANNELS.getFullSyncState, () => cloneFullSyncState())
  ipcMain.handle(
    IPC_CHANNELS.persistTransientFile,
    (_event, input: PersistTransientFileInput) => transientFileStore.persist(input),
  )
  ipcMain.handle(IPC_CHANNELS.pickDirectory, async (_event, defaultPath?: string) => {
    const options: OpenDialogOptions = {
      title: 'Select project folder',
      defaultPath,
      properties: ['openDirectory'],
    }

    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled) {
      return null
    }

    return result.filePaths[0] ?? null
  })
  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, targetPath: string) => {
    const normalizedPath = targetPath.trim()
    if (!normalizedPath) {
      throw new Error('Path is required.')
    }

    const message = await shell.openPath(normalizedPath)
    if (message) {
      throw new Error(message)
    }
  })
  ipcMain.handle(IPC_CHANNELS.openExternalLink, (_event, target: string) =>
    openExternalLinkTarget(target, shell),
  )
  ipcMain.handle(
    IPC_CHANNELS.openProject,
    (_event, target: ProjectOpenTarget, projectPath: string) =>
      openProjectInTarget(target, projectPath, shell),
  )
  ipcMain.handle(IPC_CHANNELS.getProjectGitOverview, (_event, projectPath: string) =>
    getProjectGitOverview(projectPath),
  )
  ipcMain.handle(
    IPC_CHANNELS.getProjectGitDiff,
    (_event, projectPath: string, filePath: string, staged: boolean) =>
      getProjectGitDiff(projectPath, filePath, staged),
  )
  ipcMain.handle(IPC_CHANNELS.openFileReference, (_event, target: string) =>
    openFileReferenceTarget(target, shell),
  )
  ipcMain.handle(IPC_CHANNELS.listWindowsCommandPrompts, () =>
    windowsCommandPromptManager.listOpenSessionIds(),
  )
  ipcMain.handle(
    IPC_CHANNELS.openWindowsCommandPrompt,
    (_event, sessionId: string, cwd: string) =>
      windowsCommandPromptManager.open(sessionId, cwd),
  )
  ipcMain.handle(IPC_CHANNELS.closeWindowsCommandPrompt, (_event, sessionId: string) =>
    windowsCommandPromptManager.close(sessionId),
  )
  ipcMain.handle(
    IPC_CHANNELS.writeToWindowsCommandPrompt,
    (_event, sessionId: string, data: string) =>
      windowsCommandPromptManager.write(sessionId, data),
  )
  ipcMain.handle(
    IPC_CHANNELS.resizeWindowsCommandPrompt,
    (_event, sessionId: string, cols: number, rows: number) =>
      windowsCommandPromptManager.resize(sessionId, cols, rows),
  )
}

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', async () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }

      mainWindow.show()
      mainWindow.focus()
      return
    }

    if (app.isReady()) {
      await createMainWindow()
    }
  })

  app.whenReady().then(async () => {
    app.setName(APP_BRAND_NAME)
    registerSecurityHeaders()
    registerIpcHandlers()
    await createMainWindow()

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow()
      }
    })
  })

  app.on('before-quit', () => {
    windowsCommandPromptManager.dispose()
    sessionManager.dispose()
    void transientFileStore.dispose()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
