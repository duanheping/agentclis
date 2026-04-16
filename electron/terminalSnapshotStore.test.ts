// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TerminalSnapshotStore } from './terminalSnapshotStore'

const tempRoots: string[] = []

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenclis-terminal-snapshot-'))
  tempRoots.push(root)
  return new TerminalSnapshotStore(root)
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TerminalSnapshotStore', () => {
  it('writes and reads persisted snapshots', async () => {
    const store = await createStore()

    await store.write({
      sessionId: 'session-1',
      text: 'line-1\r\nline-2',
      serialized: '\u001b[2Jline-1\r\nline-2',
      lineCount: 2,
      cols: 120,
      rows: 36,
      capturedAt: '2026-04-15T21:00:00.000Z',
    })

    await expect(store.read('session-1')).resolves.toEqual({
      sessionId: 'session-1',
      text: 'line-1\r\nline-2',
      serialized: '\u001b[2Jline-1\r\nline-2',
      lineCount: 2,
      cols: 120,
      rows: 36,
      capturedAt: '2026-04-15T21:00:00.000Z',
    })
  })

  it('deletes snapshots when asked to store blank text', async () => {
    const store = await createStore()

    await store.write({
      sessionId: 'session-1',
      text: 'line-1',
      serialized: '\u001b[2Jline-1',
      lineCount: 1,
      cols: 120,
      rows: 36,
      capturedAt: '2026-04-15T21:00:00.000Z',
    })

    await store.write({
      sessionId: 'session-1',
      text: '',
      serialized: '',
      lineCount: 0,
      cols: 120,
      rows: 36,
      capturedAt: '2026-04-15T21:01:00.000Z',
    })

    await expect(store.read('session-1')).resolves.toBeNull()
  })

  it('returns null for malformed snapshot files', async () => {
    const store = await createStore()
    const filePath = store.getSnapshotPath('session-1')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{not-json', 'utf8')
    await expect(store.read('session-1')).resolves.toBeNull()
  })

  it('reads older text-only snapshot files for backward compatibility', async () => {
    const store = await createStore()
    const filePath = store.getSnapshotPath('session-1')
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      JSON.stringify({
        sessionId: 'session-1',
        text: 'legacy snapshot',
        lineCount: 1,
        cols: 100,
        rows: 30,
        capturedAt: '2026-04-15T21:00:00.000Z',
      }),
      'utf8',
    )

    await expect(store.read('session-1')).resolves.toEqual({
      sessionId: 'session-1',
      text: 'legacy snapshot',
      serialized: undefined,
      lineCount: 1,
      cols: 100,
      rows: 30,
      capturedAt: '2026-04-15T21:00:00.000Z',
    })
  })
})
