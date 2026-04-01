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

function parseCodexEvent(line: string): {
  payload?: {
    content?: unknown
    last_agent_message?: string
    message?: string
    phase?: string
    role?: string
    type?: string
  }
  type?: string
} | null {
  const parsed = parseJsonLine(line)
  return parsed && typeof parsed === 'object'
    ? (parsed as {
        payload?: {
          content?: unknown
          last_agent_message?: string
          message?: string
          phase?: string
          role?: string
          type?: string
        }
        type?: string
      })
    : null
}

function extractCodexAttentionFromParsedEvent(
  parsed: ReturnType<typeof parseCodexEvent>,
): SessionAttentionKind | null {
  if (!parsed) {
    return null
  }

  if (parsed.type === 'response_item') {
    const payload = parsed.payload
    if (
      payload?.type !== 'message' ||
      payload.role !== 'assistant' ||
      payload.phase !== 'final_answer'
    ) {
      return null
    }

    const content = extractCodexMessageText(payload.content)
    return content ? classifySessionAttentionFromText(content) : null
  }

  if (parsed.type !== 'event_msg') {
    return null
  }

  const payload = parsed.payload
  if (payload?.type === 'task_complete') {
    if (
      typeof payload.last_agent_message === 'string' &&
      payload.last_agent_message.trim()
    ) {
      return classifySessionAttentionFromText(payload.last_agent_message)
    }

    return 'task-complete'
  }

  if (payload?.type !== 'agent_message' || payload.phase !== 'final_answer') {
    return null
  }

  const content = payload.message?.trim()
  return content ? classifySessionAttentionFromText(content) : null
}

function shouldResetCodexAttention(
  parsed: ReturnType<typeof parseCodexEvent>,
): boolean {
  if (!parsed) {
    return false
  }

  if (
    parsed.type === 'response_item' &&
    parsed.payload?.type === 'message' &&
    parsed.payload.role === 'user'
  ) {
    return true
  }

  return parsed.type === 'event_msg' && parsed.payload?.type === 'task_started'
}

function parseCopilotEvent(line: string): {
  data?: {
    content?: string
    toolRequests?: unknown[]
  }
  type?: string
} | null {
  const parsed = parseJsonLine(line)
  return parsed && typeof parsed === 'object'
    ? (parsed as {
        data?: {
          content?: string
          toolRequests?: unknown[]
        }
        type?: string
      })
    : null
}

function isCopilotAssistantTurnComplete(
  parsed: ReturnType<typeof parseCopilotEvent>,
): boolean {
  if (!parsed || parsed.type !== 'assistant.message') {
    return false
  }

  return Array.isArray(parsed.data?.toolRequests) && parsed.data.toolRequests.length === 0
}

function extractCopilotAttentionFromParsedEvent(
  parsed: ReturnType<typeof parseCopilotEvent>,
): SessionAttentionKind | null {
  if (!parsed || parsed.type !== 'assistant.message') {
    return null
  }

  if (!Array.isArray(parsed.data?.toolRequests) || parsed.data.toolRequests.length > 0) {
    return null
  }

  const content = parsed.data.content?.trim()
  return content ? classifySessionAttentionFromText(content) : null
}

function shouldResetCopilotAttention(
  parsed: ReturnType<typeof parseCopilotEvent>,
): boolean {
  return Boolean(parsed?.type?.startsWith('user.'))
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
  return extractCodexAttentionFromParsedEvent(parseCodexEvent(line))
}

export function extractCopilotAttentionFromSessionLine(
  line: string,
): SessionAttentionKind | null {
  return extractCopilotAttentionFromParsedEvent(parseCopilotEvent(line))
}

export function reduceCodexAttentionState(
  current: SessionAttentionKind | null,
  line: string,
): SessionAttentionKind | null {
  const parsed = parseCodexEvent(line)
  if (shouldResetCodexAttention(parsed)) {
    return null
  }

  const nextAttention = extractCodexAttentionFromParsedEvent(parsed)
  if (!nextAttention) {
    return current
  }

  if (current === 'needs-user-decision' && nextAttention === 'task-complete') {
    return current
  }

  return nextAttention
}

export function reduceCopilotAttentionState(
  current: SessionAttentionKind | null,
  line: string,
): SessionAttentionKind | null {
  const parsed = parseCopilotEvent(line)
  if (shouldResetCopilotAttention(parsed)) {
    return null
  }

  return extractCopilotAttentionFromParsedEvent(parsed) ?? current
}

export function reduceCopilotAwaitingResponseState(
  current: boolean,
  line: string,
): boolean {
  const parsed = parseCopilotEvent(line)
  if (!parsed) {
    return current
  }

  if (parsed.type === 'user.message') {
    return true
  }

  if (parsed.type === 'assistant.turn_end') {
    return false
  }

  if (isCopilotAssistantTurnComplete(parsed)) {
    return false
  }

  return current
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
