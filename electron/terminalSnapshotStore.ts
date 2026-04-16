import { mkdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { UpdateSessionTerminalSnapshotInput } from '../src/shared/ipc'
import { writeUtf8FileAtomic } from './atomicFile'

const DEFAULT_BASE_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'agenclis')

type PersistedTerminalSnapshot = UpdateSessionTerminalSnapshotInput

export class TerminalSnapshotStore {
  private readonly baseRoot: string

  constructor(baseRoot = DEFAULT_BASE_ROOT) {
    this.baseRoot = baseRoot
  }

  getSnapshotPath(sessionId: string): string {
    return path.join(this.baseRoot, 'terminal-snapshots', `${sessionId}.json`)
  }

  async read(
    sessionId: string,
  ): Promise<PersistedTerminalSnapshot | null> {
    try {
      const content = await readFile(this.getSnapshotPath(sessionId), 'utf8')
      const parsed = JSON.parse(content) as Partial<PersistedTerminalSnapshot>
      const normalizedText =
        typeof parsed.text === 'string' ? parsed.text : ''
      const normalizedSerialized =
        typeof parsed.serialized === 'string' && parsed.serialized.trim()
          ? parsed.serialized
          : undefined
      if (
        typeof parsed.sessionId !== 'string' ||
        parsed.sessionId !== sessionId ||
        (!normalizedText.trim() && !normalizedSerialized)
      ) {
        return null
      }

      return {
        sessionId,
        text: normalizedText,
        serialized: normalizedSerialized,
        lineCount:
          typeof parsed.lineCount === 'number' && Number.isFinite(parsed.lineCount)
            ? parsed.lineCount
            : 0,
        cols:
          typeof parsed.cols === 'number' && Number.isFinite(parsed.cols)
            ? parsed.cols
            : 0,
        rows:
          typeof parsed.rows === 'number' && Number.isFinite(parsed.rows)
            ? parsed.rows
            : 0,
        capturedAt:
          typeof parsed.capturedAt === 'string' && parsed.capturedAt
            ? parsed.capturedAt
            : new Date(0).toISOString(),
      }
    } catch {
      return null
    }
  }

  async write(snapshot: PersistedTerminalSnapshot): Promise<void> {
    if (!snapshot.text.trim() && !snapshot.serialized?.trim()) {
      await this.delete(snapshot.sessionId)
      return
    }

    const filePath = this.getSnapshotPath(snapshot.sessionId)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeUtf8FileAtomic(filePath, JSON.stringify(snapshot))
  }

  async delete(sessionId: string): Promise<void> {
    await rm(this.getSnapshotPath(sessionId), { force: true })
  }
}
