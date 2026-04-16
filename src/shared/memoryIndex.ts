import type {
  ProjectMemoryCandidate,
  ProjectMemoryCandidateKind,
  ProjectMemoryScope,
  ProjectMemoryStatus,
  SessionSummary,
  TranscriptEvent,
  ProjectLocation,
  ProjectIdentity,
} from './projectMemory'
import { PROJECT_MEMORY_CANDIDATE_KINDS } from './projectMemory'
import type {
  ProjectConfig,
  SessionConfig,
} from './session'

export const MEMPALACE_MEMORY_ROOMS = [
  'transcript-raw',
  'decision',
  'workflow',
  'troubleshooting',
  'preference',
  'critical-file',
  'session-summary',
  'architecture',
] as const

export type MempalaceMemoryRoom = (typeof MEMPALACE_MEMORY_ROOMS)[number]

export const MEMPALACE_SOURCE_KINDS = [
  'transcript-raw',
  'session-summary',
  ...PROJECT_MEMORY_CANDIDATE_KINDS,
] as const

export type MempalaceSourceKind = (typeof MEMPALACE_SOURCE_KINDS)[number]

export interface MempalaceMemoryRecord {
  lookupKey: string
  palaceDrawerId: string
  drawerId: string
  sourceFile: string
  sourceLabel: string | null
  projectId: string
  locationId: string | null
  sessionId: string
  eventIds: string[]
  timestampStart: string
  timestampEnd: string
  sourceKind: MempalaceSourceKind
  room: MempalaceMemoryRoom
  wing: string
  chunkIndex?: number
  transcriptPath?: string | null
  candidateId?: string | null
  candidateKind?: ProjectMemoryCandidateKind | null
  scope?: ProjectMemoryScope | null
  memoryKey?: string | null
  confidence?: number | null
  status?: ProjectMemoryStatus | null
}

export interface MempalaceTranscriptChunkMetadata {
  drawerId: string
  projectId: string
  locationId: string | null
  sessionId: string
  eventIds: string[]
  timestampStart: string
  timestampEnd: string
  sourceKind: 'transcript-raw'
  room: 'transcript-raw'
  wing: string
  chunkIndex: number
  eventCount: number
}

export interface MempalaceTranscriptChunk {
  drawerId: string
  content: string
  metadata: MempalaceTranscriptChunkMetadata
}

export interface MempalaceTranscriptProvenanceRecord extends MempalaceMemoryRecord {
  sourceKind: 'transcript-raw'
  room: 'transcript-raw'
  sourceLabel: string | null
  chunkIndex: number
}

export interface MempalaceTranscriptChunkInput {
  project: ProjectConfig
  location: ProjectLocation | null
  session: SessionConfig
  transcript: TranscriptEvent[]
}

export interface MempalaceSessionIndexResult {
  status: 'indexed' | 'skipped' | 'deferred'
  sessionId: string
  indexedCount: number
  skippedCount: number
  warning: string | null
}

export interface MempalaceStructuredMemoryInput {
  project: ProjectConfig
  location: ProjectLocation | null
  session: SessionConfig
  summary: SessionSummary
  candidates: ProjectMemoryCandidate[]
}

export interface MempalaceStructuredIndexResult {
  status: 'indexed' | 'skipped' | 'deferred'
  sessionId: string
  indexedCount: number
  skippedCount: number
  warning: string | null
}

export function deriveMempalaceWing(
  project: Pick<ProjectConfig, 'id' | 'identity'>,
  location?: Pick<ProjectLocation, 'projectId' | 'remoteFingerprint'> | null,
): string {
  const projectIdentity = project.identity as ProjectIdentity | undefined
  const remoteFingerprint = location?.remoteFingerprint ??
    projectIdentity?.remoteFingerprint ??
    null
  return remoteFingerprint?.trim() || project.id
}

export function deriveMempalaceRoomForCandidateKind(
  kind: ProjectMemoryCandidateKind,
): MempalaceMemoryRoom {
  switch (kind) {
    case 'decision':
    case 'fact':
      return 'decision'
    case 'workflow':
    case 'component-workflow':
      return 'workflow'
    case 'troubleshooting-pattern':
    case 'debug-approach':
    case 'user-assist-pattern':
      return 'troubleshooting'
    case 'preference':
    case 'project-convention':
      return 'preference'
    case 'critical-file':
      return 'critical-file'
    default:
      return 'session-summary'
  }
}
