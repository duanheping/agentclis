import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { TranscriptEvent } from '../src/shared/projectMemory'

interface TranscriptIndex {
  eventCount: number
  lastEventAt: string | null
  projectId: string | null
  locationId: string | null
}

const DEFAULT_BASE_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'agenclis')

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
      await appendFile(transcriptPath, `${JSON.stringify(event)}\n`, 'utf8')

      const currentIndex = await this.readIndexFile(event.sessionId)
      const nextIndex: TranscriptIndex = {
        eventCount: currentIndex.eventCount + 1,
        lastEventAt: event.timestamp,
        projectId: event.projectId,
        locationId: event.locationId,
      }
      await writeFile(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`, 'utf8')
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
      const content = await readFile(this.getTranscriptPath(sessionId), 'utf8')
      return content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TranscriptEvent)
    } catch {
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
