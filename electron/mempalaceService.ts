import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  MemoryBackendInstallResult,
  MemoryReindexResult,
  MemoryBackendStatus,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySearchResult,
} from '../src/shared/memorySearch'
import type {
  MempalaceLegacyImportBundle,
  MempalaceLegacyImportResult,
  MempalaceMemoryRecord,
  MempalaceMemoryRecordInput,
  MempalaceStructuredIndexResult,
  MempalaceStructuredMemoryInput,
  MempalaceSessionIndexResult,
  MempalaceTranscriptChunkInput,
  MempalaceTranscriptProvenanceRecord,
} from '../src/shared/memoryIndex'
import {
  deriveMempalaceWing,
  deriveMempalaceRoomForCandidateKind,
} from '../src/shared/memoryIndex'
import {
  MempalaceBridge,
  type MempalaceSearchResponse,
} from './mempalaceBridge'
import { MempalaceIndexer } from './mempalaceIndexer'
import { MempalaceRuntime } from './mempalaceRuntime'
import { writeUtf8FileAtomic } from './atomicFile'

const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
const MAX_PREVIEW_LENGTH = 280
const DEFAULT_INDEX_STATE_PATH = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'agentclis',
  'mempalace',
  'provenance.json',
)

interface MempalaceIndexState {
  recordsByLookupKey: Record<string, MempalaceMemoryRecord>
  recordsBySourceFile: Record<string, MempalaceMemoryRecord>
}

interface RuntimeContract {
  getStatus(): Promise<MemoryBackendStatus>
  installRuntime(): Promise<MemoryBackendInstallResult>
}

interface BridgeContract {
  search(input: {
    query: string
    limit?: number
    wing?: string | null
    room?: string | null
    context?: string | null
  }): Promise<MempalaceSearchResponse>
  addDrawer(input: {
    wing: string
    room: string
    content: string
    source_file?: string
  }): Promise<Record<string, unknown>>
}

function clampSearchLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SEARCH_LIMIT
  }

  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(value ?? DEFAULT_SEARCH_LIMIT)))
}

function buildHitId(
  query: string,
  result: Record<string, unknown>,
  index: number,
): string {
  const hash = createHash('sha1')
  hash.update(query)
  hash.update('\u0000')
  hash.update(String(result.wing ?? ''))
  hash.update('\u0000')
  hash.update(String(result.room ?? ''))
  hash.update('\u0000')
  hash.update(String(result.text ?? ''))
  hash.update('\u0000')
  hash.update(String(index))
  return hash.digest('hex')
}

function buildTextPreview(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= MAX_PREVIEW_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, MAX_PREVIEW_LENGTH - 3).trimEnd()}...`
}

function buildLookupKey(wing: string, room: string, content: string): string {
  const hash = createHash('sha1')
  hash.update(wing)
  hash.update('\u0000')
  hash.update(room)
  hash.update('\u0000')
  hash.update(content)
  return hash.digest('hex')
}

function buildTranscriptSourceFile(sessionId: string, chunkIndex: number): string {
  return `mempalace://transcript/${sessionId}/${chunkIndex}`
}

function buildSummarySourceFile(sessionId: string): string {
  return `mempalace://summary/${sessionId}`
}

function buildCandidateSourceFile(
  sessionId: string,
  candidateKind: string,
  candidateId: string,
): string {
  return `mempalace://candidate/${sessionId}/${candidateKind}/${candidateId}`
}

function buildSummarySourceLabel(): string {
  return 'Session summary'
}

function buildCandidateSourceLabel(
  candidateKind: string,
  candidateKey: string,
): string {
  return `${candidateKind}:${candidateKey}`
}

function mapSearchHit(
  query: string,
  result: Record<string, unknown>,
  index: number,
  provenance: MempalaceMemoryRecord | null,
): MemorySearchHit {
  const text = typeof result.text === 'string' ? result.text : ''
  const wing = typeof result.wing === 'string' ? result.wing : null
  const room = typeof result.room === 'string' ? result.room : null
  const sourceFile =
    typeof result.source_file === 'string' ? result.source_file : null
  const similarity =
    typeof result.similarity === 'number' ? result.similarity : null
  const distance =
    typeof result.distance === 'number' ? result.distance : null

  return {
    id: buildHitId(query, result, index),
    backend: 'mempalace',
    textPreview: buildTextPreview(text),
    similarity,
    distance,
    wing,
    room,
    sourceLabel: provenance?.sourceLabel ?? sourceFile ?? null,
    projectId: provenance?.projectId ?? null,
    locationId: provenance?.locationId ?? null,
    sessionId: provenance?.sessionId?.trim() ? provenance.sessionId : null,
    timestampStart: provenance?.timestampStart ?? null,
    timestampEnd: provenance?.timestampEnd ?? null,
  }
}

