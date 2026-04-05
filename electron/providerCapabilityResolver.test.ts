// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { resolveProjectMemoryCapability } from './providerCapabilityResolver'

describe('providerCapabilityResolver', () => {
  it('enables hidden session-start memory for Codex', () => {
    expect(resolveProjectMemoryCapability('codex --model gpt-5.2')).toEqual({
      provider: 'codex',
      mode: 'codex-developer-instructions',
      supportsHiddenSessionStart: true,
      supportsHiddenPromptUpdate: false,
      fallbackReason: null,
    })
  })

  it('enables hidden instructions for Copilot', () => {
    expect(resolveProjectMemoryCapability('copilot --model gpt-5.2')).toEqual({
      provider: 'copilot',
      mode: 'copilot-instructions',
      supportsHiddenSessionStart: true,
      supportsHiddenPromptUpdate: false,
      fallbackReason: null,
    })
  })

  it('marks non-managed commands as unsupported', () => {
    expect(resolveProjectMemoryCapability('node index.js')).toEqual({
      provider: null,
      mode: 'unsupported',
      supportsHiddenSessionStart: false,
      supportsHiddenPromptUpdate: false,
      fallbackReason:
        'Hidden project memory is currently supported only for Codex and Copilot sessions.',
    })
  })
})
