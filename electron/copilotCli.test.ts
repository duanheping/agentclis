// @vitest-environment node

import { describe, expect, it } from 'vitest'

import {
  buildCopilotResumeCommand,
  extractCopilotSessionMeta,
  supportsCopilotSessionResume,
} from './copilotCli'

describe('copilotCli', () => {
  it('recognizes interactive Copilot commands as resumable', () => {
    expect(supportsCopilotSessionResume('copilot --model gpt-5.2')).toBe(true)
    expect(supportsCopilotSessionResume('copilot -p "review this diff"')).toBe(
      false,
    )
  })

  it('builds a resume command while preserving resume-safe options', () => {
    expect(
      buildCopilotResumeCommand(
        'copilot --model gpt-5.2 --allow-all -i "Fix this"',
        '938fdaf9-c35d-42ab-bca3-566ab3d91f79',
      ),
    ).toBe(
      'copilot --model gpt-5.2 --allow-all --resume 938fdaf9-c35d-42ab-bca3-566ab3d91f79',
    )
  })

  it('extracts session metadata from workspace.yaml', () => {
    expect(
      extractCopilotSessionMeta(
        [
          'id: 938fdaf9-c35d-42ab-bca3-566ab3d91f79',
          'cwd: C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
          'summary: Review ECG2 Callout Analysis',
          'created_at: 2026-03-11T17:15:35.021Z',
        ].join('\n'),
      ),
    ).toEqual({
      sessionId: '938fdaf9-c35d-42ab-bca3-566ab3d91f79',
      timestamp: '2026-03-11T17:15:35.021Z',
      cwd: 'C:\\Users\\hduan10\\Documents\\repo\\MSAR43_S32G',
      summary: 'Review ECG2 Callout Analysis',
    })
  })
})
