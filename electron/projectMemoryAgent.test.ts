// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { parseProjectMemoryResponse } from './projectMemoryAgent'

describe('parseProjectMemoryResponse', () => {
  it('drops malformed candidates that do not match the allowed enums and scalar types', () => {
    const parsed = parseProjectMemoryResponse(
      JSON.stringify({
        summary: 'Stable summary',
        candidates: [
          {
            kind: 'fact',
            scope: 'project',
            key: 'preferred-shell',
            content: 'Prefer PowerShell over cmd.',
            confidence: 0.91,
            sourceEventIds: ['event-1'],
          },
          {
            kind: 'invalid-kind',
            scope: 'project',
            key: 'bad-kind',
            content: 'Should be ignored.',
            confidence: 0.7,
            sourceEventIds: ['event-2'],
          },
          {
            kind: 'workflow',
            scope: 'invalid-scope',
            key: 'bad-scope',
            content: 'Should also be ignored.',
            confidence: 0.8,
            sourceEventIds: ['event-3'],
          },
          {
            kind: 'decision',
            scope: 'project',
            key: 'bad-confidence',
            content: 'Wrong confidence type.',
            confidence: '0.8',
            sourceEventIds: ['event-4'],
          },
        ],
      }),
    )

    expect(parsed).toEqual({
      summary: 'Stable summary',
      candidates: [
        {
          kind: 'fact',
          scope: 'project',
          key: 'preferred-shell',
          content: 'Prefer PowerShell over cmd.',
          confidence: 0.91,
          sourceEventIds: ['event-1'],
        },
      ],
    })
  })
})
