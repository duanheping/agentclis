import { appendFile, mkdir, open, readFile, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { TranscriptEvent } from '../src/shared/projectMemory'
import { writeUtf8FileAtomic } from './atomicFile'

interface TranscriptIndex {
  eventCount: number
  lastEventAt: string | null
  projectId: string | null
  locationId: string | null
}

const DEFAULT_BASE_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'agenclis')
const TAIL_SCAN_CHUNK_BYTES = 64 * 1024

interface ParseResult {
  events: TranscriptEvent[]
  hasMalformedTail: boolean
  goodByteLength: number
}

interface ReadTailEventsOptions {
  kinds?: TranscriptEvent['kind'][]
  maxBytes?: number
  maxEvents?: number
  requireChunk?: boolean
}

function parseTranscriptEvents(content: string): ParseResult {
  const events: TranscriptEvent[] = []
  let goodByteLength = 0
  let lineStart = 0

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const hasLineBreak = newlineIndex !== -1
    const rawLine = hasLineBreak
      ? content.slice(lineStart, newlineIndex)
      : content.slice(lineStart)
    const line = (
      rawLine.endsWith('\r')
        ? rawLine.slice(0, Math.max(0, rawLine.length - 1))
        : rawLine
    ).trim()
    const nextGoodByteLength =
      goodByteLength + Buffer.byteLength(rawLine, 'utf8') + (hasLineBreak ? 1 : 0)

    if (!line) {
      goodByteLength = nextGoodByteLength
    } else {
      try {
        events.push(JSON.parse(line) as TranscriptEvent)
        goodByteLength = nextGoodByteLength
      } catch (error) {
        const hasOnlyBlankRemainder =
          !hasLineBreak || content.slice(newlineIndex + 1).trim().length === 0
        if (hasOnlyBlankRemainder) {
          return {
            events,
            hasMalformedTail: true,
            goodByteLength,
          }
        }

        throw error
      }
    }

    if (!hasLineBreak) {
      break
    }

    lineStart = newlineIndex + 1
  }

  return { events, hasMalformedTail: false, goodByteLength }
}