interface MempalaceServiceOptions {
  indexStatePath?: string
  indexer?: MempalaceIndexer
}

export class MempalaceService {
  private readonly runtime: RuntimeContract
  private readonly bridge: BridgeContract
  private readonly indexStatePath: string
  private readonly indexer: MempalaceIndexer
  private indexStatePromise: Promise<MempalaceIndexState> | null = null

  constructor(
    runtime: RuntimeContract = new MempalaceRuntime(),
    bridge: BridgeContract = new MempalaceBridge(runtime as MempalaceRuntime),
    options: MempalaceServiceOptions = {},
  ) {
    this.runtime = runtime
    this.bridge = bridge
    this.indexStatePath = options.indexStatePath ?? DEFAULT_INDEX_STATE_PATH
    this.indexer = options.indexer ?? new MempalaceIndexer()
  }

  async getStatus(): Promise<MemoryBackendStatus> {
    return await this.runtime.getStatus()
  }

  async installRuntime(): Promise<MemoryBackendInstallResult> {
    return await this.runtime.installRuntime()
  }

  async indexSessionTranscript(
    input: MempalaceTranscriptChunkInput & {
      transcriptPath?: string | null
    },
  ): Promise<MempalaceSessionIndexResult> {
    const status = await this.runtime.getStatus()
    if (status.installState !== 'installed') {
      return {
        status: 'deferred',
        sessionId: input.session.id,
        indexedCount: 0,
        skippedCount: 0,
        warning: status.message ?? 'MemPalace runtime is not installed.',
      }
    }

    const chunks = this.indexer.buildTranscriptChunks(input)
    if (chunks.length === 0) {
      return {
        status: 'skipped',
        sessionId: input.session.id,
        indexedCount: 0,
        skippedCount: 0,
        warning: null,
      }
    }

    const indexState = await this.loadIndexState()
    let indexedCount = 0

    for (const chunk of chunks) {
      const sourceFile = buildTranscriptSourceFile(
        input.session.id,
        chunk.metadata.chunkIndex,
      )
      const addResult = await this.bridge.addDrawer({
        wing: chunk.metadata.wing,
        room: chunk.metadata.room,
        content: chunk.content,
        source_file: sourceFile,
      })
      const success = addResult.success === true
      const palaceDrawerId =
        typeof addResult.drawer_id === 'string' ? addResult.drawer_id : null

      if (!success || !palaceDrawerId) {
        const message =
          typeof addResult.error === 'string'
            ? addResult.error
            : 'MemPalace failed to add a transcript drawer.'
        throw new Error(message)
      }

      const lookupKey = buildLookupKey(
        chunk.metadata.wing,
        chunk.metadata.room,
        chunk.content,
      )
      const record: MempalaceTranscriptProvenanceRecord = {
        lookupKey,
        palaceDrawerId,
        drawerId: chunk.drawerId,
        sourceFile,
        sourceLabel: input.transcriptPath ?? `${input.session.id}.jsonl`,
        projectId: chunk.metadata.projectId,
        locationId: chunk.metadata.locationId,
        sessionId: chunk.metadata.sessionId,
        eventIds: [...chunk.metadata.eventIds],
        timestampStart: chunk.metadata.timestampStart,
        timestampEnd: chunk.metadata.timestampEnd,
        sourceKind: chunk.metadata.sourceKind,
        room: chunk.metadata.room,
        wing: chunk.metadata.wing,
        transcriptPath: input.transcriptPath ?? null,
        chunkIndex: chunk.metadata.chunkIndex,
      }
      this.upsertRecord(indexState, record)
      indexedCount += 1
    }

    await this.persistIndexState(indexState)

    return {
      status: 'indexed',
      sessionId: input.session.id,
      indexedCount,
      skippedCount: 0,
      warning: null,
    }
  }

