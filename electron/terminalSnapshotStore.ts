import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { UpdateSessionTerminalSnapshotInput } from '../src/shared/ipc'
import { writeUtf8FileAtomic } from './atomicFile'

const DEFAULT_BASE_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'agenclis')

type PersistedTerminalSnapshot = UpdateSessionTerminalSnapshotInput

function normalizeSnapshot(
  sessionId: string,
  candidate: Partial<PersistedTerminalSnapshot>,
): PersistedTerminalSnapshot | null {
  const normalizedText =
    typeof candidate.text === 'string' ? candidate.text : ''
  const normalizedSerialized =
    typeof candidate.serialized === 'string' && candidate.serialized.trim()
      ? candidate.serialized
      : undefined
  if (
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId !== sessionId ||
    (!normalizedText.trim() && !normalizedSerialized)
  ) {
    return null
  }

  return {
    sessionId,
    text: normalizedText,
    serialized: normalizedSerialized,
    lineCount:
      typeof candidate.lineCount === 'number' && Number.isFinite(candidate.lineCount)
        ? candidate.lineCount
        : 0,
    cols:
      typeof candidate.cols === 'number' && Number.isFinite(candidate.cols)
        ? candidate.cols
        : 0,
    rows:
      typeof candidate.rows === 'number' && Number.isFinite(candidate.rows)
        ? candidate.rows
        : 0,
    capturedAt:
      typeof candidate.capturedAt === 'string' && candidate.capturedAt
        ? candidate.capturedAt
        : new Date(0).toISOString(),
  }
}

export class TerminalSnapshotStore {
  private readonly baseRoot: string
  private readonly pendingWrites = new Map<string, Promise<void>>()
  private readonly cache = new Map<string, PersistedTerminalSnapshot | null>()

  constructor(baseRoot = DEFAULT_BASE_ROOT) {
    this.baseRoot = baseRoot
  }

  getSnapshotPath(sessionId: string): string {
    return path.join(this.baseRoot, 'terminal-snapshots', `${sessionId}.json`)
  }

  async read(
    sessionId: string,
  ): Promise<PersistedTerminalSnapshot | null> {
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId) ?? null
    }

    await this.pendingWrites.get(sessionId)
    if (this.cache.has(sessionId)) {
      return this.cache.get(sessionId) ?? null
    }

    try {
      const content = await readFile(this.getSnapshotPath(sessionId), 'utf8')
      const snapshot = normalizeSnapshot(
        sessionId,
        JSON.parse(content) as Partial<PersistedTerminalSnapshot>,
      )
      this.cache.set(sessionId, snapshot)
      return snapshot
    } catch {
      this.cache.set(sessionId, null)
      return null
    }
  }

  async write(snapshot: PersistedTerminalSnapshot): Promise<void> {
    const normalizedSnapshot = normalizeSnapshot(snapshot.sessionId, snapshot)
    if (!normalizedSnapshot) {
      await this.delete(snapshot.sessionId)
      return
    }

    const { sessionId } = normalizedSnapshot
    this.cache.set(sessionId, normalizedSnapshot)

    const pendingWrite =
      this.pendingWrites.get(sessionId)?.catch(() => undefined) ?? Promise.resolve()
    const nextWrite = pendingWrite.then(async () => {
      const filePath = this.getSnapshotPath(sessionId)
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeUtf8FileAtomic(filePath, JSON.stringify(normalizedSnapshot))
    })
    this.pendingWrites.set(sessionId, nextWrite)

    try {
      await nextWrite
    } finally {
      if (this.pendingWrites.get(sessionId) === nextWrite) {
        this.pendingWrites.delete(sessionId)
      }
    }
  }

  async delete(sessionId: string): Promise<void> {
    this.cache.set(sessionId, null)

    const pendingWrite =
      this.pendingWrites.get(sessionId)?.catch(() => undefined) ?? Promise.resolve()
    const nextWrite = pendingWrite.then(async () => {
      await rm(this.getSnapshotPath(sessionId), { force: true })
    })
    this.pendingWrites.set(sessionId, nextWrite)

    try {
      await nextWrite
    } finally {
      if (this.pendingWrites.get(sessionId) === nextWrite) {
        this.pendingWrites.delete(sessionId)
      }
    }
  }
}
