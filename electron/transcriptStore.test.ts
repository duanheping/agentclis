// @vitest-environment node

import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises'
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

  it('returns empty events for non-existent session', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await expect(store.readEvents('non-existent')).resolves.toEqual([])
  })

  it('returns default index for non-existent session', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await expect(store.readIndex('non-existent')).resolves.toEqual({
      eventCount: 0,
      lastEventAt: null,
      projectId: null,
      locationId: null,
    })
  })

  it('tracks events across multiple sessions independently', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent({ sessionId: 'session-a', id: 'a-1' }))
    await store.append(buildEvent({ sessionId: 'session-b', id: 'b-1' }))
    await store.append(buildEvent({
      sessionId: 'session-a',
      id: 'a-2',
      timestamp: '2026-03-22T12:00:02.000Z',
    }))

    const eventsA = await store.readEvents('session-a')
    const eventsB = await store.readEvents('session-b')
    expect(eventsA).toHaveLength(2)
    expect(eventsB).toHaveLength(1)

    const indexA = await store.readIndex('session-a')
    expect(indexA.eventCount).toBe(2)
    expect(indexA.lastEventAt).toBe('2026-03-22T12:00:02.000Z')
  })

  it('getTranscriptPath and getIndexPath derive from baseRoot', async () => {
    const store = new TranscriptStore('C:\\test-root')
    expect(store.getTranscriptPath('sess-1')).toBe(
      path.join('C:\\test-root', 'transcripts', 'sess-1.jsonl'),
    )
    expect(store.getIndexPath('sess-1')).toBe(
      path.join('C:\\test-root', 'transcript-index', 'sess-1.json'),
    )
  })

  it('getBaseRoot returns the configured root', () => {
    const store = new TranscriptStore('C:\\custom-root')
    expect(store.getBaseRoot()).toBe('C:\\custom-root')
  })

  it('handles concurrent appends to the same session', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    const appends = Array.from({ length: 10 }, (_, i) =>
      store.append(buildEvent({
        id: `event-${i}`,
        timestamp: `2026-03-22T12:00:${String(i).padStart(2, '0')}.000Z`,
      })),
    )

    await Promise.all(appends)

    const events = await store.readEvents('session-1')
    expect(events).toHaveLength(10)

    const index = await store.readIndex('session-1')
    expect(index.eventCount).toBe(10)
  })

  it('ignores a malformed trailing transcript line and truncates the file', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())
    await appendFile(store.getTranscriptPath('session-1'), '{"broken"', 'utf8')

    await expect(store.readEvents('session-1')).resolves.toEqual([buildEvent()])
  })

  it('ignores a malformed trailing line that already ends with a newline', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())
    await appendFile(store.getTranscriptPath('session-1'), '{"broken"\n', 'utf8')

    await expect(store.readEvents('session-1')).resolves.toEqual([buildEvent()])
  })

  it('throws when a malformed transcript line is followed by another event', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())
    await appendFile(
      store.getTranscriptPath('session-1'),
      `${'{"broken"\n'}${JSON.stringify(buildEvent({
        id: 'event-2',
        timestamp: '2026-03-22T12:01:00.000Z',
      }))}\n`,
      'utf8',
    )

    await expect(store.readEvents('session-1')).rejects.toThrow()
  })

  it('preserves the first event appended after a malformed tail', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())
    await appendFile(store.getTranscriptPath('session-1'), '{"broken"', 'utf8')

    // First read truncates the malformed tail
    const eventsBeforeAppend = await store.readEvents('session-1')
    expect(eventsBeforeAppend).toEqual([buildEvent()])

    // Subsequent append should be preserved
    const secondEvent = buildEvent({
      id: 'event-2',
      timestamp: '2026-03-22T12:01:00.000Z',
      chunk: 'world',
    })
    await store.append(secondEvent)

    const eventsAfterAppend = await store.readEvents('session-1')
    expect(eventsAfterAppend).toHaveLength(2)
    expect(eventsAfterAppend[0]).toEqual(buildEvent())
    expect(eventsAfterAppend[1]).toEqual(secondEvent)
  })

  it('preserves an event appended before any read after a malformed tail', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())
    await appendFile(store.getTranscriptPath('session-1'), '{"broken"', 'utf8')

    // Append WITHOUT reading first — the real crash-recovery path.
    const secondEvent = buildEvent({
      id: 'event-2',
      timestamp: '2026-03-22T12:01:00.000Z',
      chunk: 'world',
    })
    await store.append(secondEvent)

    const events = await store.readEvents('session-1')
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual(buildEvent())
    expect(events[1]).toEqual(secondEvent)
  })

  it('reads a filtered transcript tail for terminal replay', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-1',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'runtime',
        source: 'system',
        chunk: undefined,
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-2',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-4',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-3',
        timestamp: '2026-03-22T12:00:03.000Z',
      }),
    )

    await expect(
      store.readTailEvents('session-1', {
        kinds: ['output'],
        maxEvents: 2,
        requireChunk: true,
      }),
    ).resolves.toEqual([
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-2',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
      buildEvent({
        id: 'event-4',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-3',
        timestamp: '2026-03-22T12:00:03.000Z',
      }),
    ])
  })

  it('reads a terminal replay tail across large transcript chunks', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    const largeChunkA = 'a'.repeat(180_000)
    const largeChunkB = 'b'.repeat(180_000)

    await store.append(
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: largeChunkA,
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'runtime',
        source: 'system',
        chunk: undefined,
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: largeChunkB,
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )

    await expect(
      store.readTailEvents('session-1', {
        kinds: ['output'],
        maxEvents: 2,
        requireChunk: true,
      }),
    ).resolves.toEqual([
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: largeChunkA,
      }),
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: largeChunkB,
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    ])
  })

  it('ignores a malformed transcript tail during terminal replay reads', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-1',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-2',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await appendFile(store.getTranscriptPath('session-1'), '{"broken"', 'utf8')

    await expect(
      store.readTailEvents('session-1', {
        kinds: ['output'],
        maxEvents: 2,
        requireChunk: true,
      }),
    ).resolves.toEqual([
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-1',
      }),
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-2',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    ])
  })

  it('reads only transcript events newer than a timestamp boundary', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-1',
        timestamp: '2026-03-22T12:00:00.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-2',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-3',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )

    await expect(
      store.readTailEvents('session-1', {
        kinds: ['output'],
        requireChunk: true,
        afterTimestamp: '2026-03-22T12:00:01.000Z',
      }),
    ).resolves.toEqual([
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: 'chunk-3',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    ])
  })

  it('returns the full transcript when sampled reads stay under the full-read threshold', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent({ id: 'event-1', chunk: 'first' }))
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'second',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        chunk: 'third',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )

    await expect(
      store.readSampledEvents('session-1', {
        maxFullBytes: 64 * 1024,
        headMaxEvents: 1,
        tailMaxEvents: 1,
      }),
    ).resolves.toEqual([
      buildEvent({ id: 'event-1', chunk: 'first' }),
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: 'second',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
      buildEvent({
        id: 'event-3',
        chunk: 'third',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    ])
  })

  it('reads paged transcript events from newest to oldest pages', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent({ id: 'event-1', chunk: 'alpha' }))
    await store.append(
      buildEvent({
        id: 'event-2',
        chunk: 'beta',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        chunk: 'gamma',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )

    const latestPage = await store.readEventsPage('session-1', {
      limit: 2,
    })

    expect(latestPage).toEqual({
      events: [
        buildEvent({
          id: 'event-2',
          chunk: 'beta',
          timestamp: '2026-03-22T12:00:01.000Z',
        }),
        buildEvent({
          id: 'event-3',
          chunk: 'gamma',
          timestamp: '2026-03-22T12:00:02.000Z',
        }),
      ],
      nextCursor: '1',
    })

    await expect(
      store.readEventsPage('session-1', {
        cursor: latestPage.nextCursor,
        limit: 2,
      }),
    ).resolves.toEqual({
      events: [
        buildEvent({
          id: 'event-1',
          chunk: 'alpha',
        }),
      ],
      nextCursor: null,
    })
  })

  it('filters transcript pages by kind and search text', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(
      buildEvent({
        id: 'event-1',
        kind: 'output',
        source: 'pty',
        chunk: 'first reply',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'system',
        source: 'system',
        chunk: 'Session exited with code 0.',
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        kind: 'output',
        source: 'pty',
        chunk: 'second reply with result',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )

    await expect(
      store.readEventsPage('session-1', {
        kinds: ['output'],
        search: 'result',
      }),
    ).resolves.toEqual({
      events: [
        buildEvent({
          id: 'event-3',
          kind: 'output',
          source: 'pty',
          chunk: 'second reply with result',
          timestamp: '2026-03-22T12:00:02.000Z',
        }),
      ],
      nextCursor: null,
    })
  })

  it('ignores a malformed transcript tail during paged reads', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent({ id: 'event-1', chunk: 'alpha' }))
    await appendFile(store.getTranscriptPath('session-1'), '{"broken"', 'utf8')

    await expect(
      store.readEventsPage('session-1', {
        limit: 10,
      }),
    ).resolves.toEqual({
      events: [
        buildEvent({
          id: 'event-1',
          chunk: 'alpha',
        }),
      ],
      nextCursor: null,
    })
  })

  it('samples transcript head and tail without duplicating overlapping events', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    const largeChunkA = 'a'.repeat(180_000)
    const largeChunkB = 'b'.repeat(180_000)

    await store.append(
      buildEvent({
        id: 'event-1',
        chunk: largeChunkA,
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: largeChunkB,
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-3',
        chunk: 'middle',
        timestamp: '2026-03-22T12:00:02.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-4',
        kind: 'output',
        source: 'pty',
        chunk: 'tail-a',
        timestamp: '2026-03-22T12:00:03.000Z',
      }),
    )
    await store.append(
      buildEvent({
        id: 'event-5',
        chunk: 'tail-b',
        timestamp: '2026-03-22T12:00:04.000Z',
      }),
    )

    await expect(
      store.readSampledEvents('session-1', {
        maxFullBytes: 1,
        headMaxEvents: 2,
        tailMaxEvents: 2,
      }),
    ).resolves.toEqual([
      buildEvent({
        id: 'event-1',
        chunk: largeChunkA,
      }),
      buildEvent({
        id: 'event-2',
        kind: 'output',
        source: 'pty',
        chunk: largeChunkB,
        timestamp: '2026-03-22T12:00:01.000Z',
      }),
      buildEvent({
        id: 'event-4',
        kind: 'output',
        source: 'pty',
        chunk: 'tail-a',
        timestamp: '2026-03-22T12:00:03.000Z',
      }),
      buildEvent({
        id: 'event-5',
        chunk: 'tail-b',
        timestamp: '2026-03-22T12:00:04.000Z',
      }),
    ])
  })

  it('writes the transcript index without leaving temp files behind', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-transcript-'))
    tempRoots.push(tempRoot)
    const store = new TranscriptStore(tempRoot)

    await store.append(buildEvent())

    const indexFiles = await readdir(path.join(tempRoot, 'transcript-index'))
    expect(indexFiles).toContain('session-1.json')
    expect(indexFiles.some((fileName) => fileName.endsWith('.tmp'))).toBe(false)
  })
})