  async indexStructuredSessionMemory(
    input: MempalaceStructuredMemoryInput,
  ): Promise<MempalaceStructuredIndexResult> {
    const status = await this.runtime.getStatus()
    if (status.installState !== 'installed') {
      return {
        status: 'deferred',
        sessionId: input.session.id,
        indexedCount: 0,
        skippedCount: 0,
        warning: status.message ?? 'MemPalace runtime is not installed.',
      }
    }

    const wing = deriveMempalaceWing(input.project, input.location)
    const indexState = await this.loadIndexState()
    let indexedCount = 0

    const summaryText = input.summary.summary.trim()
    if (summaryText) {
      const sourceFile = buildSummarySourceFile(input.session.id)
      const addResult = await this.bridge.addDrawer({
        wing,
        room: 'session-summary',
        content: summaryText,
        source_file: sourceFile,
      })
      const success = addResult.success === true
      const palaceDrawerId =
        typeof addResult.drawer_id === 'string' ? addResult.drawer_id : null
      if (!success || !palaceDrawerId) {
        const message =
          typeof addResult.error === 'string'
            ? addResult.error
            : 'MemPalace failed to add a session summary drawer.'
        throw new Error(message)
      }

      const summaryRecord: MempalaceMemoryRecord = {
        lookupKey: buildLookupKey(wing, 'session-summary', summaryText),
        palaceDrawerId,
        drawerId: `summary:${input.session.id}`,
        sourceFile,
        sourceLabel: buildSummarySourceLabel(),
        projectId: input.project.id,
        locationId: input.location?.id ?? null,
        sessionId: input.session.id,
        eventIds: [...input.summary.sourceEventIds],
        timestampStart: input.summary.generatedAt,
        timestampEnd: input.summary.generatedAt,
        sourceKind: 'session-summary',
        room: 'session-summary',
        wing,
      }
      this.upsertRecord(indexState, summaryRecord)
      indexedCount += 1
    }

    for (const candidate of input.candidates) {
      const content = candidate.content.trim()
      if (!content) {
        continue
      }

      const room = deriveMempalaceRoomForCandidateKind(candidate.kind)
      const sourceFile = buildCandidateSourceFile(
        input.session.id,
        candidate.kind,
        candidate.id,
      )
      const addResult = await this.bridge.addDrawer({
        wing,
        room,
        content,
        source_file: sourceFile,
      })
      const success = addResult.success === true
      const palaceDrawerId =
        typeof addResult.drawer_id === 'string' ? addResult.drawer_id : null
      if (!success || !palaceDrawerId) {
        const message =
          typeof addResult.error === 'string'
            ? addResult.error
            : 'MemPalace failed to add a structured memory drawer.'
        throw new Error(message)
      }

      const record: MempalaceMemoryRecord = {
        lookupKey: buildLookupKey(wing, room, content),
        palaceDrawerId,
        drawerId: candidate.id,
        sourceFile,
        sourceLabel: buildCandidateSourceLabel(candidate.kind, candidate.key),
        projectId: candidate.projectId,
        locationId: candidate.locationId,
        sessionId: candidate.sourceSessionId,
        eventIds: [...candidate.sourceEventIds],
        timestampStart: candidate.createdAt,
        timestampEnd: candidate.updatedAt,
        sourceKind: candidate.kind,
        room,
        wing,
        candidateId: candidate.id,
        candidateKind: candidate.kind,
        scope: candidate.scope,
        memoryKey: candidate.key,
        confidence: candidate.confidence,
        status: candidate.status,
      }
      this.upsertRecord(indexState, record)
      indexedCount += 1
    }

    if (indexedCount === 0) {
      return {
        status: 'skipped',
        sessionId: input.session.id,
        indexedCount: 0,
        skippedCount: 0,
        warning: null,
      }
    }

    await this.persistIndexState(indexState)

    return {
      status: 'indexed',
      sessionId: input.session.id,
      indexedCount,
      skippedCount: 0,
      warning: null,
    }
  }

  async importLegacyProjectMemory(
    input: MempalaceLegacyImportBundle,
  ): Promise<MempalaceLegacyImportResult> {
    const status = await this.runtime.getStatus()
    if (status.installState !== 'installed') {
      return {
        status: 'deferred',
        projectId: input.projectId,
        indexedCount: 0,
        warning: status.message ?? 'MemPalace runtime is not installed.',
      }
    }

    if (input.records.length === 0) {
      return {
        status: 'skipped',
        projectId: input.projectId,
        indexedCount: 0,
        warning: null,
      }
    }

    const indexState = await this.loadIndexState()
    let indexedCount = 0

    for (const record of input.records) {
      await this.persistMemoryRecord(indexState, record)
      indexedCount += 1
    }

    await this.persistIndexState(indexState)

    return {
      status: 'indexed',
      projectId: input.projectId,
      indexedCount,
      warning: null,
    }
  }

