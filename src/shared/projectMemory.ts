export const PROJECT_MEMORY_CANDIDATE_KINDS = [
  'fact',
  'decision',
  'preference',
  'workflow',
] as const

export type ProjectMemoryCandidateKind =
  (typeof PROJECT_MEMORY_CANDIDATE_KINDS)[number]

export const PROJECT_MEMORY_SCOPES = ['project', 'location'] as const

export type ProjectMemoryScope = (typeof PROJECT_MEMORY_SCOPES)[number]

export const PROJECT_MEMORY_STATUSES = ['active', 'stale', 'conflicted'] as const

export type ProjectMemoryStatus = (typeof PROJECT_MEMORY_STATUSES)[number]

export const TRANSCRIPT_EVENT_KINDS = ['input', 'output', 'runtime', 'system'] as const

export type TranscriptEventKind = (typeof TRANSCRIPT_EVENT_KINDS)[number]

export const TRANSCRIPT_EVENT_SOURCES = ['user', 'system', 'pty'] as const

export type TranscriptEventSource = (typeof TRANSCRIPT_EVENT_SOURCES)[number]

export interface ProjectIdentity {
  repoRoot: string | null
  gitCommonDir: string | null
  remoteFingerprint: string | null
}

export interface LogicalProject {
  id: string
  title: string
  rootPath: string
  createdAt: string
  updatedAt: string
  primaryLocationId: string | null
  identity: ProjectIdentity
}

export interface ProjectLocation {
  id: string
  projectId: string
  rootPath: string
  repoRoot: string | null
  gitCommonDir: string | null
  remoteFingerprint: string | null
  label: string
  createdAt: string
  updatedAt: string
  lastSeenAt: string
}

export interface TranscriptEvent {
  id: string
  sessionId: string
  projectId: string
  locationId: string | null
  timestamp: string
  kind: TranscriptEventKind
  source: TranscriptEventSource
  chunk?: string
  metadata?: Record<string, boolean | number | string | null>
}

export interface SessionSummary {
  sessionId: string
  projectId: string
  locationId: string | null
  generatedAt: string
  summary: string
  sourceEventIds: string[]
}

export interface ProjectMemoryCandidate {
  id: string
  projectId: string
  locationId: string | null
  kind: ProjectMemoryCandidateKind
  scope: ProjectMemoryScope
  key: string
  content: string
  confidence: number
  status: ProjectMemoryStatus
  createdAt: string
  updatedAt: string
  sourceSessionId: string
  sourceEventIds: string[]
}

export interface ProjectMemorySnapshot {
  summary: SessionSummary | null
  facts: ProjectMemoryCandidate[]
  decisions: ProjectMemoryCandidate[]
  preferences: ProjectMemoryCandidate[]
  workflows: ProjectMemoryCandidate[]
}

export interface AssembledProjectContext {
  projectId: string
  locationId: string | null
  generatedAt: string
  bootstrapMessage: string | null
  fileReferences: string[]
  summaryExcerpt: string | null
  architectureExcerpt?: string | null
}
