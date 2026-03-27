import type {
  ListSessionsResponse,
  SessionAttentionKind,
  SessionSnapshot,
} from './session'

const NEEDS_USER_DECISION_PATTERNS = [
  /\b(?:do you want|would you like|should I|want me to)\b/i,
  /\b(?:need your|needs your) (?:input|decision|approval)\b/i,
  /\b(?:let me know|tell me) which\b/i,
  /\breply with\b/i,
  /\b(?:choose|select|pick|approve|deny|confirm)\b/i,
  /\bwhich (?:option|path|approach|one)\b/i,
]
const TERMINAL_APPROVAL_PATTERNS = [
  /\bwould you like to run (?:the following )?command\?/i,
  /\bpress enter to confirm or esc to cancel\b/i,
]

function flattenSessions(workspace: ListSessionsResponse): SessionSnapshot[] {
  return workspace.projects.flatMap((project) => project.sessions)
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

function normalizeAttentionText(content: string): string {
  return content.trim().replace(/\s+/g, ' ')
}

function getAttentionPriority(attention: SessionAttentionKind): number {
  return attention === 'needs-user-decision' ? 0 : 1
}

function extractCodexMessageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((entry) =>
      entry &&
      typeof entry === 'object' &&
      'text' in entry &&
      typeof entry.text === 'string'
        ? entry.text
        : '',
    )
    .join('')
    .trim()
}

export function classifySessionAttentionFromText(
  content: string,
): SessionAttentionKind {
  const normalized = normalizeAttentionText(content)
  if (!normalized) {
    return 'task-complete'
  }

  if (NEEDS_USER_DECISION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'needs-user-decision'
  }

  if (/\?\s*$/u.test(normalized)) {
    return 'needs-user-decision'
  }

  return 'task-complete'
}

export function extractTerminalAttentionFromText(
  content: string,
): SessionAttentionKind | null {
  const normalized = normalizeAttentionText(content)
  if (!normalized) {
    return null
  }

  return TERMINAL_APPROVAL_PATTERNS.some((pattern) => pattern.test(normalized))
    ? 'needs-user-decision'
    : null
}

export function extractCodexAttentionFromSessionLine(
  line: string,
): SessionAttentionKind | null {
  const parsed = parseJsonLine(line)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const { type, payload } = parsed as {
    payload?: {
      type?: string
      role?: string
      phase?: string
      content?: unknown
    }
    type?: string
  }
  if (type !== 'response_item') {
    const { payload } = parsed as {
      payload?: {
        type?: string
        phase?: string
        message?: string
        last_agent_message?: string
      }
      type?: string
    }

    if (type !== 'event_msg') {
      return null
    }

    if (
      payload?.type === 'agent_message' &&
      payload.phase === 'final_answer' &&
      typeof payload.message === 'string' &&
      payload.message.trim()
    ) {
      return classifySessionAttentionFromText(payload.message)
    }

    if (payload?.type !== 'task_complete') {
      return null
    }

    if (
      typeof payload.last_agent_message === 'string' &&
      payload.last_agent_message.trim()
    ) {
      return classifySessionAttentionFromText(payload.last_agent_message)
    }

    return 'task-complete'
  }

  if (
    payload?.type !== 'message' ||
    payload.role !== 'assistant' ||
    payload.phase !== 'final_answer'
  ) {
    return null
  }

  const content = extractCodexMessageText(payload.content)
  if (!content) {
    return null
  }

  return classifySessionAttentionFromText(content)
}

export function extractCopilotAttentionFromSessionLine(
  line: string,
): SessionAttentionKind | null {
  const parsed = parseJsonLine(line)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const { data, type } = parsed as {
    data?: {
      content?: string
      toolRequests?: unknown[]
    }
    type?: string
  }
  if (type !== 'assistant.message') {
    return null
  }

  if (!Array.isArray(data?.toolRequests) || data.toolRequests.length > 0) {
    return null
  }

  const content = data.content?.trim()
  if (!content) {
    return null
  }

  return classifySessionAttentionFromText(content)
}

export function getSessionAttentionBadgeLabel(
  attention: SessionAttentionKind,
): string {
  return attention === 'needs-user-decision' ? 'Reply' : 'Done'
}

export function getSessionAttentionTitleLabel(
  attention: SessionAttentionKind,
): string {
  return attention === 'needs-user-decision'
    ? 'Reply needed'
    : 'Task complete'
}

export function getSessionAttentionNotificationBody(
  attention: SessionAttentionKind,
  sessionTitle: string,
): string {
  const title = sessionTitle.trim() || 'A session'
  return attention === 'needs-user-decision'
    ? `${title} is waiting for your approval or reply.`
    : `${title} finished and is ready for review.`
}

export function selectHighestPriorityAttentionSession(
  workspace: ListSessionsResponse,
): SessionSnapshot | null {
  return (
    flattenSessions(workspace)
      .filter(
        (session): session is SessionSnapshot & {
          runtime: SessionSnapshot['runtime'] & {
            attention: SessionAttentionKind
          }
        } => Boolean(session.runtime.attention),
      )
      .sort((left, right) => {
        const priorityDelta =
          getAttentionPriority(left.runtime.attention) -
          getAttentionPriority(right.runtime.attention)

        if (priorityDelta !== 0) {
          return priorityDelta
        }

        return right.runtime.lastActiveAt.localeCompare(left.runtime.lastActiveAt)
      })[0] ?? null
  )
}

export function formatWorkspaceWindowTitle(
  workspace: ListSessionsResponse,
  brandName: string,
): string {
  const attentionSession = selectHighestPriorityAttentionSession(workspace)
  if (attentionSession?.runtime.attention) {
    return `${getSessionAttentionTitleLabel(attentionSession.runtime.attention)}: ${attentionSession.config.title} - ${brandName}`
  }

  return brandName
}
