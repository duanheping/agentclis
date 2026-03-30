import { describe, expect, it } from 'vitest'

import {
  buildQuotaFailureSummary,
  detectQuotaFailure,
} from './agentFailureSummary'

describe('agentFailureSummary', () => {
  it('detects English and Chinese quota exhaustion text', () => {
    expect(detectQuotaFailure('ERROR: limit exceeded, 额度用完了')).toBe(true)
    expect(detectQuotaFailure('rate limit exceeded')).toBe(true)
    expect(detectQuotaFailure('all good')).toBe(false)
  })

  it('builds a short normalized quota failure summary', () => {
    expect(buildQuotaFailureSummary('codex')).toBe(
      'Codex quota exceeded during structured analysis. Retry later or switch agents.',
    )
  })
})
