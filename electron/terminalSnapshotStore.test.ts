// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const atomicFileMocks = vi.hoisted(() => ({
  writeUtf8FileAtomic: vi.fn(),
}))

vi.mock('./atomicFile', () => ({
  writeUtf8FileAtomic: atomicFileMocks.writeUtf8FileAtomic,
}))

import { TerminalSnapshotStore } from './terminalSnapshotStore'

function buildSnapshot(sessionId = 'session-1') {
  return {
    sessionId,
    text: 'snapshot line',
    serialized: '\u001b[2Jsnapshot line',
    lineCount: 1,
    cols: 120,
    rows: 36,
    capturedAt: '2026-04-16T12:00:00.000Z',
  }
}

describe('TerminalSnapshotStore', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'agenclis-terminal-snapshot-'))
    atomicFileMocks.writeUtf8FileAtomic.mockReset()
    atomicFileMocks.writeUtf8FileAtomic.mockImplementation(async (filePath, content) => {
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, content, 'utf8')
    })
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('returns the latest snapshot immediately while a write is still pending', async () => {
    let releaseWrite: (() => void) | null = null
    atomicFileMocks.writeUtf8FileAtomic.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseWrite = resolve
        }),
    )

    const store = new TerminalSnapshotStore(tempRoot)
    const snapshot = buildSnapshot()
    const writePromise = store.write(snapshot)

    const readResult = await Promise.race([
      store.read(snapshot.sessionId).then((value) => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 25)
      }),
    ])

    expect(readResult).toEqual({
      kind: 'value',
      value: snapshot,
    })

    await vi.waitFor(() => {
      expect(releaseWrite).not.toBeNull()
    })
    releaseWrite?.()
    await writePromise
  })

  it('returns null immediately after a delete is queued behind a pending write', async () => {
    let releaseWrite: (() => void) | null = null
    atomicFileMocks.writeUtf8FileAtomic.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          releaseWrite = resolve
        }),
    )

    const store = new TerminalSnapshotStore(tempRoot)
    const snapshot = buildSnapshot()
    const writePromise = store.write(snapshot)
    const deletePromise = store.delete(snapshot.sessionId)

    const readResult = await Promise.race([
      store.read(snapshot.sessionId).then((value) => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 25)
      }),
    ])

    expect(readResult).toEqual({
      kind: 'value',
      value: null,
    })

    await vi.waitFor(() => {
      expect(releaseWrite).not.toBeNull()
    })
    releaseWrite?.()
    await writePromise
    await deletePromise
  })

  it('loads a persisted snapshot from disk when no cached copy exists', async () => {
    const store = new TerminalSnapshotStore(tempRoot)
    const snapshot = buildSnapshot()
    const snapshotPath = path.join(
      tempRoot,
      'terminal-snapshots',
      `${snapshot.sessionId}.json`,
    )

    await mkdir(path.dirname(snapshotPath), { recursive: true })
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8')

    await expect(store.read(snapshot.sessionId)).resolves.toEqual(snapshot)
  })
})
