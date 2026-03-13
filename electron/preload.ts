import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from 'electron'

import { IPC_CHANNELS, type AgentCliApi } from '../src/shared/ipc'
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
  createProject: (input) => ipcRenderer.invoke(IPC_CHANNELS.createProject, input),
  createSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.createSession, input),
  renameSession: (id, title) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameSession, id, title),
  activateSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.activateSession, id),
  restartSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.restartSession, id),
  closeSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.closeSession, id),
  writeToSession: (id, data) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeToSession, id, data),
  resizeSession: (id, cols, rows) =>
    ipcRenderer.invoke(IPC_CHANNELS.resizeSession, id, cols, rows),
  getSkillLibrarySettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getSkillLibrarySettings),
  updateSkillLibrarySettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateSkillLibrarySettings, settings),
  getSkillSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getSkillSyncStatus),
  syncSkills: () => ipcRenderer.invoke(IPC_CHANNELS.syncSkills),
  resolveSkillConflict: (skillName, sourceRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolveSkillConflict, skillName, sourceRoot),
  generateSkillAiMerge: (skillName) =>
    ipcRenderer.invoke(IPC_CHANNELS.generateSkillAiMerge, skillName),
  applySkillAiMerge: (proposal) =>
    ipcRenderer.invoke(IPC_CHANNELS.applySkillAiMerge, proposal),
  pickDirectory: (defaultPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.pickDirectory, defaultPath),
  openPath: (targetPath) => ipcRenderer.invoke(IPC_CHANNELS.openPath, targetPath),
  openFileReference: (target) =>
    ipcRenderer.invoke(IPC_CHANNELS.openFileReference, target),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listWindowsCommandPrompts: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listWindowsCommandPrompts),
  openWindowsCommandPrompt: (sessionId, cwd) =>
    ipcRenderer.invoke(IPC_CHANNELS.openWindowsCommandPrompt, sessionId, cwd),
  closeWindowsCommandPrompt: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeWindowsCommandPrompt, sessionId),
  writeToWindowsCommandPrompt: (sessionId, data) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeToWindowsCommandPrompt, sessionId, data),
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
