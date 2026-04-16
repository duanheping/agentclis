import type { TranscriptEvent } from '../src/shared/projectMemory'
import type {
  SessionRestoreSnapshot,
  SessionRuntime,
} from '../src/shared/session'

const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'gu',
)
const MAX_RESTORE_SUMMARY_CHARS = 200
const LOW_SIGNAL_LINE_REGEX =
  /^(?:[>#$%|\\/=_-]+|[0-9]+%?|yes|no|ok|done|continue|enter|press enter)$/iu
const SESSION_EXIT_MESSAGE_REGEX = /^Session exited with code (-?\d+)\.?$/iu
const SESSION_START_FAILURE_REGEX = /^Failed to start session: (.+)$/iu

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, '')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/\r/g, '').trim()
}

function clampSummary(value: string | null): string | null {
  const normalized = normalizeWhitespace(value ?? '')
  if (!normalized) {
    return null
  }

  if (normalized.length <= MAX_RESTORE_SUMMARY_CHARS) {
    return normalized
  }

  const preview = normalized.slice(0, MAX_RESTORE_SUMMARY_CHARS - 1)
  const breakPoint = preview.lastIndexOf(' ')
  if (breakPoint > Math.floor(MAX_RESTORE_SUMMARY_CHARS / 2)) {
    return `${preview.slice(0, breakPoint)}...`
  }

  return `${preview}...`
}

function summarizeRuntimeStatus(runtime: SessionRuntime): string {
  if (runtime.status === 'starting') {
    return 'Session is starting.'
  }

  if (runtime.status === 'running') {
    if (runtime.attention === 'needs-user-decision') {
      return 'Session is waiting for your input.'
    }

    if (runtime.attention === 'task-complete') {
      return 'Session finished and is waiting for review.'
    }

    if (runtime.awaitingResponse) {
      return 'Session is waiting for the agent to respond.'
    }

    return 'Session is running.'
  }

  if (runtime.status === 'error') {
    return runtime.exitCode === undefined
      ? 'Session failed.'
      : `Session failed with code ${runtime.exitCode}.`
  }

  if (runtime.exitCode === undefined || runtime.exitCode === 0) {
    return 'Session finished.'
  }

  return `Session exited with code ${runtime.exitCode}.`
}

function deriveBlockedReason(runtime: SessionRuntime): string | null {
  if (runtime.attention === 'needs-user-decision') {
    return 'Needs your input to continue.'
  }

  if (runtime.attention === 'task-complete') {
    return 'Task is complete and ready for review.'
  }

  return null
}

function extractReplySummary(chunk: string | undefined): string | null {
  const normalized = stripAnsi(chunk ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')

  const lines = normalized
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line) {
      continue
    }

    if (line.length < 8) {
      continue
    }

    if (LOW_SIGNAL_LINE_REGEX.test(line)) {
      continue
    }

    if (!/[A-Za-z0-9]/u.test(line)) {
      continue
    }

    return clampSummary(line)
  }

  return null
}

function normalizeOptionalSummary(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  return clampSummary(value)
}

export function buildSessionRestoreSnapshot(
  runtime: SessionRuntime,
  updatedAt = runtime.lastActiveAt,
): SessionRestoreSnapshot {
  const blockedReason = deriveBlockedReason(runtime)
  const resultSummary =
    runtime.status === 'exited' && runtime.exitCode === 0
      ? 'Session exited successfully.'
      : null
  const lastError =
    runtime.status === 'error'
      ? runtime.exitCode === undefined
        ? 'Session failed.'
        : `Session failed with code ${runtime.exitCode}.`
      : null

  return {
    statusSummary: summarizeRuntimeStatus(runtime),
    lastMeaningfulReply: null,
    resultSummary,
    blockedReason,
    lastError,
    updatedAt,
    hasTranscript: false,
    hasTerminalReplay: false,
  }
}

