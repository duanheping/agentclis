import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from 'electron'

import { IPC_CHANNELS, type AgentCliApi } from '../src/shared/ipc'
import type {
  MemoryBackendInstallResult,
  MemoryReindexResult,
  MemoryBackendStatus,
  MemorySearchResult,
} from '../src/shared/memorySearch'
import type {
  FullSyncDone,
  FullSyncProgress,
  FullSyncState,
} from '../src/shared/skills'
import type {
  SessionConfigEvent,
  SessionDataEvent,
  SessionExitMeta,
  SessionRuntimeEvent,
} from '../src/shared/session'

function createListener<T>(
  channel: string,
  listener: (payload: T) => void,
): () => void {
  const subscription = (_event: IpcRendererEvent, payload: T) => {
    listener(payload)
  }

  ipcRenderer.on(channel, subscription)
  return () => ipcRenderer.off(channel, subscription)
}

const api: AgentCliApi = {
  restoreSessions: () => ipcRenderer.invoke(IPC_CHANNELS.restoreSessions),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.listSessions),
  getSessionTerminalReplay: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getSessionTerminalReplay, sessionId),
  getSessionTranscriptPage: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.getSessionTranscriptPage, input),
  updateSessionTerminalSnapshot: (input) => {
    ipcRenderer.send(IPC_CHANNELS.updateSessionTerminalSnapshot, input)
  },
  createProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.createProject, input),
  createSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.createSession, input),
  renameSession: (id, title) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameSession, id, title),
  activateSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.activateSession, id),
  restartSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.restartSession, id),
  closeSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.closeSession, id),
  writeToSession: (id, data) => {
    ipcRenderer.send(IPC_CHANNELS.writeToSession, id, data)
  },
  resizeSession: (id, cols, rows) =>
    ipcRenderer.invoke(IPC_CHANNELS.resizeSession, id, cols, rows),
  getSkillLibrarySettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSkillLibrarySettings),
  updateSkillLibrarySettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSkillLibrarySettings, settings),
  getMemoryBackendStatus: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getMemoryBackendStatus,
    ) as Promise<MemoryBackendStatus>,
  installMemoryRuntime: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.installMemoryRuntime,
    ) as Promise<MemoryBackendInstallResult>,
  searchMemory: (input) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.searchMemory,
      input,
    ) as Promise<MemorySearchResult>,
  reindexMemoryProject: (input) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.reindexMemoryProject,
      input,
    ) as Promise<MemoryReindexResult>,
  analyzeProjectArchitecture: () =>
    ipcRenderer.invoke(IPC_CHANNELS.analyzeProjectArchitecture),
  analyzeProjectSessions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.analyzeProjectSessions),
  openArchitectureAnalysisWindow: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openArchitectureAnalysisWindow),
  openSessionsAnalysisWindow: () =>
    ipcRenderer.invoke(IPC_CHANNELS.openSessionsAnalysisWindow),
  onAnalysisTerminalData: (listener) =>
    createListener<{ chunk: string }>(IPC_CHANNELS.analysisTerminalData, listener),
  onAnalysisTerminalExit: (listener) =>
    createListener<{ exitCode: number; message: string }>(IPC_CHANNELS.analysisTerminalExit, listener),
  writeToAnalysisTerminal: (data) =>
    ipcRenderer.invoke(IPC_CHANNELS.analysisTerminalWrite, data),
  resizeAnalysisTerminal: (cols, rows) =>
    ipcRenderer.invoke(IPC_CHANNELS.analysisTerminalResize, cols, rows),
  getSkillSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getSkillSyncStatus),
  syncSkills: () => ipcRenderer.invoke(IPC_CHANNELS.syncSkills),
  resolveSkillConflict: (skillName, sourceRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveSkillConflict, skillName, sourceRoot),
  generateSkillAiMerge: (skillName) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateSkillAiMerge, skillName),
  applySkillAiMerge: (proposal) =>
    ipcRenderer.invoke(IPC_CHANNELS.applySkillAiMerge, proposal),
  openSkillSyncWindow: (startSync) =>
    ipcRenderer.invoke(IPC_CHANNELS.openSkillSyncWindow, startSync),
  startFullSync: () => ipcRenderer.invoke(IPC_CHANNELS.startFullSync),
  getFullSyncState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getFullSyncState) as Promise<FullSyncState>,
  onFullSyncProgress: (listener) =>
    createListener<FullSyncProgress>(IPC_CHANNELS.fullSyncProgress, listener),
  onFullSyncDone: (listener) =>
    createListener<FullSyncDone>(IPC_CHANNELS.fullSyncDone, listener),
  persistTransientFile: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.persistTransientFile, input),
  pickDirectory: (defaultPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke(IPC_CHANNELS.openPath, targetPath),
  openExternalLink: (target) =>
    ipcRenderer.invoke(IPC_CHANNELS.openExternalLink, target),
  openProject: (target, projectPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.openProject, target, projectPath),
  getProjectGitOverview: (projectPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.getProjectGitOverview, projectPath),
  switchProjectGitBranch: (projectPath, branchName) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.switchProjectGitBranch,
      projectPath,
      branchName,
    ),
  getProjectGitDiff: (projectPath, filePath, staged) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getProjectGitDiff,
      projectPath,
      filePath,
      staged,
    ),
  revertProjectGitFile: (projectPath, file) =>
    ipcRenderer.invoke(IPC_CHANNELS.revertProjectGitFile, projectPath, file),
  openFileReference: (target) =>
    ipcRenderer.invoke(IPC_CHANNELS.openFileReference, target),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listWindowsCommandPrompts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listWindowsCommandPrompts),
  openWindowsCommandPrompt: (sessionId, cwd) =>
    ipcRenderer.invoke(IPC_CHANNELS.openWindowsCommandPrompt, sessionId, cwd),
  closeWindowsCommandPrompt: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeWindowsCommandPrompt, sessionId),
  writeToWindowsCommandPrompt: (sessionId, data) => {
    ipcRenderer.send(IPC_CHANNELS.writeToWindowsCommandPrompt, sessionId, data)
  },
  resizeWindowsCommandPrompt: (sessionId, cols, rows) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.resizeWindowsCommandPrompt,
      sessionId,
      cols,
      rows,
    ),
  onSessionData: (listener) =>
    createListener<SessionDataEvent>(IPC_CHANNELS.sessionData, listener),
  onSessionConfig: (listener) =>
    createListener<SessionConfigEvent>(IPC_CHANNELS.sessionConfig, listener),
  onSessionRuntime: (listener) =>
    createListener<SessionRuntimeEvent>(IPC_CHANNELS.sessionRuntime, listener),
  onSessionExit: (listener) =>
    createListener<SessionExitMeta>(IPC_CHANNELS.sessionExit, listener),
  onWindowsCommandPromptData: (listener) =>
    createListener<SessionDataEvent>(IPC_CHANNELS.windowsCommandPromptData, listener),
  onWindowsCommandPromptExit: (listener) =>
    createListener<SessionExitMeta>(IPC_CHANNELS.windowsCommandPromptExit, listener),
}

contextBridge.exposeInMainWorld('agentCli', api)
