import type {
  TranscriptEvent,
  ProjectLocation,
  ProjectIdentity,
} from './projectMemory'
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
  'decision',
  'workflow',
  'troubleshooting',
  'preference',
  'critical-file',
  'session-summary',
  'architecture',
] as const

export type MempalaceSourceKind = (typeof MEMPALACE_SOURCE_KINDS)[number]

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

export interface MempalaceTranscriptProvenanceRecord {
  lookupKey: string
  palaceDrawerId: string
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
  transcriptPath: string | null
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
