/// <reference types="vite/client" />

import type { AgentCliApi } from './shared/ipc'

declare global {
  interface Window {
    agentCli: AgentCliApi
  }
}

export {}
