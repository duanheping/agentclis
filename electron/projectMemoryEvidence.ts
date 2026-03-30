import type { TranscriptEvent } from '../src/shared/projectMemory'
import { truncateUtf8 } from './structuredAgentRunner'

const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'gu',
)
const MAX_EVIDENCE_PREVIEW_CHARS = 320
const DEFAULT_MAX_EVIDENCE_ENTRIES = 8
const LOW_SIGNAL_LINE_REGEX =
  /^(?:ok|done|thanks|checking|working|looking|continue|continuing|noted|sounds good)[.!]?$/iu
const MEMORY_SIGNAL_PATTERNS = [
  /\b(?:prefer|preferred|instead(?: of)?|rather than|use|using|avoid|must|should|do not|don't|never)\b/iu,
  /\b(?:works?|worked|working|fixed?|resolved?|resolution|root cause|diagnos(?:e|ed|is)|unblocked?|failure|failed|error|bug|regression)\b/iu,
  /\b(?:rest api|fetch|curl|gh cli|mcp|pull request|workflow|convention|bootstrap|project memory|sessionmanager|ipc)\b/iu,
  /\b(?:post|get|put|patch|delete)\s+\/repos\//iu,
  /`[^`]+`/u,
  /纠正|改用|优先|不要|最终|成功|失败|原因|解决|修复|应该|改成/u,
] as const

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, '')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/\r/g, '').trim()
}

function normalizeChunk(value: string | undefined): string {
  return normalizeWhitespace(stripAnsi(value ?? ''))
}

function isLowSignalLine(value: string): boolean {
  if (!value) {
    return true
  }

  if (value.length < 20) {
    return true
  }

  if (!/[a-z0-9\u4e00-\u9fff]/iu.test(value)) {
    return true
  }

  return LOW_SIGNAL_LINE_REGEX.test(value)
}

function scoreEvidenceLine(event: TranscriptEvent, normalized: string): number {
  let score = 0

  if (event.kind === 'input' && event.source === 'user') {
    score += 7
  } else if (event.kind === 'input') {
    score += 5
  } else if (event.kind === 'output') {
    score += 2
  } else {
    score += 1
  }

  if (normalized.length >= 48 && normalized.length <= 360) {
    score += 2
  }
  if (/[`/\\]/u.test(normalized)) {
    score += 1
  }
  if (/\.(?:ts|tsx|js|jsx|json|md)\b/iu.test(normalized)) {
    score += 2
  }

  for (const pattern of MEMORY_SIGNAL_PATTERNS) {
    if (pattern.test(normalized)) {
      score += 3
    }
  }

  return score
}

function buildUserTaskAnchors(transcript: TranscriptEvent[]): string[] {
  const userInputs = transcript
    .filter((event) => event.kind === 'input' && event.source === 'user')
    .map((event) => normalizeChunk(event.chunk))
    .filter((chunk) => !isLowSignalLine(chunk))

  if (userInputs.length === 0) {
    return []
  }

  const anchors = [`- First user request: ${truncateUtf8(userInputs[0]!, MAX_EVIDENCE_PREVIEW_CHARS)}`]
  const latest = userInputs.at(-1)
  if (latest && latest !== userInputs[0]) {
    anchors.push(`- Latest user request: ${truncateUtf8(latest, MAX_EVIDENCE_PREVIEW_CHARS)}`)
  }

  return anchors
}

export function buildTranscriptEvidenceDigest(
  transcript: TranscriptEvent[],
  maxBytes: number,
  maxEntries = DEFAULT_MAX_EVIDENCE_ENTRIES,
): string {
  if (transcript.length === 0) {
    return '(no high-signal transcript evidence)'
  }

  const scored = transcript
    .map((event, index) => {
      const normalized = normalizeChunk(event.chunk)
      if (isLowSignalLine(normalized)) {
        return null
      }

      return {
        event,
        index,
        normalized,
        score: scoreEvidenceLine(event, normalized),
      }
    })
    .filter((entry): entry is {
      event: TranscriptEvent
      index: number
      normalized: string
      score: number
    } => entry !== null && entry.score >= 6)
    .sort((left, right) => right.score - left.score || left.index - right.index)

  const selected: typeof scored = []
  const seen = new Set<string>()

  for (const entry of scored) {
    const dedupeKey = entry.normalized.toLowerCase()
    if (seen.has(dedupeKey)) {
      continue
    }
    if (
      selected.some(
        (candidate) =>
          Math.abs(candidate.index - entry.index) <= 1 &&
          candidate.event.source === entry.event.source,
      )
    ) {
      continue
    }

    selected.push(entry)
    seen.add(dedupeKey)

    if (selected.length >= maxEntries) {
      break
    }
  }

  selected.sort((left, right) => left.index - right.index)

  const taskAnchors = buildUserTaskAnchors(transcript)
  const evidenceLines = selected.map(
    (entry) =>
      `- ${entry.event.id} ${entry.event.kind}/${entry.event.source}: ${truncateUtf8(entry.normalized, MAX_EVIDENCE_PREVIEW_CHARS)}`,
  )

  const sections: string[] = []
  if (taskAnchors.length > 0) {
    sections.push('Task anchors from the session:', ...taskAnchors)
  }
  if (evidenceLines.length > 0) {
    sections.push(
      'High-signal evidence from across the session:',
      ...evidenceLines,
    )
  }

  if (sections.length === 0) {
    return '(no high-signal transcript evidence)'
  }

  return truncateUtf8(sections.join('\n'), maxBytes)
}
