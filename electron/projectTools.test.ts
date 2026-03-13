// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import { openProjectInTarget } from './projectTools'

describe('projectTools', () => {
  it('opens VS Code using the vscode URI handler first', async () => {
    const shell = {
      openExternal: vi.fn().mockResolvedValue(undefined),
      openPath: vi.fn().mockResolvedValue(''),
    }

    await openProjectInTarget('vscode', process.cwd(), shell)

    expect(shell.openExternal).toHaveBeenCalledTimes(1)
    expect(shell.openExternal.mock.calls[0]?.[0]).toMatch(/^vscode:\/\/file\//)
  })
})