export function normalizeSessionRestoreSnapshot(
  snapshot: SessionRestoreSnapshot | null | undefined,
  runtime: SessionRuntime,
): SessionRestoreSnapshot {
  const base = buildSessionRestoreSnapshot(runtime)
  if (!snapshot) {
    return base
  }

  return {
    statusSummary:
      normalizeOptionalSummary(snapshot.statusSummary) ?? base.statusSummary,
    lastMeaningfulReply: normalizeOptionalSummary(snapshot.lastMeaningfulReply),
    resultSummary:
      normalizeOptionalSummary(snapshot.resultSummary) ?? base.resultSummary,
    blockedReason:
      normalizeOptionalSummary(snapshot.blockedReason) ?? base.blockedReason,
    lastError: normalizeOptionalSummary(snapshot.lastError) ?? base.lastError,
    updatedAt:
      typeof snapshot.updatedAt === 'string' && snapshot.updatedAt.trim()
        ? snapshot.updatedAt
        : base.updatedAt,
    hasTranscript: snapshot.hasTranscript === true,
    hasTerminalReplay: snapshot.hasTerminalReplay === true,
  }
}

export function applyRuntimeToSessionRestoreSnapshot(
  snapshot: SessionRestoreSnapshot,
  runtime: SessionRuntime,
  updatedAt = runtime.lastActiveAt,
): SessionRestoreSnapshot {
  const blockedReason = deriveBlockedReason(runtime)
  const nextResultSummary =
    runtime.status === 'starting' || runtime.status === 'running'
      ? null
      : runtime.status === 'exited' && runtime.exitCode === 0
        ? snapshot.resultSummary ?? 'Session exited successfully.'
        : snapshot.resultSummary
  const nextLastError =
    runtime.status === 'starting' || runtime.status === 'running'
      ? null
      : runtime.status === 'error'
        ? snapshot.lastError ??
          (runtime.exitCode === undefined
            ? 'Session failed.'
            : `Session failed with code ${runtime.exitCode}.`)
        : runtime.status === 'exited' && runtime.exitCode && runtime.exitCode !== 0
          ? snapshot.lastError ?? `Session exited with code ${runtime.exitCode}.`
          : snapshot.lastError

  return {
    ...snapshot,
    statusSummary: summarizeRuntimeStatus(runtime),
    resultSummary: nextResultSummary,
    blockedReason,
    lastError: nextLastError,
    updatedAt,
  }
}

export function applyTranscriptEventToSessionRestoreSnapshot(
  snapshot: SessionRestoreSnapshot,
  event: TranscriptEvent,
): SessionRestoreSnapshot {
  const nextSnapshot: SessionRestoreSnapshot = {
    ...snapshot,
    hasTranscript: true,
    updatedAt: event.timestamp,
  }

  if (event.kind === 'output') {
    const replySummary = extractReplySummary(event.chunk)
    if (replySummary) {
      nextSnapshot.lastMeaningfulReply = replySummary
    }
    nextSnapshot.hasTerminalReplay = true
    return nextSnapshot
  }

  if (event.kind !== 'system') {
    return nextSnapshot
  }

  const summary = clampSummary(event.chunk)
  if (!summary) {
    return nextSnapshot
  }

  const exitMatch = summary.match(SESSION_EXIT_MESSAGE_REGEX)
  if (exitMatch) {
    const exitCode = Number(exitMatch[1])
    nextSnapshot.resultSummary =
      exitCode === 0 ? 'Session exited successfully.' : summary
    if (exitCode !== 0) {
      nextSnapshot.lastError = summary
    }
    return nextSnapshot
  }

  const startFailureMatch = summary.match(SESSION_START_FAILURE_REGEX)
  if (startFailureMatch) {
    nextSnapshot.lastError = summary
    return nextSnapshot
  }

  return nextSnapshot
}

export function applyTerminalReplayToSessionRestoreSnapshot(
  snapshot: SessionRestoreSnapshot,
  updatedAt: string,
): SessionRestoreSnapshot {
  return {
    ...snapshot,
    updatedAt,
    hasTerminalReplay: true,
  }
}

export function sessionRestoreSnapshotsEqual(
  left: SessionRestoreSnapshot | undefined,
  right: SessionRestoreSnapshot | undefined,
): boolean {
  if (!left || !right) {
    return left === right
  }

  return (
    left.statusSummary === right.statusSummary &&
    left.lastMeaningfulReply === right.lastMeaningfulReply &&
    left.resultSummary === right.resultSummary &&
    left.blockedReason === right.blockedReason &&
    left.lastError === right.lastError &&
    left.updatedAt === right.updatedAt &&
    left.hasTranscript === right.hasTranscript &&
    left.hasTerminalReplay === right.hasTerminalReplay
  )
}
