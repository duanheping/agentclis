// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readCodexSessionPrefix } from './codexSessionFiles'

describe('readCodexSessionPrefix', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agentclis-codex-prefix-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it.each(['.jsonl', '.jsonl.zst'])('bounds the decompressed prefix of %s rollouts', async (extension) => {
    const content = Buffer.from('session metadata\n' + 'large history\n'.repeat(100_000))
    const filePath = path.join(tempRoot, `rollout${extension}`)
    await writeFile(filePath, extension.endsWith('.zst') ? zstdCompressSync(content) : content)

    expect(await readCodexSessionPrefix(filePath)).toBe(content.subarray(0, 4096).toString())
  })

  it('reads a short compressed rollout to the end', async () => {
    const filePath = path.join(tempRoot, 'rollout.jsonl.zst')
    await writeFile(filePath, zstdCompressSync(Buffer.from('metadata\n')))

    expect(await readCodexSessionPrefix(filePath)).toBe('metadata\n')
  })

  it('rejects corrupt compressed rollouts', async () => {
    const filePath = path.join(tempRoot, 'rollout.jsonl.zst')
    await writeFile(filePath, 'invalid zstd')

    await expect(readCodexSessionPrefix(filePath)).rejects.toThrow()
  })

  it('propagates file read errors for compressed rollouts', async () => {
    await expect(readCodexSessionPrefix(path.join(tempRoot, 'missing.jsonl.zst')))
      .rejects.toThrow('ENOENT')
  })
})
