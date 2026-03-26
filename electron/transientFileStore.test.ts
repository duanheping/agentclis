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

  it('infers .jpg extension for image/jpeg MIME type', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      type: 'image/jpeg',
      data: new Uint8Array([0xff, 0xd8]).buffer,
    })
    expect(path.extname(filePath)).toBe('.jpg')
  })

  it('infers .gif extension for image/gif MIME type', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      type: 'image/gif',
      data: new Uint8Array([0x47, 0x49]).buffer,
    })
    expect(path.extname(filePath)).toBe('.gif')
  })

  it('infers .webp extension for image/webp MIME type', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      type: 'image/webp',
      data: new Uint8Array([0x52, 0x49]).buffer,
    })
    expect(path.extname(filePath)).toBe('.webp')
  })

  it('infers .bmp extension for image/bmp MIME type', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      type: 'image/bmp',
      data: new Uint8Array([0x42, 0x4d]).buffer,
    })
    expect(path.extname(filePath)).toBe('.bmp')
  })

  it('uses no extension for unknown MIME types', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      type: 'application/octet-stream',
      data: new Uint8Array([0x00]).buffer,
    })
    expect(path.extname(filePath)).toBe('')
    expect(path.basename(filePath)).toMatch(/^pasted-file-/)
  })

  it('uses extension from name when provided', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      name: 'screenshot.png',
      type: 'image/png',
      data: new Uint8Array([0x89]).buffer,
    })
    expect(path.extname(filePath)).toBe('.png')
    expect(path.basename(filePath)).toMatch(/^screenshot-/)
  })

  it('handles names with special characters', async () => {
    store = new TransientFileStore()
    const filePath = await store.persist({
      name: '!!!@@@###.png',
      type: 'image/png',
      data: new Uint8Array([0x89]).buffer,
    })
    expect(path.basename(filePath)).not.toContain('!')
    expect(path.basename(filePath)).not.toContain('@')
  })

  it('dispose is safe to call without any persists', async () => {
    store = new TransientFileStore()
    await expect(store.dispose()).resolves.toBeUndefined()
  })

  it('dispose is safe to call multiple times', async () => {
    store = new TransientFileStore()
    await store.persist({
      type: 'image/png',
      data: new Uint8Array([0x89]).buffer,
    })
    await store.dispose()
    await expect(store.dispose()).resolves.toBeUndefined()
    store = null
  })

  it('persists multiple files in the same store', async () => {
    store = new TransientFileStore()
    const path1 = await store.persist({
      type: 'image/png',
      data: new Uint8Array([1]).buffer,
    })
    const path2 = await store.persist({
      type: 'image/jpeg',
      data: new Uint8Array([2]).buffer,
    })
    expect(path1).not.toBe(path2)
    expect(path.dirname(path1)).toBe(path.dirname(path2))
  })
})
