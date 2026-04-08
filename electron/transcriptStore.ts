import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises'
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

interface ParseResult {
  events: TranscriptEvent[]
  hasMalformedTail: boolean
  goodByteLength: number
}

function parseTranscriptEvents(content: string): ParseResult {
  const lines = content.split(/\r?\n/u)
  let lastNonEmptyIndex = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      lastNonEmptyIndex = index
    }
  }

  const events: TranscriptEvent[] = []
  let hasMalformedTail = false
  let goodByteLength = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      continue
    }

    try {
      events.push(JSON.parse(line) as TranscriptEvent)
      // Track the byte offset past this successfully parsed line.
      // Sum original line lengths + newline separators up through this line.
      goodByteLength = 0
      for (let j = 0; j <= index; j += 1) {
        goodByteLength += Buffer.byteLength(lines[j], 'utf8')
        if (j < lines.length - 1) {
          goodByteLength += content.includes('\r\n') ? 2 : 1
        }
      }
    } catch (error) {
      if (index === lastNonEmptyIndex) {
        hasMalformedTail = true
        break
      }

      throw error
    }
  }

  return { events, hasMalformedTail, goodByteLength }
}

async function repairMalformedTail(transcriptPath: string): Promise<void> {
  let content: string
  try {
    content = await readFile(transcriptPath, 'utf8')
  } catch {
    return
  }

  const result = parseTranscriptEvents(content)
  if (result.hasMalformedTail && result.goodByteLength < Buffer.byteLength(content, 'utf8')) {
    try {
      await truncate(transcriptPath, result.goodByteLength)
    } catch {
      // Best-effort; don't block the caller.
    }
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
      await repairMalformedTail(transcriptPath)
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
      await repairMalformedTail(transcriptPath)
      const content = await readFile(transcriptPath, 'utf8')
      return parseTranscriptEvents(content).events
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      return []
    }
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
