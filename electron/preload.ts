import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { IPC_CHANNELS, type AgentCliApi } from '../src/shared/ipc'
import type {
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
  onSessionData: (listener) =>
    createListener<SessionDataEvent>(IPC_CHANNELS.sessionData, listener),
  onSessionRuntime: (listener) =>
    createListener<SessionRuntimeEvent>(IPC_CHANNELS.sessionRuntime, listener),
  onSessionExit: (listener) =>
    createListener<SessionExitMeta>(IPC_CHANNELS.sessionExit, listener),
}

contextBridge.exposeInMainWorld('agentCli', api)
