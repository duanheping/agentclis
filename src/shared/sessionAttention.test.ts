import { describe, expect, it } from 'vitest'

import type { ListSessionsResponse } from './session'
import {
  extractCodexAttentionFromSessionLine,
  extractCopilotAttentionFromSessionLine,
  formatWorkspaceWindowTitle,
  selectHighestPriorityAttentionSession,
} from './sessionAttention'

function buildWorkspacePayload(): ListSessionsResponse {
  return {
    projects: [
      {
        config: {
          id: 'project-1',
          title: 'Workspace',
          rootPath: 'C:\\repo',
          createdAt: '2026-03-24T18:00:00.000Z',
          updatedAt: '2026-03-24T18:00:00.000Z',
        },
        sessions: [
          {
            config: {
              id: 'session-1',
              projectId: 'project-1',
              title: 'review PR',
              startupCommand: 'codex',
              pendingFirstPromptTitle: false,
              cwd: 'C:\\repo',
              shell: 'pwsh.exe',
              createdAt: '2026-03-24T18:00:00.000Z',
              updatedAt: '2026-03-24T18:00:00.000Z',
            },
            runtime: {
              sessionId: 'session-1',
              status: 'running',
              attention: 'task-complete',
              lastActiveAt: '2026-03-24T18:00:01.000Z',
            },
          },
          {
            config: {
              id: 'session-2',
              projectId: 'project-1',
              title: 'ship fix',
              startupCommand: 'copilot',
              pendingFirstPromptTitle: false,
              cwd: 'C:\\repo',
              shell: 'pwsh.exe',
              createdAt: '2026-03-24T18:00:00.000Z',
              updatedAt: '2026-03-24T18:00:00.000Z',
            },
            runtime: {
              sessionId: 'session-2',
              status: 'running',
              attention: 'needs-user-decision',
              lastActiveAt: '2026-03-24T18:00:02.000Z',
            },
          },
        ],
      },
    ],
    activeSessionId: 'session-1',
  }
}

describe('sessionAttention', () => {
  it('detects Codex final answers from structured session lines', () => {
    const line =
      '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Task finished. Let me know which option you want me to take next."}]}}'

    expect(extractCodexAttentionFromSessionLine(line)).toBe(
      'needs-user-decision',
    )
  })

  it('ignores non-final Codex commentary updates', () => {
    const line =
      '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Still working."}]}}'

    expect(extractCodexAttentionFromSessionLine(line)).toBeNull()
  })

  it('detects Copilot final answers with no pending tool requests', () => {
    const line =
      '{"type":"assistant.message","data":{"content":"All done. Here is the summary.","toolRequests":[]}}'

    expect(extractCopilotAttentionFromSessionLine(line)).toBe('task-complete')
  })

  it('ignores Copilot messages that are still requesting tools', () => {
    const line =
      '{"type":"assistant.message","data":{"content":"Checking that now.","toolRequests":[{"name":"powershell"}]}}'

    expect(extractCopilotAttentionFromSessionLine(line)).toBeNull()
  })

  it('prioritizes reply-needed sessions in shared window title formatting', () => {
    const workspace = buildWorkspacePayload()

    expect(selectHighestPriorityAttentionSession(workspace)?.config.id).toBe(
      'session-2',
    )
    expect(formatWorkspaceWindowTitle(workspace, 'Agent CLIs')).toBe(
      'Reply needed: ship fix - Agent CLIs',
    )
  })
})
