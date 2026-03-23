import { describe, expect, it, vi } from 'vitest'

import { openExternalLinkTarget } from './externalLinks'

describe('openExternalLinkTarget', () => {
  it('opens http and https URLs in the browser', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)

    await openExternalLinkTarget('https://github.com/duanheping/agentclis', {
      openExternal,
    })

    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/duanheping/agentclis',
    )
  })

  it('rejects non-web URLs', async () => {
    await expect(
      openExternalLinkTarget('mailto:test@example.com', {
        openExternal: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('External link must use an absolute http or https URL.')
  })
})
