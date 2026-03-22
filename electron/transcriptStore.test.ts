// @vitest-environment node

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { TranscriptEvent } from '../src/shared/projectMemory'
import { TranscriptStore } from './transcriptStore'

const tempRoots: string[] = []

function buildEvent(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    id: 'event-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    locationId: 'location-1',
    timestamp: '2026-03-22T12:00:00.000Z',
    kind: 'input',
    source: 'user',
    chunk: 'hello',
    ...overrides,
  }
}

describe('TranscriptStore', () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots
        .splice(0)
        .map(async (tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    )
  })

  it('appends transcript events and maintains a side index', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'world',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )

    await expect(store.readEvents('session-1')).resolves.toEqual([
      buildEvent(),
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'world',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    ])
    await expect(store.readIndex('session-1')).resolves.toEqual({
      eventCount: 2,
      lastEventAt: '2026-03-22T12:00:01.000Z',
      projectId: 'project-1',
      locationId: 'location-1',
    })
  })
})