async function repairMalformedTailForAppend(transcriptPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null

  try {
    handle = await open(transcriptPath, 'r+')
  } catch {
    return
  }

  try {
    const stats = await handle.stat()
    if (stats.size === 0) {
      return
    }

    const lastByte = Buffer.alloc(1)
    const lastByteRead = await handle.read(lastByte, 0, 1, stats.size - 1)
    if (lastByteRead.bytesRead !== 1 || lastByte[0] === 0x0a) {
      return
    }

    let searchEnd = stats.size
    while (searchEnd > 0) {
      const chunkSize = Math.min(TAIL_SCAN_CHUNK_BYTES, searchEnd)
      const chunkStart = searchEnd - chunkSize
      const buffer = Buffer.alloc(chunkSize)
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, chunkStart)
      const newlineIndex = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (newlineIndex !== -1) {
        await handle.truncate(chunkStart + newlineIndex + 1)
        return
      }

      searchEnd = chunkStart
    }

    await handle.truncate(0)
  } catch {
    // Best-effort; don't block the caller.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export class TranscriptStore {
  private readonly pendingWrites = new Map<string, Promise<void>>()
  private readonly baseRoot: string

  constructor(baseRoot = DEFAULT_BASE_ROOT) {
    this.baseRoot = baseRoot
  }

  getBaseRoot(): string {
    return this.baseRoot
  }

  getTranscriptPath(sessionId: string): string {
    return path.join(this.baseRoot, 'transcripts', `${sessionId}.jsonl`)
  }

  getIndexPath(sessionId: string): string {
    return path.join(this.baseRoot, 'transcript-index', `${sessionId}.json`)
  }

  async append(event: TranscriptEvent): Promise<void> {
    const pendingWrite = this.pendingWrites.get(event.sessionId) ?? Promise.resolve()
    const nextWrite = pendingWrite.then(async () => {
      const transcriptPath = this.getTranscriptPath(event.sessionId)
      const indexPath = this.getIndexPath(event.sessionId)
      await mkdir(path.dirname(transcriptPath), { recursive: true })
      await mkdir(path.dirname(indexPath), { recursive: true })
      await repairMalformedTailForAppend(transcriptPath)
      await appendFile(transcriptPath, `${JSON.stringify(event)}\n`, 'utf8')

      const currentIndex = await this.readIndexFile(event.sessionId)
      const nextIndex: TranscriptIndex = {
        eventCount: currentIndex.eventCount + 1,
        lastEventAt: event.timestamp,
        projectId: event.projectId,
        locationId: event.locationId,
      }
      await writeUtf8FileAtomic(
        indexPath,
        `${JSON.stringify(nextIndex, null, 2)}\n`,
      )
    })
    this.pendingWrites.set(event.sessionId, nextWrite)

    try {
      await nextWrite
    } finally {
      if (this.pendingWrites.get(event.sessionId) === nextWrite) {
        this.pendingWrites.delete(event.sessionId)
      }
    }
  }

  async readEvents(sessionId: string): Promise<TranscriptEvent[]> {
    await this.pendingWrites.get(sessionId)
    try {
      const transcriptPath = this.getTranscriptPath(sessionId)
      const content = await readFile(transcriptPath, 'utf8')
      const result = parseTranscriptEvents(content)
      if (
        result.hasMalformedTail &&
        result.goodByteLength < Buffer.byteLength(content, 'utf8')
      ) {
        try {
          await truncate(transcriptPath, result.goodByteLength)
        } catch {
          // Best-effort; return the parsed transcript even if cleanup fails.
        }
      }

      return result.events
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      return []
    }
  }

  async readTailEvents(
    sessionId: string,
    options: ReadTailEventsOptions = {},
  ): Promise<TranscriptEvent[]> {
    const events = await this.readEvents(sessionId)
    const allowedKinds = new Set(options.kinds)
    const maxBytes = Math.max(0, options.maxBytes ?? 0)
    const maxEvents = Math.max(0, options.maxEvents ?? 0)
    const requireChunk = options.requireChunk ?? false
    const tail: TranscriptEvent[] = []
    let byteCount = 0

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (allowedKinds.size > 0 && !allowedKinds.has(event.kind)) {
        continue
      }

      if (requireChunk && !event.chunk) {
        continue
      }

      const chunkSize = Buffer.byteLength(event.chunk ?? '', 'utf8')
      const exceedsEventLimit =
        maxEvents > 0 && tail.length >= maxEvents
      const exceedsByteLimit =
        maxBytes > 0 && byteCount + chunkSize > maxBytes
      if (tail.length > 0 && (exceedsEventLimit || exceedsByteLimit)) {
        break
      }

      tail.unshift(event)
      byteCount += chunkSize
    }

    return tail
  }

  async readIndex(sessionId: string): Promise<TranscriptIndex> {
    await this.pendingWrites.get(sessionId)
    return await this.readIndexFile(sessionId)
  }

  private async readIndexFile(sessionId: string): Promise<TranscriptIndex> {
    try {
      const content = await readFile(this.getIndexPath(sessionId), 'utf8')
      const candidate = JSON.parse(content) as Partial<TranscriptIndex>
      return {
        eventCount:
          typeof candidate.eventCount === 'number' ? candidate.eventCount : 0,
        lastEventAt:
          typeof candidate.lastEventAt === 'string' ? candidate.lastEventAt : null,
        projectId: typeof candidate.projectId === 'string' ? candidate.projectId : null,
        locationId:
          typeof candidate.locationId === 'string' ? candidate.locationId : null,
      }
    } catch {
      return {
        eventCount: 0,
        lastEventAt: null,
        projectId: null,
        locationId: null,
      }
    }
  }
}
