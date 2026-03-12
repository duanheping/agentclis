import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type OpenDialogOptions,
} from 'electron'

import { IPC_CHANNELS } from '../src/shared/ipc'
import { SkillLibraryManager } from './skillLibraryManager'
import { SessionManager } from './sessionManager'
import { WindowsCommandPromptManager } from './windowsCommandPromptManager'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const gotSingleInstanceLock = app.requestSingleInstanceLock()

let mainWindow: BrowserWindow | null = null
let securityHeadersRegistered = false

const skillLibraryManager = new SkillLibraryManager()
const sessionManager = new SessionManager({
  onData: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionData, event)
  },
  onConfig: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionConfig, event)
  },
  onRuntime: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionRuntime, event)
  },
  onExit: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.sessionExit, event)
  },
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
  const useCustomTitleBar = process.platform === 'win32'

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#03070f',
    title: 'Agent CLIs',
    autoHideMenuBar: true,
    titleBarStyle: useCustomTitleBar ? 'hidden' : 'default',
    titleBarOverlay: useCustomTitleBar
      ? {
          color: '#07111f',
          symbolColor: '#d7e2f1',
          height: 46,
        }
      : false,
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.removeMenu()

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.restoreSessions, () => sessionManager.restoreSessions())
  ipcMain.handle(IPC_CHANNELS.listSessions, () => sessionManager.listSessions())
  ipcMain.handle(IPC_CHANNELS.createProject, (_event, input) =>
    sessionManager.createProject(input),
  )
  ipcMain.handle(IPC_CHANNELS.createSession, (_event, input) =>
    sessionManager.createSession(input),
  )
  ipcMain.handle(IPC_CHANNELS.renameSession, (_event, id, title) =>
    sessionManager.renameSession(id, title),
  )
  ipcMain.handle(IPC_CHANNELS.activateSession, (_event, id) =>
    sessionManager.activateSession(id),
  )
  ipcMain.handle(IPC_CHANNELS.restartSession, (_event, id) =>
    sessionManager.restartSession(id),
  )
  ipcMain.handle(IPC_CHANNELS.closeSession, (_event, id) => {
    const result = sessionManager.closeSession(id)
    windowsCommandPromptManager.close(id)
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
    skillLibraryManager.updateSettings(settings),
  )
  ipcMain.handle(IPC_CHANNELS.getSkillSyncStatus, () =>
    skillLibraryManager.getStatus(),
  )
  ipcMain.handle(IPC_CHANNELS.syncSkills, () => skillLibraryManager.sync())
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
    app.setName('Agent CLIs')
    registerSecurityHeaders()
    registerIpcHandlers()
    void skillLibraryManager.syncOnAppStart().catch(() => undefined)
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
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
