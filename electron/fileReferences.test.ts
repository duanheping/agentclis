import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { openFileReferenceTarget } from './fileReferences'

describe('openFileReferenceTarget', () => {
  it('opens the parsed file path without the line suffix', async () => {
    const openPath = vi.fn().mockResolvedValue('')
    const statPath = vi.fn().mockResolvedValue({})

    await openFileReferenceTarget(
      'C:/repo/src/main.c#L42',
      { openPath },
      { statPath },
    )

    expect(statPath).toHaveBeenCalledWith('C:/repo/src/main.c')
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
    const statPath = vi.fn().mockResolvedValue({})

    await openFileReferenceTarget(
      'Design_Docs/ECG-213664_CddDrm_findings.md:12',
      { openPath },
      { baseDir: 'C:\\repo', statPath },
    )

    expect(statPath).toHaveBeenCalledWith(
      'C:\\repo\\Design_Docs\\ECG-213664_CddDrm_findings.md',
    )
    expect(openPath).toHaveBeenCalledWith(
      'C:\\repo\\Design_Docs\\ECG-213664_CddDrm_findings.md',
    )
  })

  it('expands home-relative file references before opening them', async () => {
    const openPath = vi.fn().mockResolvedValue('')
    const statPath = vi.fn().mockResolvedValue({})

    await openFileReferenceTarget(
      '~\\Downloads\\report.md',
      { openPath },
      { statPath },
    )

    expect(statPath).toHaveBeenCalledWith(
      path.join(os.homedir(), 'Downloads', 'report.md'),
    )
    expect(openPath).toHaveBeenCalledWith(
      path.join(os.homedir(), 'Downloads', 'report.md'),
    )
  })

  it('rejects missing resolved paths before asking Electron to open them', async () => {
    const openPath = vi.fn().mockResolvedValue('')
    const statPath = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      }),
    )

    await expect(
      openFileReferenceTarget(
        'Design_Docs/missing.md:12',
        { openPath },
        { baseDir: 'C:\\repo', statPath },
      ),
    ).rejects.toThrow(
      'File reference path does not exist (target="Design_Docs/missing.md:12", resolvedPath="C:\\repo\\Design_Docs\\missing.md", baseDir="C:\\repo")',
    )

    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports the target and resolved path when Electron cannot open it', async () => {
    const openPath = vi.fn().mockResolvedValue('Failed to open path')
    const statPath = vi.fn().mockResolvedValue({})

    await expect(
      openFileReferenceTarget(
        'Design_Docs/report.md',
        { openPath },
        { baseDir: 'C:\\repo', statPath },
      ),
    ).rejects.toThrow(
      'Failed to open file reference (target="Design_Docs/report.md", resolvedPath="C:\\repo\\Design_Docs\\report.md", baseDir="C:\\repo"): Failed to open path',
    )
  })
})
