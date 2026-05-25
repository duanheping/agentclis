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

  it('rejects relative file references without a base directory', async () => {
    await expect(
      openFileReferenceTarget('src/main.c', {
        openPath: vi.fn().mockResolvedValue(''),
      }),
    ).rejects.toThrow(
      'File reference must use an absolute, home-relative, or session-relative path.',
    )
  })

  it('resolves relative file references against the base directory', async () => {
    const openPath = vi.fn().mockResolvedValue('')

    await openFileReferenceTarget(
      'Design_Docs/ECG-213664_CddDrm_findings.md:12',
      { openPath },
      { baseDir: 'C:\\repo' },
    )

    expect(openPath).toHaveBeenCalledWith(
      'C:\\repo\\Design_Docs\\ECG-213664_CddDrm_findings.md',
    )
  })

  it('expands home-relative file references before opening them', async () => {
    const openPath = vi.fn().mockResolvedValue('')

    await openFileReferenceTarget('~\\Downloads\\report.md', { openPath })

    expect(openPath).toHaveBeenCalledWith(
      path.join(os.homedir(), 'Downloads', 'report.md'),
    )
  })
})
