import { createHash } from 'node:crypto'

import type {
  MempalaceTranscriptChunk,
  MempalaceTranscriptChunkInput,
} from '../src/shared/memoryIndex'
import { deriveMempalaceWing } from '../src/shared/memoryIndex'
import type { TranscriptEvent } from '../src/shared/projectMemory'

interface NormalizedTranscriptEntry {
  event: TranscriptEvent
  text: string
}

export interface MempalaceIndexerOptions {
  maxChunkChars?: number
  maxEventsPerChunk?: number
}

const DEFAULT_MAX_CHUNK_CHARS = 1_600
const DEFAULT_MAX_EVENTS_PER_CHUNK = 12

function normalizeTranscriptEntry(event: TranscriptEvent): NormalizedTranscriptEntry | null {
  const rawChunk = typeof event.chunk === 'string' ? event.chunk.trim() : ''
  const metadataText = event.metadata
    ? JSON.stringify(event.metadata)
    : ''
  const body = rawChunk || metadataText
  if (!body) {
    return null
  }

  let prefix = 'System'
  if (event.kind === 'input') {
    prefix = 'User'
  } else if (event.kind === 'output') {
    prefix = 'Assistant'
  } else if (event.kind === 'runtime') {
    prefix = 'Runtime'
  }

  return {
    event,
    text: `${prefix}: ${body.replace(/\s+/gu, ' ').trim()}`,
  }
}

function buildDrawerId(
  wing: string,
  sessionId: string,
  chunkIndex: number,
  eventIds: string[],
): string {
  const hash = createHash('sha1')
  hash.update(wing)
  hash.update('\u0000')
  hash.update(sessionId)
  hash.update('\u0000')
  hash.update(String(chunkIndex))
  hash.update('\u0000')
  hash.update(eventIds.join(','))
  return hash.digest('hex')
}

export class MempalaceIndexer {
  private readonly maxChunkChars: number
  private readonly maxEventsPerChunk: number

  constructor(options: MempalaceIndexerOptions = {}) {
    this.maxChunkChars = Math.max(400, options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS)
    this.maxEventsPerChunk = Math.max(
      2,
      options.maxEventsPerChunk ?? DEFAULT_MAX_EVENTS_PER_CHUNK,
    )
  }

  buildTranscriptChunks(
    input: MempalaceTranscriptChunkInput,
  ): MempalaceTranscriptChunk[] {
    const wing = deriveMempalaceWing(input.project, input.location)
    const entries = input.transcript
      .map((event) => normalizeTranscriptEntry(event))
      .filter((entry): entry is NormalizedTranscriptEntry => entry !== null)

    const chunks: MempalaceTranscriptChunk[] = []
    let currentEntries: NormalizedTranscriptEntry[] = []
    let currentChars = 0

    const flushCurrentChunk = () => {
      if (currentEntries.length === 0) {
        return
      }

      const chunkIndex = chunks.length
      const eventIds = currentEntries.map((entry) => entry.event.id)
      const content = currentEntries.map((entry) => entry.text).join('\n\n')
      const timestampStart = currentEntries[0]?.event.timestamp
      const timestampEnd = currentEntries.at(-1)?.event.timestamp

      if (!timestampStart || !timestampEnd) {
        currentEntries = []
        currentChars = 0
        return
      }

      const drawerId = buildDrawerId(
        wing,
        input.session.id,
        chunkIndex,
        eventIds,
      )

      chunks.push({
        drawerId,
        content,
        metadata: {
          drawerId,
          projectId: input.project.id,
          locationId: input.location?.id ?? input.session.locationId ?? null,
          sessionId: input.session.id,
          eventIds,
          timestampStart,
          timestampEnd,
          sourceKind: 'transcript-raw',
          room: 'transcript-raw',
          wing,
          chunkIndex,
          eventCount: currentEntries.length,
        },
      })

      currentEntries = []
      currentChars = 0
    }

    for (const entry of entries) {
      const nextChars =
        currentChars +
        entry.text.length +
        (currentEntries.length > 0 ? 2 : 0)

      const shouldFlushBeforeAdding =
        currentEntries.length > 0 &&
        (
          currentEntries.length >= this.maxEventsPerChunk ||
          nextChars > this.maxChunkChars ||
          (entry.event.kind === 'input' && currentChars >= this.maxChunkChars * 0.6)
        )

      if (shouldFlushBeforeAdding) {
        flushCurrentChunk()
      }

      currentEntries.push(entry)
      currentChars += entry.text.length + (currentEntries.length > 1 ? 2 : 0)
    }

    flushCurrentChunk()
    return chunks
  }
}
