import { createHash } from 'node:crypto'

import type {
  MemoryBackendInstallResult,
  MemoryBackendStatus,
  MemorySearchHit,
  MemorySearchRequest,
  MemorySearchResult,
} from '../src/shared/memorySearch'
import {
  MempalaceBridge,
  type MempalaceSearchResponse,
} from './mempalaceBridge'
import { MempalaceRuntime } from './mempalaceRuntime'

const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
const MAX_PREVIEW_LENGTH = 280

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

function mapSearchHit(
  query: string,
  result: Record<string, unknown>,
  index: number,
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
    sourceLabel: sourceFile,
    projectId: null,
    locationId: null,
    sessionId: null,
    timestampStart: null,
    timestampEnd: null,
  }
}

export class MempalaceService {
  private readonly runtime: RuntimeContract
  private readonly bridge: BridgeContract

  constructor(
    runtime: RuntimeContract = new MempalaceRuntime(),
    bridge: BridgeContract = new MempalaceBridge(runtime as MempalaceRuntime),
  ) {
    this.runtime = runtime
    this.bridge = bridge
  }

  async getStatus(): Promise<MemoryBackendStatus> {
    return await this.runtime.getStatus()
  }

  async installRuntime(): Promise<MemoryBackendInstallResult> {
    return await this.runtime.installRuntime()
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

      const rawResults = Array.isArray(response.results) ? response.results : []
      const hits = rawResults
        .filter((result): result is Record<string, unknown> =>
          typeof result === 'object' && result !== null,
        )
        .map((result, index) => mapSearchHit(query, result, index))

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
}
