import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { openFileReferenceTarget } from './fileReferences'

describe('openFileReferenceTarget', () => {
  it('opens the parsed file path without the line suffix', async () => {
    const openPath = vi.fn().mockResolvedValue('')

    await openFileReferenceTarget('C:/repo/src/main.c#L42', { openPath })

    expect(openPath).toHaveBeenCalledWith('C:/repo/src/main.c')
  })

  it('rejects relative file references', async () => {
    await expect(
      openFileReferenceTarget('src/main.c', {
        openPath: vi.fn().mockResolvedValue(''),
      }),
    ).rejects.toThrow('File reference must use an absolute or home-relative path.')
  })

  it('expands home-relative file references before opening them', async () => {
    const openPath = vi.fn().mockResolvedValue('')

    await openFileReferenceTarget('~\\Downloads\\report.md', { openPath })

    expect(openPath).toHaveBeenCalledWith(
      path.join(os.homedir(), 'Downloads', 'report.md'),
    )
  })
})
