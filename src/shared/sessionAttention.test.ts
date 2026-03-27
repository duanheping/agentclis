import { describe, expect, it } from 'vitest'

import type { ListSessionsResponse } from './session'
import {
  classifySessionAttentionFromText,
  extractCodexAttentionFromSessionLine,
  extractCopilotAttentionFromSessionLine,
  formatWorkspaceWindowTitle,
  getSessionAttentionBadgeLabel,
  getSessionAttentionTitleLabel,
  reduceCodexAttentionState,
  reduceCopilotAttentionState,
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

  it('detects Codex final answers from event_msg agent messages', () => {
    const line =
      '{"type":"event_msg","payload":{"type":"agent_message","message":"All done. Here is the summary.","phase":"final_answer"}}'

    expect(extractCodexAttentionFromSessionLine(line)).toBe('task-complete')
  })

  it('detects Codex task_complete events as task completion', () => {
    const line =
      '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","last_agent_message":"All done."}}'

    expect(extractCodexAttentionFromSessionLine(line)).toBe('task-complete')
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

  it('returns null from Codex extractor for invalid JSON', () => {
    expect(extractCodexAttentionFromSessionLine('not json at all')).toBeNull()
    expect(extractCodexAttentionFromSessionLine('{malformed')).toBeNull()
  })

  it('returns null from Codex extractor for wrong type field', () => {
    const line = '{"type":"something_else","payload":{}}'
    expect(extractCodexAttentionFromSessionLine(line)).toBeNull()
  })

  it('returns null from Codex extractor when content is empty', () => {
    const line = '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[]}}'
    expect(extractCodexAttentionFromSessionLine(line)).toBeNull()
  })

  it('returns null from Codex extractor when payload is non-object', () => {
    expect(extractCodexAttentionFromSessionLine('{"type":"response_item","payload":null}')).toBeNull()
    expect(extractCodexAttentionFromSessionLine('"just a string"')).toBeNull()
  })

  it('returns null from Copilot extractor for invalid JSON', () => {
    expect(extractCopilotAttentionFromSessionLine('')).toBeNull()
    expect(extractCopilotAttentionFromSessionLine('{bad}')).toBeNull()
  })

  it('returns null from Copilot extractor for wrong type', () => {
    expect(extractCopilotAttentionFromSessionLine('{"type":"tool.call","data":{}}')).toBeNull()
  })

  it('returns null from Copilot extractor when toolRequests is missing', () => {
    const line = '{"type":"assistant.message","data":{"content":"hello"}}'
    expect(extractCopilotAttentionFromSessionLine(line)).toBeNull()
  })

  it('returns null from Copilot extractor when content is empty', () => {
    const line = '{"type":"assistant.message","data":{"content":"","toolRequests":[]}}'
    expect(extractCopilotAttentionFromSessionLine(line)).toBeNull()
  })

  it('reduces Codex attention state across a completed turn', () => {
    let attention = reduceCodexAttentionState(
      null,
      '{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Should I continue?"}]}}',
    )

    expect(attention).toBe('needs-user-decision')

    attention = reduceCodexAttentionState(
      attention,
      '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}',
    )

    expect(attention).toBe('needs-user-decision')

    attention = reduceCodexAttentionState(
      attention,
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"yes"}]}}',
    )

    expect(attention).toBeNull()
  })

  it('reduces Copilot attention state and clears it on user events', () => {
    let attention = reduceCopilotAttentionState(
      null,
      '{"type":"assistant.message","data":{"content":"All done.","toolRequests":[]}}',
    )

    expect(attention).toBe('task-complete')

    attention = reduceCopilotAttentionState(
      attention,
      '{"type":"user.message","data":{"content":"next task"}}',
    )

    expect(attention).toBeNull()
  })

  it('classifies text with question mark as needs-user-decision', () => {
    expect(classifySessionAttentionFromText('Should I continue?')).toBe('needs-user-decision')
  })

  it('classifies empty/whitespace text as task-complete', () => {
    expect(classifySessionAttentionFromText('')).toBe('task-complete')
    expect(classifySessionAttentionFromText('   ')).toBe('task-complete')
  })

  it('detects all NEEDS_USER_DECISION_PATTERNS', () => {
    expect(classifySessionAttentionFromText('Do you want me to apply this?')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Would you like me to proceed?')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Should I create the file?')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('I need your input on this.')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Let me know which option works.')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Reply with your preference.')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Please choose an option.')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Which approach do you prefer?')).toBe('needs-user-decision')
    expect(classifySessionAttentionFromText('Please confirm the changes.')).toBe('needs-user-decision')
  })

  it('classifies neutral statements as task-complete', () => {
    expect(classifySessionAttentionFromText('I have completed the fix.')).toBe('task-complete')
    expect(classifySessionAttentionFromText('All changes applied successfully.')).toBe('task-complete')
  })

  it('returns correct badge labels', () => {
    expect(getSessionAttentionBadgeLabel('needs-user-decision')).toBe('Reply')
    expect(getSessionAttentionBadgeLabel('task-complete')).toBe('Done')
  })

  it('returns correct title labels', () => {
    expect(getSessionAttentionTitleLabel('needs-user-decision')).toBe('Reply needed')
    expect(getSessionAttentionTitleLabel('task-complete')).toBe('Task complete')
  })

  it('selectHighestPriorityAttentionSession returns null when no sessions have attention', () => {
    const workspace: ListSessionsResponse = {
      projects: [{
        config: {
          id: 'p1', title: 'P', rootPath: 'C:\\p', createdAt: '', updatedAt: '',
        },
        sessions: [{
          config: {
            id: 's1', projectId: 'p1', title: 'S', startupCommand: 'codex',
            pendingFirstPromptTitle: false, cwd: 'C:\\p', shell: 'pwsh.exe',
            createdAt: '', updatedAt: '',
          },
          runtime: { sessionId: 's1', status: 'running', attention: null, lastActiveAt: '' },
        }],
      }],
      activeSessionId: 's1',
    }
    expect(selectHighestPriorityAttentionSession(workspace)).toBeNull()
  })

  it('selectHighestPriorityAttentionSession breaks tie by most recent lastActiveAt', () => {
    const workspace: ListSessionsResponse = {
      projects: [{
        config: {
          id: 'p1', title: 'P', rootPath: 'C:\\p', createdAt: '', updatedAt: '',
        },
        sessions: [
          {
            config: {
              id: 'older', projectId: 'p1', title: 'Older', startupCommand: 'codex',
              pendingFirstPromptTitle: false, cwd: 'C:\\p', shell: 'pwsh.exe',
              createdAt: '', updatedAt: '',
            },
            runtime: { sessionId: 'older', status: 'running', attention: 'task-complete', lastActiveAt: '2026-01-01T00:00:00Z' },
          },
          {
            config: {
              id: 'newer', projectId: 'p1', title: 'Newer', startupCommand: 'codex',
              pendingFirstPromptTitle: false, cwd: 'C:\\p', shell: 'pwsh.exe',
              createdAt: '', updatedAt: '',
            },
            runtime: { sessionId: 'newer', status: 'running', attention: 'task-complete', lastActiveAt: '2026-01-02T00:00:00Z' },
          },
        ],
      }],
      activeSessionId: 'older',
    }
    expect(selectHighestPriorityAttentionSession(workspace)?.config.id).toBe('newer')
  })

  it('formatWorkspaceWindowTitle returns brand name when no attention', () => {
    const workspace: ListSessionsResponse = {
      projects: [{
        config: { id: 'p1', title: 'P', rootPath: 'C:\\p', createdAt: '', updatedAt: '' },
        sessions: [{
          config: {
            id: 's1', projectId: 'p1', title: 'S', startupCommand: 'codex',
            pendingFirstPromptTitle: false, cwd: 'C:\\p', shell: 'pwsh.exe',
            createdAt: '', updatedAt: '',
          },
          runtime: { sessionId: 's1', status: 'running', attention: null, lastActiveAt: '' },
        }],
      }],
      activeSessionId: 's1',
    }
    expect(formatWorkspaceWindowTitle(workspace, 'Agent CLIs')).toBe('Agent CLIs')
  })

  it('formatWorkspaceWindowTitle shows Done for task-complete attention', () => {
    const workspace: ListSessionsResponse = {
      projects: [{
        config: { id: 'p1', title: 'P', rootPath: 'C:\\p', createdAt: '', updatedAt: '' },
        sessions: [{
          config: {
            id: 's1', projectId: 'p1', title: 'my session',
            startupCommand: 'codex', pendingFirstPromptTitle: false,
            cwd: 'C:\\p', shell: 'pwsh.exe', createdAt: '', updatedAt: '',
          },
          runtime: { sessionId: 's1', status: 'running', attention: 'task-complete', lastActiveAt: '2026-01-01T00:00:00Z' },
        }],
      }],
      activeSessionId: 's1',
    }
    expect(formatWorkspaceWindowTitle(workspace, 'Agent CLIs')).toBe(
      'Task complete: my session - Agent CLIs',
    )
  })
})
