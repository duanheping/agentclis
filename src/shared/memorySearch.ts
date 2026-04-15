export const MEMORY_BACKEND_INSTALL_STATES = [
  'not-installed',
  'installing',
  'installed',
  'failed',
] as const

export type MemoryBackendInstallState =
  (typeof MEMORY_BACKEND_INSTALL_STATES)[number]

export const MEMORY_BACKEND_RUNTIME_STATES = [
  'stopped',
  'starting',
  'running',
  'failed',
] as const

export type MemoryBackendRuntimeState =
  (typeof MEMORY_BACKEND_RUNTIME_STATES)[number]

export interface MemoryBackendStatus {
  backend: 'mempalace'
  repo: string
  commit: string
  installState: MemoryBackendInstallState
  runtimeState: MemoryBackendRuntimeState
  installRoot: string
  palacePath: string
  pythonPath: string | null
  module: string
  message: string | null
  lastError: string | null
}

export interface MemoryBackendInstallResult {
  success: boolean
  status: MemoryBackendStatus
}

export interface MemorySearchRequest {
  query: string
  projectId?: string | null
  locationId?: string | null
  sessionId?: string | null
  wing?: string | null
  room?: string | null
  limit?: number
}

export interface MemorySearchHit {
  id: string
  backend: 'mempalace'
  textPreview: string
  similarity: number | null
  distance: number | null
  projectId?: string | null
  locationId?: string | null
  sessionId?: string | null
  wing?: string | null
  room?: string | null
  timestampStart?: string | null
  timestampEnd?: string | null
  sourceLabel?: string | null
}

export interface MemorySearchResult {
  backend: 'mempalace'
  query: string
  hitCount: number
  hits: MemorySearchHit[]
  warning?: string | null
}