  async search(input: MemorySearchRequest): Promise<MemorySearchResult> {
    const query = input.query.trim()
    if (!query) {
      return {
        backend: 'mempalace',
        query: input.query,
        hitCount: 0,
        hits: [],
        warning: 'Enter a search query to search MemPalace.',
      }
    }

    try {
      const response = await this.bridge.search({
        query,
        limit: clampSearchLimit(input.limit),
        wing: input.wing ?? input.projectId ?? null,
        room: input.room ?? null,
        context: input.sessionId ?? null,
      })

      if (typeof response.error === 'string' && response.error.trim()) {
        return {
          backend: 'mempalace',
          query,
          hitCount: 0,
          hits: [],
          warning: response.error,
        }
      }

      const indexState = await this.loadIndexState()
      const rawResults = Array.isArray(response.results) ? response.results : []
      const hits = rawResults
        .filter((result): result is Record<string, unknown> =>
          typeof result === 'object' && result !== null,
        )
        .map((result, index) => {
          const text = typeof result.text === 'string' ? result.text : ''
          const wing = typeof result.wing === 'string' ? result.wing : ''
          const room = typeof result.room === 'string' ? result.room : ''
          const sourceFile =
            typeof result.source_file === 'string' ? result.source_file : null
          const provenance =
            (sourceFile
              ? indexState.recordsBySourceFile[sourceFile] ?? null
              : null) ??
            indexState.recordsByLookupKey[buildLookupKey(wing, room, text)] ??
            null
          return mapSearchHit(query, result, index, provenance)
        })

      return {
        backend: 'mempalace',
        query,
        hitCount: hits.length,
        hits,
        warning:
          typeof response.error === 'string' ? response.error : null,
      }
    } catch (error) {
      return {
        backend: 'mempalace',
        query,
        hitCount: 0,
        hits: [],
        warning: error instanceof Error ? error.message : String(error),
      }
    }
  }

  buildEmptyReindexResult(projectId: string | null): MemoryReindexResult {
    return {
      backend: 'mempalace',
      projectId,
      sessionsScanned: 0,
      sessionsIndexed: 0,
      sessionsDeferred: 0,
      sessionsSkipped: 0,
      errorCount: 0,
      warning: null,
    }
  }

  private async loadIndexState(): Promise<MempalaceIndexState> {
    if (!this.indexStatePromise) {
      this.indexStatePromise = this.loadIndexStateInternal()
    }

    return await this.indexStatePromise
  }

