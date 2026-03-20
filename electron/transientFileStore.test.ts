// @vitest-environment node

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { TransientFileStore } from './transientFileStore'

let store: TransientFileStore | null = null

describe('TransientFileStore', () => {
  afterEach(async () => {
    await store?.dispose()
    store = null
  })

  it('persists clipboard image data with an inferred extension', async () => {
    store = new TransientFileStore()

    const bytes = new Uint8Array([137, 80, 78, 71])
    const filePath = await store.persist({
      type: 'image/png',
      data: bytes.buffer,
    })

    expect(path.basename(filePath)).toMatch(/^pasted-image-.*\.png$/)
    expect(await readFile(filePath)).toEqual(Buffer.from(bytes))
  })

  it('sanitizes source file names and removes the temp directory on dispose', async () => {
    store = new TransientFileStore()

    const filePath = await store.persist({
      name: 'Bug bash screenshot (final).PNG',
      type: 'image/png',
      data: new Uint8Array([1, 2, 3]).buffer,
    })
    const rootDir = path.dirname(filePath)

    expect(path.basename(filePath)).toMatch(
      /^Bug-bash-screenshot-final-.*\.PNG$/,
    )

    await store.dispose()
    store = null

    await expect(stat(rootDir)).rejects.toThrow()
  })
})