  private async loadIndexStateInternal(): Promise<MempalaceIndexState> {
    try {
      const content = await readFile(this.indexStatePath, 'utf8')
      const parsed = JSON.parse(content) as Partial<MempalaceIndexState>
      const normalizedByLookupKey: Record<string, MempalaceMemoryRecord> = {}
      const normalizedBySourceFile: Record<string, MempalaceMemoryRecord> = {}
      const records = parsed.recordsByLookupKey

      if (!records || typeof records !== 'object') {
        return {
          recordsByLookupKey: {},
          recordsBySourceFile: {},
        }
      }

      for (const candidate of Object.values(records)) {
        if (!candidate || typeof candidate !== 'object') {
          continue
        }

        const record = candidate as Partial<MempalaceMemoryRecord>
        const sourceKind =
          typeof record.sourceKind === 'string'
            ? record.sourceKind
            : 'transcript-raw'
        const room =
          typeof record.room === 'string'
            ? record.room
            : sourceKind === 'session-summary'
              ? 'session-summary'
              : 'transcript-raw'
        const sourceFile =
          typeof record.sourceFile === 'string'
            ? record.sourceFile
            : typeof record.chunkIndex === 'number' &&
                typeof record.sessionId === 'string'
              ? buildTranscriptSourceFile(record.sessionId, record.chunkIndex)
              : null
        if (
          typeof record.lookupKey !== 'string' ||
          typeof record.palaceDrawerId !== 'string' ||
          typeof record.drawerId !== 'string' ||
          typeof record.projectId !== 'string' ||
          typeof record.sessionId !== 'string' ||
          typeof record.timestampStart !== 'string' ||
          typeof record.timestampEnd !== 'string' ||
          typeof record.wing !== 'string' ||
          !Array.isArray(record.eventIds) ||
          !sourceFile
        ) {
          continue
        }

        const normalizedRecord: MempalaceMemoryRecord = {
          lookupKey: record.lookupKey,
          palaceDrawerId: record.palaceDrawerId,
          drawerId: record.drawerId,
          sourceFile,
          sourceLabel:
            typeof record.sourceLabel === 'string'
              ? record.sourceLabel
              : typeof record.transcriptPath === 'string'
                ? record.transcriptPath
                : null,
          projectId: record.projectId,
          locationId: typeof record.locationId === 'string' ? record.locationId : null,
          sessionId: record.sessionId,
          eventIds: record.eventIds.filter(
            (value): value is string => typeof value === 'string',
          ),
          timestampStart: record.timestampStart,
          timestampEnd: record.timestampEnd,
          sourceKind,
          room,
          wing: record.wing,
          candidateId:
            typeof record.candidateId === 'string' ? record.candidateId : null,
          candidateKind:
            typeof record.candidateKind === 'string'
              ? record.candidateKind
              : null,
          scope: typeof record.scope === 'string' ? record.scope : null,
          memoryKey:
            typeof record.memoryKey === 'string' ? record.memoryKey : null,
          confidence:
            typeof record.confidence === 'number' ? record.confidence : null,
          status: typeof record.status === 'string' ? record.status : null,
          transcriptPath:
            typeof record.transcriptPath === 'string'
              ? record.transcriptPath
              : null,
          chunkIndex:
            typeof record.chunkIndex === 'number' ? record.chunkIndex : undefined,
        }
        normalizedByLookupKey[normalizedRecord.lookupKey] = normalizedRecord
        normalizedBySourceFile[normalizedRecord.sourceFile] = normalizedRecord
      }

      return {
        recordsByLookupKey: normalizedByLookupKey,
        recordsBySourceFile: normalizedBySourceFile,
      }
    } catch {
      return {
        recordsByLookupKey: {},
        recordsBySourceFile: {},
      }
    }
  }

  private async persistIndexState(state: MempalaceIndexState): Promise<void> {
    await mkdir(path.dirname(this.indexStatePath), { recursive: true })
    await writeUtf8FileAtomic(
      this.indexStatePath,
      `${JSON.stringify(state, null, 2)}\n`,
    )
    this.indexStatePromise = Promise.resolve(state)
  }

  private upsertRecord(
    state: MempalaceIndexState,
    record: MempalaceMemoryRecord,
  ): void {
    state.recordsByLookupKey[record.lookupKey] = record
    state.recordsBySourceFile[record.sourceFile] = record
  }

  private async persistMemoryRecord(
    state: MempalaceIndexState,
    record: MempalaceMemoryRecordInput,
  ): Promise<void> {
    const addResult = await this.bridge.addDrawer({
      wing: record.wing,
      room: record.room,
      content: record.content,
      source_file: record.sourceFile,
    })
    const success = addResult.success === true
    const palaceDrawerId =
      typeof addResult.drawer_id === 'string' ? addResult.drawer_id : null

    if (!success || !palaceDrawerId) {
      const message =
        typeof addResult.error === 'string'
          ? addResult.error
          : 'MemPalace failed to add a memory drawer.'
      throw new Error(message)
    }

    this.upsertRecord(state, {
      lookupKey: buildLookupKey(record.wing, record.room, record.content),
      palaceDrawerId,
      drawerId: record.drawerId,
      sourceFile: record.sourceFile,
      sourceLabel: record.sourceLabel,
      projectId: record.projectId,
      locationId: record.locationId,
      sessionId: record.sessionId,
      eventIds: [...record.eventIds],
      timestampStart: record.timestampStart,
      timestampEnd: record.timestampEnd,
      sourceKind: record.sourceKind,
      room: record.room,
      wing: record.wing,
      chunkIndex: record.chunkIndex,
      transcriptPath: record.transcriptPath,
      candidateId: record.candidateId,
      candidateKind: record.candidateKind,
      scope: record.scope,
      memoryKey: record.memoryKey,
      confidence: record.confidence,
      status: record.status,
    })
  }
}
