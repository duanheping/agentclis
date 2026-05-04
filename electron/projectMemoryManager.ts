import {
  mkdir,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises'
import path from 'node:path'

import {
  PROJECT_MEMORY_CANDIDATE_KINDS,
  PROJECT_MEMORY_EXTRACTION_VERSION,
  PROJECT_MEMORY_SCOPES,
  PROJECT_MEMORY_STATUSES,
} from '../src/shared/projectMemory'
import type {
  AssembledProjectContext,
  ProjectLocation,
  ProjectIdentity,
  ProjectMemoryCandidate,
  ProjectMemoryCandidateKind,
  ProjectMemoryScope,
  ProjectMemoryStatus,
  ProjectMemorySnapshot,
  SessionSummary,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type {
  ArchitectureInteraction,
  ArchitectureInvariant,
  ArchitectureGlossaryTerm,
  ArchitectureModuleCard,
  ProjectArchitectureSnapshot,
} from '../src/shared/projectArchitecture'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import {
  finalizeArchitectureExtraction,
  type ProjectArchitectureExtractor,
} from './projectArchitectureAgent'
import { indexProjectArchitecture } from './projectArchitectureIndexer'
import { parseProjectMemoryResponse } from './projectMemoryAgent'
import type {
  HistoricalProjectSessionDescriptor,
  ProjectSessionHistoryAnalyzer,
} from './projectSessionHistoryAgent'
import { writeUtf8FileAtomic } from './atomicFile'
import { truncateUtf8 } from './structuredAgentRunner'
import type { PreparedStructuredAgent } from './structuredAgentRunner'

const MEMORY_ROOT_DIRECTORY = '.agenclis-memory'
const MAX_SOURCE_EVENT_IDS = 32
const HISTORICAL_SESSIONS_ANALYSIS_JSON = 'sessions-analysis.json'
const HISTORICAL_SESSIONS_ANALYSIS_MD = 'sessions-analysis.md'
type ProjectMemorySnapshotCandidateKey = Exclude<
  keyof ProjectMemorySnapshot,
  'summary'
>

interface ProjectMemoryBucketDefinition {
  kind: ProjectMemoryCandidateKind
  snapshotKey: ProjectMemorySnapshotCandidateKey
  fileName: string
  sectionTitle: string
  docFileName?: string
  docTitle?: string
  docDescription?: string
}

const PROJECT_MEMORY_BUCKETS: ProjectMemoryBucketDefinition[] = [
  {
    kind: 'fact',
    snapshotKey: 'facts',
    fileName: 'facts.json',
    sectionTitle: 'Facts',
  },
  {
    kind: 'decision',
    snapshotKey: 'decisions',
    fileName: 'decisions.json',
    sectionTitle: 'Decisions',
  },
  {
    kind: 'preference',
    snapshotKey: 'preferences',
    fileName: 'preferences.json',
    sectionTitle: 'Preferences',
  },
  {
    kind: 'workflow',
    snapshotKey: 'workflows',
    fileName: 'workflows.json',
    sectionTitle: 'Task Workflows',
  },
  {
    kind: 'troubleshooting-pattern',
    snapshotKey: 'troubleshootingPatterns',
    fileName: 'troubleshooting-patterns.json',
    sectionTitle: 'Troubleshooting Patterns',
    docFileName: 'troubleshooting.md',
    docTitle: 'Troubleshooting',
    docDescription: 'How the agent diagnosed and resolved recurring errors.',
  },
  {
    kind: 'user-assist-pattern',
    snapshotKey: 'userAssistPatterns',
    fileName: 'user-assist-patterns.json',
    sectionTitle: 'User Assist Patterns',
    docFileName: 'collaboration.md',
    docTitle: 'Collaboration',
    docDescription: 'How user guidance unblocked the agent or corrected bad assumptions.',
  },
  {
    kind: 'component-workflow',
    snapshotKey: 'componentWorkflows',
    fileName: 'component-workflows.json',
    sectionTitle: 'Component Workflows',
    docFileName: 'component-workflows.md',
    docTitle: 'Component Workflows',
    docDescription: 'Detailed runtime/control-flow behavior and cross-component interactions.',
  },
  {
    kind: 'project-convention',
    snapshotKey: 'projectConventions',
    fileName: 'project-conventions.json',
    sectionTitle: 'Project Conventions',
    docFileName: 'conventions.md',
    docTitle: 'Conventions',
    docDescription: 'Project-specific conventions, edit boundaries, and integration contracts.',
  },
  {
    kind: 'debug-approach',
    snapshotKey: 'debugApproaches',
    fileName: 'debug-approaches.json',
    sectionTitle: 'Debug Approaches',
    docFileName: 'debug-playbook.md',
    docTitle: 'Debug Playbook',
    docDescription: 'Effective debugging, validation, and diagnosis approaches for this repo.',
  },
  {
    kind: 'critical-file',
    snapshotKey: 'criticalFiles',
    fileName: 'critical-files.json',
    sectionTitle: 'Critical Files',
    docFileName: 'critical-files.md',
    docTitle: 'Critical Files',
    docDescription: 'Files and folders to read first, with why they matter and what they contain.',
  },
] as const
const PROJECT_MEMORY_CANDIDATE_KIND_SET = new Set(PROJECT_MEMORY_CANDIDATE_KINDS)
const PROJECT_MEMORY_SCOPE_SET = new Set(PROJECT_MEMORY_SCOPES)
const PROJECT_MEMORY_STATUS_SET = new Set(PROJECT_MEMORY_STATUSES)
const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'gu',
)
const WINDOWS_ABSOLUTE_PATH_REGEX = /\b[a-z]:[\\/][^\s]*/iu
const POSIX_ABSOLUTE_PATH_REGEX =
  /(?:^|[\s(])\/(?:users|home|tmp|var|private|mnt|opt|etc|bin|srv)[^\s)]*/iu
const WORKTREE_PATH_FRAGMENT_REGEX = /(?:\.codex|\.git)[\\/](?:worktrees|sessions)/iu
const BRANCH_OR_COMMIT_REGEXES = [
  /\b(?:branch|commit|revision|sha)\s*[:#]\s*[a-z0-9._/-]+\b/iu,
  /\b(?:checked[ -]?out|checkout(?:ed)?|switched to|currently on|active)\s+branch\b/iu,
  /\bcommit\s+[a-f0-9]{7,40}\b/iu,
]
const TRANSIENT_TASK_STATE_REGEXES = [
  /\bpr\s*#\d+\b/iu,
  /\bcommitted as\b/iu,
  /\bforce-push(?:ed)?\b/iu,
  /\bpushed on branch\b/iu,
  /\bcurrent checkout\b/iu,
  /\bthis checkout\b/iu,
  /\bopened as\b/iu,
  /\bpublished as\b/iu,
  /\bwas updated to\b/iu,
  /\bnow records\b/iu,
  /\bvalidation result\b/iu,
  /\bbuild\s+[a-z0-9_-]+\/\d+\b/iu,
  /\bjenkins[a-z0-9_-]*\/\d+\b/iu,
] as const
const INVISIBLE_MEMORY_UNICODE_REGEX = /[\u200B-\u200F\u202A-\u202E\uFEFF]/u
const MEMORY_CONTENT_BLOCKLIST = [
  {
    code: 'prompt-injection-ignore-previous',
    pattern:
      /\bignore\b[\s,:-]*(?:all\s+)?(?:previous|prior|earlier)\s+instructions\b/iu,
  },
  {
    code: 'prompt-injection-disregard-rules',
    pattern:
      /\bdisregard\b[\s,:-]*(?:all\s+)?(?:your\s+)?(?:rules|instructions)\b/iu,
  },
  {
    code: 'prompt-injection-role-takeover',
    pattern: /\byou are now\b/iu,
  },
  {
    code: 'secret-exfiltration-command',
    pattern: /\b(?:curl|wget)\b[^\n\r]*(?:\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%)/u,
  },
] as const
const DEFAULT_PROJECT_MEMORY_MAX_CANDIDATE_BYTES = 8 * 1024
const DEFAULT_PROJECT_MEMORY_STALE_AFTER_SESSIONS = 6

function createId(): string {
  return crypto.randomUUID()
}

function buildGenericSessionSummary(eventCount: number): string {
  return `This session recorded ${eventCount} transcript event${eventCount === 1 ? '' : 's'}.`
}

function isBestEffortExtractorFormatError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  return (
    error instanceof SyntaxError ||
    /returned invalid json/iu.test(error.message) ||
    /is not valid json/iu.test(error.message)
  )
}

function buildGenericHistoricalSessionsSummary(sessionCount: number): string {
  return `Analyzed ${sessionCount} stored session${sessionCount === 1 ? '' : 's'} for durable project memory.`
}

function scanMemoryContent(value: string): { code: string } | null {
  if (!value.trim()) {
    return null
  }

  if (INVISIBLE_MEMORY_UNICODE_REGEX.test(value)) {
    return { code: 'invisible-unicode' }
  }

  const normalized = normalizeWhitespace(stripAnsi(value))
  if (!normalized) {
    return null
  }

  for (const entry of MEMORY_CONTENT_BLOCKLIST) {
    if (entry.pattern.test(normalized)) {
      return { code: entry.code }
    }
  }

  return null
}

function sanitizeSummaryText(value: string, fallback: string): string {
  const normalized = normalizeWhitespace(stripAnsi(value))
  if (!normalized) {
    return fallback
  }

  return scanMemoryContent(normalized) ? fallback : normalized
}

export interface ProjectMemoryExtractionResult {
  summary: string
  candidates: Array<{
    kind: ProjectMemoryCandidateKind
    scope: ProjectMemoryScope
    key: string
    content: string
    confidence: number
    sourceEventIds: string[]
  }>
}

export interface ProjectMemoryDiagnosticEntry {
  timestamp: string
  level: 'warning' | 'error'
  code: string
  message: string
  projectId?: string
  sessionId?: string
}

export type ProjectMemoryDiagnosticReporter = (
  entry: ProjectMemoryDiagnosticEntry,
) => void

export interface ProjectMemoryExtractor {
  extract(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    session: SessionConfig
    transcript: TranscriptEvent[]
    normalizedTranscript: string
  }): Promise<ProjectMemoryExtractionResult>
}

export interface ProjectMemoryManagerOptions {
  maxCandidateBytes?: number
  staleAfterSessionCount?: number
}

interface StoredProjectRecord {
  id?: string
  title?: string
  createdAt?: string
  updatedAt?: string
  identity?: ProjectIdentity | null
}

interface NormalizedSummarySet {
  latest: SessionSummary | null
  removedCount: number
  summaries: SessionSummary[]
}

interface NormalizedCandidateSet {
  candidates: ProjectMemoryCandidate[]
  prunedCount: number
}

export interface ProjectMemoryRefreshResult {
  cleanedProjectCount: number
  removedEmptySummaryCount: number
  prunedCandidateCount: number
  regeneratedArchitectureCount: number
}

export interface ProjectArchitectureAnalysisResult {
  analyzedProjectCount: number
}

export interface HistoricalProjectSessionAnalysisInput {
  project: ProjectConfig
  sessions: HistoricalProjectSessionDescriptor[]
  transcriptBaseRoot: string
}

export interface ProjectSessionsAnalysisResult {
  analyzedProjectCount: number
  analyzedSessionCount: number
}

interface HistoricalSessionsAnalysisRecord {
  generatedAt: string
  analyzedSessionCount: number
  analyzedSessionIds: string[]
  summary: string
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'project'
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, '')
}

function normalizeWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, ' ').replace(/\r/g, '').trim()
}

function normalizeCandidateKey(value: string): string {
  return slugify(value).slice(0, 72) || 'memory-item'
}

function normalizeCandidateContent(value: string): string {
  return normalizeWhitespace(value)
}

function normalizeCandidateComparisonText(value: string): string {
  return normalizeCandidateContent(value)
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9/_<>:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeCandidateComparisonText(value: string): Set<string> {
  return new Set(
    normalizeCandidateComparisonText(value)
      .split(' ')
      .filter((token) => token.length >= 3),
  )
}

function isCandidateAnchorToken(token: string): boolean {
  return /[./_<>:-]/.test(token) || /\.(?:c|h|ts|tsx|js|jsx|json|md|arxml|bat|gpj|dpa)$/iu.test(token)
}

function areCandidateContentsNearDuplicate(left: string, right: string): boolean {
  const normalizedLeft = normalizeCandidateComparisonText(left)
  const normalizedRight = normalizeCandidateComparisonText(right)
  if (!normalizedLeft || !normalizedRight) {
    return false
  }

  if (normalizedLeft === normalizedRight) {
    return true
  }

  const shorter =
    normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight
  const longer =
    normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight
  if (shorter.length >= 48 && longer.includes(shorter)) {
    return true
  }

  const leftTokens = tokenizeCandidateComparisonText(normalizedLeft)
  const rightTokens = tokenizeCandidateComparisonText(normalizedRight)
  if (leftTokens.size < 4 || rightTokens.size < 4) {
    return false
  }

  let intersection = 0
  let hasAnchorOverlap = false
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1
      if (isCandidateAnchorToken(token)) {
        hasAnchorOverlap = true
      }
    }
  }

  const overlap = intersection / Math.max(leftTokens.size, rightTokens.size)
  return hasAnchorOverlap && overlap >= 0.82
}

function isLowSignalCandidate(value: string): boolean {
  const normalized = normalizeCandidateContent(value).toLowerCase()
  if (!normalized) {
    return true
  }

  return ['/', 'ok', 'yes', 'no', 'thanks'].includes(normalized)
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(1, Math.max(0, value))
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizeSourceEventIds(values: string[]): string[] {
  return uniqueStrings(
    values.map((value) => normalizeWhitespace(String(value))).filter(Boolean),
  ).slice(0, MAX_SOURCE_EVENT_IDS)
}

function createEmptySnapshot(
  summary: SessionSummary | null = null,
): ProjectMemorySnapshot {
  return {
    summary,
    facts: [],
    decisions: [],
    preferences: [],
    workflows: [],
    troubleshootingPatterns: [],
    userAssistPatterns: [],
    componentWorkflows: [],
    projectConventions: [],
    debugApproaches: [],
    criticalFiles: [],
  }
}

function buildDeterministicSummary(
  session: SessionConfig,
  transcript: TranscriptEvent[],
): string {
  const normalizedTitle = normalizeWhitespace(stripAnsi(session.title))
  const summarySubject =
    normalizedTitle && !containsAbsolutePath(normalizedTitle)
      ? `"${truncateUtf8(normalizedTitle, 120)}"`
      : 'this session'
  const latestUserInput = [...transcript]
    .reverse()
    .find((event) => event.kind === 'input' && event.source === 'user' && event.chunk)
    ?.chunk
  const normalizedInput = latestUserInput ? normalizeWhitespace(stripAnsi(latestUserInput)) : ''

  if (normalizedInput) {
    return `${summarySubject === 'this session' ? 'This session' : `Session ${summarySubject}`} focused on ${normalizedInput.slice(0, 180)}.`
  }

  return `${summarySubject === 'this session' ? 'This session' : `Session ${summarySubject}`} recorded ${transcript.length} transcript event${transcript.length === 1 ? '' : 's'}.`
}

function buildNormalizedTranscript(transcript: TranscriptEvent[]): string {
  const lines: string[] = []
  const repeatedLines = new Map<string, number>()

  for (const event of transcript) {
    if (!event.chunk) {
      continue
    }

    const normalizedChunk = normalizeWhitespace(stripAnsi(event.chunk))
    if (!normalizedChunk) {
      continue
    }

    const nextCount = (repeatedLines.get(normalizedChunk) ?? 0) + 1
    repeatedLines.set(normalizedChunk, nextCount)
    if (nextCount > 3) {
      continue
    }

    const prefix =
      event.kind === 'input'
        ? event.source === 'system'
          ? '[system-input]'
          : '[user-input]'
        : event.kind === 'output'
          ? '[output]'
          : `[${event.kind}]`
    lines.push(`${prefix} ${normalizedChunk}`)
  }

  return lines.join('\n')
}

function trimExcerpt(value: string | null, limit: number): string | null {
  const normalized = value ? normalizeWhitespace(value) : ''
  if (!normalized) {
    return null
  }

  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 3).trimEnd()}...`
}

function deriveProjectMemoryKey(project: ProjectConfig): string {
  const remoteFingerprint = project.identity?.remoteFingerprint?.trim()
  if (remoteFingerprint) {
    return `remote-${slugify(remoteFingerprint)}`
  }

  return `project-${project.id}`
}

function deriveProjectMemoryTitle(project: ProjectConfig): string {
  const remoteFingerprint = project.identity?.remoteFingerprint?.trim()
  if (!remoteFingerprint) {
    return project.title
  }

  const repoName = remoteFingerprint.split('/').filter(Boolean).at(-1)
  return repoName ? repoName.replace(/\.git$/i, '') : project.title
}

function buildLatestProjectsByMemoryKey(
  projects: ProjectConfig[],
): Map<string, ProjectConfig> {
  const projectByMemoryKey = new Map<string, ProjectConfig>()

  for (const project of projects) {
    const memoryKey = deriveProjectMemoryKey(project)
    const current = projectByMemoryKey.get(memoryKey)
    if (!current || project.updatedAt.localeCompare(current.updatedAt) > 0) {
      projectByMemoryKey.set(memoryKey, project)
    }
  }

  return projectByMemoryKey
}

function buildPortableProjectIdentity(project: ProjectConfig): ProjectIdentity {
  return {
    repoRoot: null,
    gitCommonDir: null,
    remoteFingerprint: project.identity?.remoteFingerprint ?? null,
  }
}

function normalizeStoredProjectIdentity(
  identity: ProjectIdentity | null | undefined,
): ProjectIdentity {
  return {
    repoRoot: null,
    gitCommonDir: null,
    remoteFingerprint:
      typeof identity?.remoteFingerprint === 'string' &&
      identity.remoteFingerprint.trim()
        ? identity.remoteFingerprint.trim()
        : null,
  }
}

function isValidCandidateKind(value: unknown): value is ProjectMemoryCandidateKind {
  return (
    typeof value === 'string' &&
    PROJECT_MEMORY_CANDIDATE_KIND_SET.has(value as ProjectMemoryCandidateKind)
  )
}

function isValidCandidateScope(value: unknown): value is ProjectMemoryScope {
  return (
    typeof value === 'string' &&
    PROJECT_MEMORY_SCOPE_SET.has(value as ProjectMemoryScope)
  )
}

function isValidCandidateStatus(value: unknown): value is ProjectMemoryStatus {
  return (
    typeof value === 'string' &&
    PROJECT_MEMORY_STATUS_SET.has(value as ProjectMemoryStatus)
  )
}

function containsAbsolutePath(value: string): boolean {
  return (
    WINDOWS_ABSOLUTE_PATH_REGEX.test(value) ||
    POSIX_ABSOLUTE_PATH_REGEX.test(value)
  )
}

function isEphemeralMemoryCandidate(
  key: string,
  content: string,
): boolean {
  const combinedText = `${key} ${content}`
  return (
    containsAbsolutePath(content) ||
    WORKTREE_PATH_FRAGMENT_REGEX.test(combinedText) ||
    BRANCH_OR_COMMIT_REGEXES.some((pattern) => pattern.test(combinedText)) ||
    TRANSIENT_TASK_STATE_REGEXES.some((pattern) => pattern.test(combinedText))
  )
}

function getLastReinforcedAt(
  candidate: Pick<ProjectMemoryCandidate, 'lastReinforcedAt' | 'updatedAt'>,
): string {
  return candidate.lastReinforcedAt?.trim() || candidate.updatedAt
}

function compareCandidatePriority(
  left: ProjectMemoryCandidate,
  right: ProjectMemoryCandidate,
): number {
  return (
    right.confidence - left.confidence ||
    getLastReinforcedAt(right).localeCompare(getLastReinforcedAt(left)) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.content.localeCompare(right.content)
  )
}

function compareSummaryPriority(left: SessionSummary, right: SessionSummary): number {
  return (
    right.generatedAt.localeCompare(left.generatedAt) ||
    right.sourceEventIds.length - left.sourceEventIds.length ||
    right.summary.length - left.summary.length ||
    left.sessionId.localeCompare(right.sessionId)
  )
}

function buildSummaryHistory(
  summaries: Array<SessionSummary | null | undefined>,
): SessionSummary[] {
  const bySessionId = new Map<string, SessionSummary>()

  for (const summary of summaries) {
    if (!summary) {
      continue
    }

    const existing = bySessionId.get(summary.sessionId)
    if (!existing || compareSummaryPriority(summary, existing) < 0) {
      bySessionId.set(summary.sessionId, summary)
    }
  }

  return Array.from(bySessionId.values()).sort((left, right) =>
    right.generatedAt.localeCompare(left.generatedAt),
  )
}

function normalizeArchitectureText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = normalizeWhitespace(stripAnsi(value))
  if (!normalized || scanMemoryContent(value)) {
    return null
  }

  return normalized
}

function normalizeArchitectureTextList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return []
  }

  return uniqueStrings(
    values.flatMap((value) => {
      const normalized = normalizeArchitectureText(value)
      return normalized ? [normalized] : []
    }),
  )
}

function normalizeArchitectureModule(
  value: ArchitectureModuleCard,
): ArchitectureModuleCard | null {
  const id = normalizeArchitectureText(value.id)
  const name = normalizeArchitectureText(value.name)
  const responsibility = normalizeArchitectureText(value.responsibility)
  if (!id || !name || !responsibility) {
    return null
  }

  return {
    ...value,
    id,
    name,
    paths: normalizeArchitectureTextList(value.paths),
    responsibility,
    owns: normalizeArchitectureTextList(value.owns),
    dependsOn: normalizeArchitectureTextList(value.dependsOn),
    usedBy: normalizeArchitectureTextList(value.usedBy),
    publicInterfaces: normalizeArchitectureTextList(value.publicInterfaces),
    keyTypes: normalizeArchitectureTextList(value.keyTypes),
    invariants: normalizeArchitectureTextList(value.invariants),
    changeGuidance: normalizeArchitectureTextList(value.changeGuidance),
    testLocations: normalizeArchitectureTextList(value.testLocations),
    confidence: clampConfidence(value.confidence),
  }
}

function normalizeArchitectureInteraction(
  value: ArchitectureInteraction,
): ArchitectureInteraction | null {
  const id = normalizeArchitectureText(value.id)
  const from = normalizeArchitectureText(value.from)
  const to = normalizeArchitectureText(value.to)
  const via = normalizeArchitectureText(value.via)
  const purpose = normalizeArchitectureText(value.purpose)
  const trigger = normalizeArchitectureText(value.trigger)
  if (!id || !from || !to || !via || !purpose || !trigger) {
    return null
  }

  return {
    ...value,
    id,
    from,
    to,
    via,
    purpose,
    trigger,
    failureModes: normalizeArchitectureTextList(value.failureModes),
    notes: normalizeArchitectureTextList(value.notes),
  }
}

function normalizeArchitectureInvariant(
  value: ArchitectureInvariant,
): ArchitectureInvariant | null {
  const id = normalizeArchitectureText(value.id)
  const statement = normalizeArchitectureText(value.statement)
  if (!id || !statement) {
    return null
  }

  return {
    ...value,
    id,
    statement,
    relatedModules: normalizeArchitectureTextList(value.relatedModules),
  }
}

function normalizeArchitectureGlossaryTerm(
  value: ArchitectureGlossaryTerm,
): ArchitectureGlossaryTerm | null {
  const term = normalizeArchitectureText(value.term)
  const meaning = normalizeArchitectureText(value.meaning)
  if (!term || !meaning) {
    return null
  }

  return {
    term,
    meaning,
  }
}

function normalizeArchitectureSnapshot(
  value: ProjectArchitectureSnapshot | null,
): ProjectArchitectureSnapshot | null {
  if (!value) {
    return null
  }

  const title = normalizeArchitectureText(value.title) ?? 'Project'
  const systemOverview = normalizeArchitectureText(value.systemOverview) ?? ''
  const modules = Array.isArray(value.modules)
    ? value.modules.flatMap((module) => {
        const normalized = normalizeArchitectureModule(module)
        return normalized ? [normalized] : []
      })
    : []
  const interactions = Array.isArray(value.interactions)
    ? value.interactions.flatMap((interaction) => {
        const normalized = normalizeArchitectureInteraction(interaction)
        return normalized ? [normalized] : []
      })
    : []
  const invariants = Array.isArray(value.invariants)
    ? value.invariants.flatMap((invariant) => {
        const normalized = normalizeArchitectureInvariant(invariant)
        return normalized ? [normalized] : []
      })
    : []
  const glossary = Array.isArray(value.glossary)
    ? value.glossary.flatMap((entry) => {
        const normalized = normalizeArchitectureGlossaryTerm(entry)
        return normalized ? [normalized] : []
      })
    : []

  return {
    ...value,
    title,
    systemOverview,
    modules,
    interactions,
    invariants,
    glossary,
  }
}

function normalizePersistedSummary(value: unknown): SessionSummary | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<SessionSummary>
  const rawSummary = typeof candidate.summary === 'string' ? candidate.summary : ''
  const sessionId =
    typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : ''
  const projectId =
    typeof candidate.projectId === 'string' ? candidate.projectId.trim() : ''
  const summary = normalizeWhitespace(stripAnsi(rawSummary))
  const sourceEventIds = normalizeSourceEventIds(
    Array.isArray(candidate.sourceEventIds)
      ? candidate.sourceEventIds.map((entry) => String(entry))
      : [],
  )

  if (
    !sessionId ||
    !projectId ||
    !summary ||
    sourceEventIds.length === 0 ||
    scanMemoryContent(rawSummary)
  ) {
    return null
  }

  return {
    sessionId,
    projectId,
    locationId:
      typeof candidate.locationId === 'string' && candidate.locationId.trim()
        ? candidate.locationId.trim()
        : null,
    generatedAt:
      typeof candidate.generatedAt === 'string' && candidate.generatedAt.trim()
        ? candidate.generatedAt.trim()
        : new Date().toISOString(),
    extractionVersion:
      typeof candidate.extractionVersion === 'number' &&
      Number.isInteger(candidate.extractionVersion) &&
      candidate.extractionVersion > 0
        ? candidate.extractionVersion
        : null,
    summary,
    sourceEventIds,
  }
}

function isCurrentExtractionSummary(summary: SessionSummary | null): boolean {
  return summary?.extractionVersion === PROJECT_MEMORY_EXTRACTION_VERSION
}

function normalizePersistedCandidate(
  value: unknown,
  fallbackProjectId: string,
  timestamp: string,
): ProjectMemoryCandidate | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ProjectMemoryCandidate>
  if (
    !isValidCandidateKind(candidate.kind) ||
    !isValidCandidateScope(candidate.scope)
  ) {
    return null
  }

  const rawContent = typeof candidate.content === 'string' ? candidate.content : ''
  const rawKey =
    typeof candidate.key === 'string' && candidate.key.trim()
      ? candidate.key
      : rawContent
  const content = normalizeCandidateContent(
    rawContent,
  )
  const key = normalizeCandidateKey(
    rawKey,
  )
  const confidence = clampConfidence(
    typeof candidate.confidence === 'number' ? candidate.confidence : 0,
  )

  if (
    !content ||
    !key ||
    confidence < 0.3 ||
    isLowSignalCandidate(content) ||
    isEphemeralMemoryCandidate(key, content) ||
    scanMemoryContent(rawKey) ||
    scanMemoryContent(rawContent)
  ) {
    return null
  }

  const locationId =
    candidate.scope === 'location'
      ? typeof candidate.locationId === 'string' && candidate.locationId.trim()
        ? candidate.locationId.trim()
        : null
      : null
  if (candidate.scope === 'location' && !locationId) {
    return null
  }

  const createdAt =
    typeof candidate.createdAt === 'string' && candidate.createdAt.trim()
      ? candidate.createdAt.trim()
      : timestamp

  return {
    id: typeof candidate.id === 'string' && candidate.id.trim()
      ? candidate.id.trim()
      : createId(),
    projectId:
      typeof candidate.projectId === 'string' && candidate.projectId.trim()
        ? candidate.projectId.trim()
        : fallbackProjectId,
    locationId,
    kind: candidate.kind,
    scope: candidate.scope,
    key,
    content,
    confidence,
    status: isValidCandidateStatus(candidate.status)
      ? candidate.status
      : 'active',
    createdAt,
    updatedAt:
      typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
        ? candidate.updatedAt.trim()
        : createdAt,
    lastReinforcedAt:
      typeof candidate.lastReinforcedAt === 'string' &&
      candidate.lastReinforcedAt.trim()
        ? candidate.lastReinforcedAt.trim()
        : (
            typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim()
              ? candidate.updatedAt.trim()
              : createdAt
          ),
    sourceSessionId:
      typeof candidate.sourceSessionId === 'string' &&
      candidate.sourceSessionId.trim()
        ? candidate.sourceSessionId.trim()
        : 'historical-import',
    sourceEventIds: normalizeSourceEventIds(
      Array.isArray(candidate.sourceEventIds)
        ? candidate.sourceEventIds.map((entry) => String(entry))
        : [],
    ),
  }
}

function normalizeCandidateSet(
  values: unknown,
  fallbackProjectId: string,
  timestamp: string,
): NormalizedCandidateSet {
  const exactMatches = new Map<string, ProjectMemoryCandidate>()
  let prunedCount = 0

  for (const value of Array.isArray(values) ? values : []) {
    const candidate = normalizePersistedCandidate(
      value,
      fallbackProjectId,
      timestamp,
    )
    if (!candidate) {
      prunedCount += 1
      continue
    }

    const exactKey = [
      candidate.kind,
      candidate.scope,
      candidate.locationId ?? '',
      candidate.key,
      candidate.content.toLowerCase(),
    ].join('::')
    const existing = exactMatches.get(exactKey)

    if (!existing) {
      exactMatches.set(exactKey, candidate)
      continue
    }

    existing.confidence = Math.max(existing.confidence, candidate.confidence)
    existing.sourceEventIds = normalizeSourceEventIds([
      ...existing.sourceEventIds,
      ...candidate.sourceEventIds,
    ])
    if (
      candidateStatusRetentionPriority(candidate.status) >
      candidateStatusRetentionPriority(existing.status)
    ) {
      existing.status = candidate.status
    }
    if (
      getLastReinforcedAt(candidate).localeCompare(getLastReinforcedAt(existing)) > 0
    ) {
      existing.lastReinforcedAt = getLastReinforcedAt(candidate)
    }
    if (candidate.createdAt.localeCompare(existing.createdAt) < 0) {
      existing.createdAt = candidate.createdAt
    }
    if (candidate.updatedAt.localeCompare(existing.updatedAt) > 0) {
      existing.updatedAt = candidate.updatedAt
    }
  }

  const groupedByKey = new Map<string, ProjectMemoryCandidate[]>()
  for (const candidate of exactMatches.values()) {
    const groupKey = [
      candidate.kind,
      candidate.scope,
      candidate.locationId ?? '',
      candidate.key,
    ].join('::')
    const group = groupedByKey.get(groupKey) ?? []
    group.push(candidate)
    groupedByKey.set(groupKey, group)
  }

  const candidates: ProjectMemoryCandidate[] = []
  for (const group of groupedByKey.values()) {
    group.sort(compareCandidatePriority)
    if (group.length > 1) {
      // Multi-entry key group: ensure exactly one entry is active.
      // Respect the persisted active marker from mergeCandidates when present,
      // so a low-confidence correction (0.4 active) isn't overridden by a
      // higher-confidence superseded entry (0.95 conflicted) on reload.
      const activeIndex = group.findIndex((c) => c.status === 'active')
      if (activeIndex >= 0) {
        group.forEach((candidate, index) => {
          candidate.status = index === activeIndex ? 'active' : 'conflicted'
          candidates.push(candidate)
        })
      } else {
        // No active entry survived persistence — re-elect the top-ranked.
        group.forEach((candidate, index) => {
          candidate.status = index === 0 ? 'active' : 'conflicted'
          candidates.push(candidate)
        })
      }
    } else {
      // Single-entry group: preserve existing status. An entry intentionally
      // conflicted by a near-duplicate in a different key group must stay conflicted.
      candidates.push(group[0])
    }
  }

  candidates.sort(compareCandidatePriority)

  return {
    candidates,
    prunedCount,
  }
}

function buildStableFacts(
  project: ProjectConfig,
  session: SessionConfig,
  sourceEventIds: string[],
  timestamp: string,
): ProjectMemoryCandidate[] {
  const facts: ProjectMemoryCandidate[] = []

  const pushFact = (key: string, content: string, confidence: number) => {
    const normalizedContent = normalizeCandidateContent(content)
    if (
      isLowSignalCandidate(normalizedContent) ||
      scanMemoryContent(key) ||
      scanMemoryContent(content)
    ) {
      return
    }

    facts.push({
      id: crypto.randomUUID(),
      projectId: project.id,
      locationId: null,
      kind: 'fact',
      scope: 'project',
      key: normalizeCandidateKey(key),
      content: normalizedContent,
      confidence: clampConfidence(confidence),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastReinforcedAt: timestamp,
      sourceSessionId: session.id,
      sourceEventIds,
    })
  }

  pushFact('default-agent-cli', `Default managed CLI: ${session.startupCommand}`, 0.9)
  pushFact('shell', `Preferred shell: ${path.basename(session.shell) || session.shell}`, 0.8)

  if (project.identity?.remoteFingerprint) {
    pushFact(
      'remote',
      `Canonical remote: ${project.identity.remoteFingerprint}`,
      0.95,
    )
  }

  return facts
}

function getActiveCandidates(
  items: ProjectMemoryCandidate[],
): ProjectMemoryCandidate[] {
  return items.filter((item) => item.status === 'active')
}

function humanizeCandidateKey(value: string): string {
  const normalized = value.replace(/[-_]+/g, ' ').trim()
  if (!normalized) {
    return 'Memory Item'
  }

  return normalized.replace(/\b\w/g, (match) => match.toUpperCase())
}

function buildFocusedMemoryMarkdown(input: {
  projectTitle: string
  title: string
  intro: string
  items: ProjectMemoryCandidate[]
}): string {
  const sections: string[] = [
    `# ${input.projectTitle} ${input.title}`,
    '',
    input.intro,
    '',
  ]
  const activeItems = selectDistinctCandidates(
    getActiveCandidates(input.items),
    getActiveCandidates(input.items).length,
  )

  if (activeItems.length === 0) {
    sections.push('No entries yet.', '')
    return `${sections.join('\n').trim()}\n`
  }

  for (const item of activeItems) {
    sections.push(`## ${humanizeCandidateKey(item.key)}`)
    if (item.scope === 'location') {
      sections.push('Checkout-specific guidance.', '')
    }
    sections.push(item.content, '')
  }

  return `${sections.join('\n').trim()}\n`
}

function normalizeHistoricalSessionsAnalysisRecord(
  value: unknown,
): HistoricalSessionsAnalysisRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<HistoricalSessionsAnalysisRecord>
  const rawSummary = typeof candidate.summary === 'string' ? candidate.summary : ''
  const summary =
    normalizeWhitespace(stripAnsi(rawSummary))
  const analyzedSessionIds = Array.isArray(candidate.analyzedSessionIds)
    ? candidate.analyzedSessionIds
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

  if (!summary || analyzedSessionIds.length === 0 || scanMemoryContent(rawSummary)) {
    return null
  }

  return {
    generatedAt:
      typeof candidate.generatedAt === 'string' && candidate.generatedAt.trim()
        ? candidate.generatedAt.trim()
        : new Date().toISOString(),
    analyzedSessionCount:
      typeof candidate.analyzedSessionCount === 'number' &&
      Number.isInteger(candidate.analyzedSessionCount) &&
      candidate.analyzedSessionCount > 0
        ? candidate.analyzedSessionCount
        : analyzedSessionIds.length,
    analyzedSessionIds: [...new Set(analyzedSessionIds)],
    summary,
  }
}

function buildHistoricalSessionsAnalysisMarkdown(input: {
  projectTitle: string
  analysis: HistoricalSessionsAnalysisRecord
}): string {
  const sections = [
    `# ${input.projectTitle} Sessions Analysis`,
    '',
    'Holistic synthesis from stored Agent CLIs sessions for this logical project.',
    '',
    `Analyzed ${input.analysis.analyzedSessionCount} session${input.analysis.analyzedSessionCount === 1 ? '' : 's'}.`,
    '',
    '## Summary',
    input.analysis.summary,
    '',
    '## Source Sessions',
    ...input.analysis.analyzedSessionIds.map((sessionId) => `- ${sessionId}`),
    '',
  ]

  return `${sections.join('\n').trim()}\n`
}

function selectDistinctCandidates(
  items: ProjectMemoryCandidate[],
  limit: number,
  existingContent: string[] = [],
): ProjectMemoryCandidate[] {
  const selected: ProjectMemoryCandidate[] = []
  const seenContents = [...existingContent]

  for (const item of items) {
    if (
      seenContents.some((content) =>
        areCandidateContentsNearDuplicate(content, item.content),
      )
    ) {
      continue
    }

    selected.push(item)
    seenContents.push(item.content)
    if (selected.length >= limit) {
      break
    }
  }

  return selected
}

function buildMemoryMarkdown(
  projectTitle: string,
  snapshot: ProjectMemorySnapshot,
  architectureSnapshot?: ProjectArchitectureSnapshot,
  sessionsAnalysis?: HistoricalSessionsAnalysisRecord | null,
): string {
  const sections: string[] = [
    `# ${projectTitle}`,
    '',
    '## Memory Map',
    'Start with the focused docs that match the task. Keep this file as a quick index, not the full playbook:',
  ]

  if (architectureSnapshot) {
    sections.push('- `architecture.md`: system decomposition, ownership boundaries, and interaction map')
  }

  for (const bucket of PROJECT_MEMORY_BUCKETS.filter((item) => item.docFileName)) {
    const items = getActiveCandidates(snapshot[bucket.snapshotKey])
    if (items.length === 0) {
      continue
    }

    sections.push(
      `- \`${bucket.docFileName}\`: ${bucket.docDescription ?? bucket.sectionTitle} (${items.length} item${items.length === 1 ? '' : 's'})`,
    )
  }

  if (sessionsAnalysis) {
    sections.push(
      '- `sessions-analysis.md`: holistic synthesis from stored Agent CLIs sessions for this logical project',
    )
  }

  sections.push(
    '- `summaries/latest.md`: latest session summary captured for this logical project',
    '',
    '## Latest Summary',
    snapshot.summary?.summary || 'No captured session summary yet.',
    '',
  )

  if (sessionsAnalysis) {
    sections.push(
      '## Historical Sessions Analysis',
      sessionsAnalysis.summary,
      '',
    )
  }

  const seenHighlights: string[] = []
  const addHighlightSection = (
    title: string,
    items: ProjectMemoryCandidate[],
    limit: number,
  ) => {
    sections.push(`## ${title}`)
    const selected = selectDistinctCandidates(getActiveCandidates(items), limit, seenHighlights)
    if (selected.length === 0) {
      sections.push('No entries yet.', '')
      return
    }

    for (const item of selected) {
      sections.push(`- ${item.content}`)
      seenHighlights.push(item.content)
    }
    sections.push('')
  }

  addHighlightSection('Decisions', snapshot.decisions, 3)
  addHighlightSection('Project Conventions', snapshot.projectConventions, 3)
  addHighlightSection('Critical Files', snapshot.criticalFiles, 3)
  addHighlightSection('Task Workflows', snapshot.workflows, 2)

  return `${sections.join('\n').trim()}\n`
}

function buildArchitectureMarkdown(
  snapshot: ProjectArchitectureSnapshot,
): string {
  if (isAutosarArchitectureSnapshot(snapshot)) {
    return buildAutosarArchitectureMarkdown(snapshot)
  }

  const moduleNameById = new Map(
    snapshot.modules.map((module) => [module.id, module.name]),
  )
  const startHereLines = snapshot.modules
    .flatMap((module) =>
      module.paths.slice(0, 1).map((repoPath) => `- ${repoPath}: ${module.responsibility}`),
    )
    .slice(0, 8)
  const sections: string[] = [
    `# ${snapshot.title} Architecture`,
    '',
    '## System Overview',
    snapshot.systemOverview || 'No architecture overview available yet.',
    '',
  ]

  sections.push('## Start Here')
  if (startHereLines.length === 0) {
    sections.push('No guided entry points recorded yet.', '')
  } else {
    sections.push(...startHereLines, '')
  }

  sections.push('## Modules')

  if (snapshot.modules.length === 0) {
    sections.push('No module cards available yet.', '')
  } else {
    for (const module of snapshot.modules) {
      sections.push(`### ${module.name}`)
      sections.push(`- Kind: ${module.kind}`)
      sections.push(
        `- Paths: ${module.paths.length > 0 ? module.paths.join(', ') : 'n/a'}`,
      )
      sections.push(`- Responsibility: ${module.responsibility}`)
      if (module.owns.length > 0) {
        sections.push(`- Owns: ${module.owns.join('; ')}`)
      }
      if (module.dependsOn.length > 0) {
        sections.push(
          `- Depends on: ${module.dependsOn
            .map((moduleId) => moduleNameById.get(moduleId) ?? moduleId)
            .join(', ')}`,
        )
      }
      if (module.usedBy.length > 0) {
        sections.push(
          `- Used by: ${module.usedBy
            .map((moduleId) => moduleNameById.get(moduleId) ?? moduleId)
            .join(', ')}`,
        )
      }
      if (module.publicInterfaces.length > 0) {
        sections.push(`- Public interfaces: ${module.publicInterfaces.join(', ')}`)
      }
      if (module.keyTypes.length > 0) {
        sections.push(`- Key types: ${module.keyTypes.join(', ')}`)
      }
      if (module.invariants.length > 0) {
        sections.push(`- Invariants: ${module.invariants.join('; ')}`)
      }
      if (module.changeGuidance.length > 0) {
        sections.push(`- Change guidance: ${module.changeGuidance.join('; ')}`)
      }
      if (module.testLocations.length > 0) {
        sections.push(`- Tests: ${module.testLocations.join(', ')}`)
      }
      sections.push('')
    }
  }

  sections.push('## Interactions')
  if (snapshot.interactions.length === 0) {
    sections.push('No interaction cards available yet.', '')
  } else {
    for (const interaction of snapshot.interactions) {
      const fromName = moduleNameById.get(interaction.from) ?? interaction.from
      const toName = moduleNameById.get(interaction.to) ?? interaction.to
      sections.push(
        `- ${fromName} -> ${toName} via ${interaction.via}: ${interaction.purpose}`,
      )
      sections.push(`  Trigger: ${interaction.trigger}`)
      if (interaction.failureModes.length > 0) {
        sections.push(`  Failure modes: ${interaction.failureModes.join('; ')}`)
      }
      if (interaction.notes.length > 0) {
        sections.push(`  Notes: ${interaction.notes.join('; ')}`)
      }
    }
    sections.push('')
  }

  sections.push('## Invariants')
  if (snapshot.invariants.length === 0) {
    sections.push('No cross-module invariants recorded yet.', '')
  } else {
    for (const invariant of snapshot.invariants) {
      sections.push(`- ${invariant.statement}`)
    }
    sections.push('')
  }

  sections.push('## Glossary')
  if (snapshot.glossary.length === 0) {
    sections.push('No glossary terms recorded yet.', '')
  } else {
    for (const entry of snapshot.glossary) {
      sections.push(`- ${entry.term}: ${entry.meaning}`)
    }
    sections.push('')
  }

  return `${sections.join('\n').trim()}\n`
}

function isAutosarArchitectureSnapshot(
  snapshot: ProjectArchitectureSnapshot,
): boolean {
  return snapshot.modules.some((module) => module.id.startsWith('autosar-'))
}

function appendModuleSummary(
  sections: string[],
  module: ArchitectureModuleCard | undefined,
  moduleNameById: Map<string, string>,
): void {
  if (!module) {
    sections.push('No module recorded yet.', '')
    return
  }

  sections.push(`### ${module.name}`)
  sections.push(`- Paths: ${module.paths.length > 0 ? module.paths.join(', ') : 'n/a'}`)
  sections.push(`- Responsibility: ${module.responsibility}`)
  if (module.owns.length > 0) {
    sections.push(`- Owns: ${module.owns.join('; ')}`)
  }
  if (module.dependsOn.length > 0) {
    sections.push(
      `- Depends on: ${module.dependsOn
        .map((moduleId) => moduleNameById.get(moduleId) ?? moduleId)
        .join(', ')}`,
    )
  }
  if (module.publicInterfaces.length > 0) {
    sections.push(`- Entry points: ${module.publicInterfaces.join(', ')}`)
  }
  if (module.keyTypes.length > 0) {
    sections.push(`- Key facts: ${module.keyTypes.join('; ')}`)
  }
  if (module.changeGuidance.length > 0) {
    sections.push(`- Change guidance: ${module.changeGuidance.join('; ')}`)
  }
  if (module.testLocations.length > 0) {
    sections.push(`- Tests: ${module.testLocations.join(', ')}`)
  }
  sections.push('')
}

function buildAutosarArchitectureMarkdown(
  snapshot: ProjectArchitectureSnapshot,
): string {
  const moduleNameById = new Map(
    snapshot.modules.map((module) => [module.id, module.name]),
  )
  const moduleById = new Map(
    snapshot.modules.map((module) => [module.id, module]),
  )
  const userModules = snapshot.modules.filter((module) =>
    [
      'autosar-user-source-root',
      'autosar-vmcu-framework',
      'autosar-diagnostics',
      'autosar-wake-management',
      'autosar-communication-hal',
      'autosar-flash-security',
    ].includes(module.id),
  )
  const boundaryModules = snapshot.modules.filter((module) =>
    ['autosar-generated-platform', 'autosar-tooling-and-third-party'].includes(
      module.id,
    ),
  )
  const sections: string[] = [
    `# ${snapshot.title} Architecture`,
    '',
    '## System Overview',
    snapshot.systemOverview || 'No architecture overview available yet.',
    '',
    '## Build System',
  ]

  appendModuleSummary(
    sections,
    moduleById.get('autosar-build-entrypoints'),
    moduleNameById,
  )

  sections.push('## Variant Map')
  appendModuleSummary(
    sections,
    moduleById.get('autosar-variant-layout'),
    moduleNameById,
  )

  sections.push('## User Code Modules')
  if (userModules.length === 0) {
    sections.push('No user-code modules recorded yet.', '')
  } else {
    for (const module of userModules) {
      appendModuleSummary(sections, module, moduleNameById)
    }
  }

  sections.push('## Vendor And Generated Boundaries')
  if (boundaryModules.length === 0) {
    sections.push('No generated or vendor-owned boundaries recorded yet.', '')
  } else {
    for (const module of boundaryModules) {
      appendModuleSummary(sections, module, moduleNameById)
    }
  }

  sections.push('## Interaction Flow')
  const interactions = selectRelevantInteractions(
    snapshot.interactions,
    snapshot.modules.map((module) => module.id),
  )
  if (interactions.length === 0) {
    sections.push('No interaction cards available yet.', '')
  } else {
    for (const interaction of interactions) {
      const fromName = moduleNameById.get(interaction.from) ?? interaction.from
      const toName = moduleNameById.get(interaction.to) ?? interaction.to
      sections.push(
        `- ${fromName} -> ${toName} via ${interaction.via}: ${interaction.purpose}`,
      )
      sections.push(`  Trigger: ${interaction.trigger}`)
      if (interaction.failureModes.length > 0) {
        sections.push(`  Failure modes: ${interaction.failureModes.join('; ')}`)
      }
      if (interaction.notes.length > 0) {
        sections.push(`  Notes: ${interaction.notes.join('; ')}`)
      }
    }
    sections.push('')
  }

  sections.push('## Edit Boundaries')
  const invariants = snapshot.invariants.filter((invariant) =>
    invariant.relatedModules.some((moduleId) => moduleNameById.has(moduleId)),
  )
  if (invariants.length === 0) {
    sections.push('No cross-module invariants recorded yet.', '')
  } else {
    for (const invariant of invariants) {
      sections.push(`- ${invariant.statement}`)
    }
    sections.push('')
  }

  sections.push('## Glossary')
  if (snapshot.glossary.length === 0) {
    sections.push('No glossary terms recorded yet.', '')
  } else {
    for (const entry of snapshot.glossary) {
      sections.push(`- ${entry.term}: ${entry.meaning}`)
    }
    sections.push('')
  }

  return `${sections.join('\n').trim()}\n`
}

function normalizeQueryTerms(query?: string): string[] {
  const normalizedQuery = normalizeWhitespace(query ?? '').toLowerCase()
  if (!normalizedQuery) {
    return []
  }

  return normalizedQuery.split(/\s+/).filter((term) => term.length >= 3)
}

function scoreArchitectureText(
  text: string,
  queryTerms: string[],
): number {
  const normalizedText = text.toLowerCase()
  return queryTerms.reduce(
    (score, term) => score + (normalizedText.includes(term) ? 1 : 0),
    0,
  )
}

function selectRelevantModules(
  modules: ArchitectureModuleCard[],
  query?: string,
): ArchitectureModuleCard[] {
  const queryTerms = normalizeQueryTerms(query)
  if (queryTerms.length === 0) {
    return modules
  }

  const scoredModules = modules
    .map((module) => ({
      module,
      score: scoreArchitectureText(
        [
          module.id,
          module.name,
          module.responsibility,
          ...module.paths,
          ...module.owns,
          ...module.publicInterfaces,
          ...module.keyTypes,
          ...module.changeGuidance,
        ].join(' '),
        queryTerms,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.module)

  return scoredModules.length > 0 ? scoredModules : modules
}

function selectRelevantInteractions(
  interactions: ArchitectureInteraction[],
  relevantModuleIds: string[],
  query?: string,
): ArchitectureInteraction[] {
  const queryTerms = normalizeQueryTerms(query)
  if (queryTerms.length > 0) {
    const scoredInteractions = interactions
      .map((interaction) => ({
        interaction,
        score: scoreArchitectureText(
          [
            interaction.id,
            interaction.from,
            interaction.to,
            interaction.via,
            interaction.purpose,
            interaction.trigger,
            ...interaction.failureModes,
            ...interaction.notes,
          ].join(' '),
          queryTerms,
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.interaction)

    if (scoredInteractions.length > 0) {
      return scoredInteractions
    }
  }

  if (relevantModuleIds.length === 0) {
    return interactions
  }

  return interactions.filter(
    (interaction) =>
      relevantModuleIds.includes(interaction.from) ||
      relevantModuleIds.includes(interaction.to),
  )
}

function recencyFactor(updatedAt: string, now: number): number {
  const elapsed = now - new Date(updatedAt).getTime()
  const daysSince = Math.max(0, elapsed / (1000 * 60 * 60 * 24))
  return Math.pow(0.98, daysSince)
}

function calculateCandidateRetentionScore(
  candidate: ProjectMemoryCandidate,
  now: number,
): number {
  const recency = recencyFactor(candidate.updatedAt, now)
  const reinforcementRecency = recencyFactor(getLastReinforcedAt(candidate), now)
  return candidate.confidence * (0.6 * recency + 0.4 * reinforcementRecency)
}

function candidateStatusRetentionPriority(status: ProjectMemoryStatus): number {
  switch (status) {
    case 'active':
      return 2
    case 'stale':
      return 1
    case 'conflicted':
      return 0
  }
}

function compareCandidateRelevance(
  left: ProjectMemoryCandidate,
  right: ProjectMemoryCandidate,
  now: number,
): number {
  return (
    candidateStatusRetentionPriority(right.status) -
      candidateStatusRetentionPriority(left.status) ||
    calculateCandidateRetentionScore(right, now) -
      calculateCandidateRetentionScore(left, now) ||
    getLastReinforcedAt(right).localeCompare(getLastReinforcedAt(left)) ||
    compareCandidatePriority(left, right)
  )
}

function compareCandidateRemovalPriority(
  left: ProjectMemoryCandidate,
  right: ProjectMemoryCandidate,
  now: number,
): number {
  return (
    candidateStatusRetentionPriority(left.status) -
      candidateStatusRetentionPriority(right.status) ||
    calculateCandidateRetentionScore(left, now) -
      calculateCandidateRetentionScore(right, now) ||
    getLastReinforcedAt(left).localeCompare(getLastReinforcedAt(right)) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.content.localeCompare(right.content)
  )
}

function estimateCandidateBytes(candidate: ProjectMemoryCandidate): number {
  return Buffer.byteLength(JSON.stringify(candidate), 'utf8')
}

function selectRelevantEntries(
  items: ProjectMemoryCandidate[],
  locationId: string | null,
  query?: string,
): ProjectMemoryCandidate[] {
  const now = Date.now()
  const activeItems = items.filter(
    (item) =>
      item.status === 'active' &&
      (
        item.scope === 'project' ||
        (locationId !== null && item.locationId === locationId)
      ),
  )
  const normalizedQuery = normalizeWhitespace(query ?? '').toLowerCase()
  if (!normalizedQuery) {
    return activeItems.slice().sort((left, right) =>
      compareCandidateRelevance(left, right, now),
    )
  }

  const queryTerms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 3)
  if (queryTerms.length === 0) {
    return activeItems.slice().sort((left, right) =>
      compareCandidateRelevance(left, right, now),
    )
  }

  const scoredItems = activeItems
    .map((item) => {
      const termHits = queryTerms.reduce((score, term) => {
        return item.content.toLowerCase().includes(term) || item.key.includes(term)
          ? score + 1
          : score
      }, 0)
      return {
        item,
        score: termHits * calculateCandidateRetentionScore(item, now),
        termHits,
      }
    })
    .filter((entry) => entry.termHits > 0)
    .sort((left, right) => right.score - left.score || compareCandidatePriority(left.item, right.item))
    .map((entry) => entry.item)

  return scoredItems.length > 0
    ? scoredItems
    : activeItems.slice().sort((left, right) => compareCandidateRelevance(left, right, now))
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeUtf8FileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

export class ProjectMemoryManager {
  private readonly getLibraryRoot: () => string
  private readonly extractor?: ProjectMemoryExtractor
  private readonly architectureExtractor?: ProjectArchitectureExtractor
  private readonly historicalSessionAnalyzer?: ProjectSessionHistoryAnalyzer
  private readonly maxCandidateBytes: number
  private readonly staleAfterSessionCount: number
  private diagnosticReporter?: ProjectMemoryDiagnosticReporter

  constructor(
    getLibraryRoot: () => string,
    extractor?: ProjectMemoryExtractor,
    architectureExtractor?: ProjectArchitectureExtractor,
    historicalSessionAnalyzer?: ProjectSessionHistoryAnalyzer,
    options: ProjectMemoryManagerOptions = {},
  ) {
    this.getLibraryRoot = getLibraryRoot
    this.extractor = extractor
    this.architectureExtractor = architectureExtractor
    this.historicalSessionAnalyzer = historicalSessionAnalyzer
    this.maxCandidateBytes =
      typeof options.maxCandidateBytes === 'number' && options.maxCandidateBytes > 0
        ? Math.floor(options.maxCandidateBytes)
        : DEFAULT_PROJECT_MEMORY_MAX_CANDIDATE_BYTES
    this.staleAfterSessionCount =
      typeof options.staleAfterSessionCount === 'number' &&
      options.staleAfterSessionCount > 0
        ? Math.floor(options.staleAfterSessionCount)
        : DEFAULT_PROJECT_MEMORY_STALE_AFTER_SESSIONS
  }

  setDiagnosticReporter(reporter: ProjectMemoryDiagnosticReporter): void {
    this.diagnosticReporter = reporter
  }

  isEnabled(): boolean {
    return Boolean(this.getLibraryRoot().trim())
  }

  private reportDiagnostic(
    entry: Omit<ProjectMemoryDiagnosticEntry, 'timestamp'>,
  ): void {
    this.diagnosticReporter?.({
      ...entry,
      timestamp: new Date().toISOString(),
    })
  }

  private getProjectDirectory(project: ProjectConfig): string | null {
    const libraryRoot = this.getLibraryRoot().trim()
    if (!libraryRoot) {
      return null
    }

    return path.join(
      libraryRoot,
      MEMORY_ROOT_DIRECTORY,
      'projects',
      deriveProjectMemoryKey(project),
    )
  }

  private getProjectsDirectory(): string | null {
    const libraryRoot = this.getLibraryRoot().trim()
    if (!libraryRoot) {
      return null
    }

    return path.join(libraryRoot, MEMORY_ROOT_DIRECTORY, 'projects')
  }

  private getSnapshotFilePath(
    project: ProjectConfig,
    fileName: string,
  ): string | null {
    const projectDirectory = this.getProjectDirectory(project)
    return projectDirectory ? path.join(projectDirectory, fileName) : null
  }

  private async readArchitectureSnapshot(
    project: ProjectConfig,
  ): Promise<ProjectArchitectureSnapshot | null> {
    const filePath = this.getSnapshotFilePath(project, 'architecture.json')
    return filePath
      ? normalizeArchitectureSnapshot(
          await readJsonFile<ProjectArchitectureSnapshot | null>(filePath, null),
        )
      : null
  }

  private async readHistoricalSessionsAnalysisFromDirectory(
    projectDirectory: string,
  ): Promise<HistoricalSessionsAnalysisRecord | null> {
    return normalizeHistoricalSessionsAnalysisRecord(
      await readJsonFile<HistoricalSessionsAnalysisRecord | null>(
        path.join(projectDirectory, HISTORICAL_SESSIONS_ANALYSIS_JSON),
        null,
      ),
    )
  }

  private async readSnapshotFromDirectory(
    projectDirectory: string,
  ): Promise<ProjectMemorySnapshot> {
    const [summary, ...candidateSets] = await Promise.all([
      readJsonFile<SessionSummary | null>(
        path.join(projectDirectory, 'summaries', 'latest.json'),
        null,
      ),
      ...PROJECT_MEMORY_BUCKETS.map((bucket) =>
        readJsonFile(
          path.join(projectDirectory, bucket.fileName),
          [] as ProjectMemoryCandidate[],
        ),
      ),
    ])

    const snapshot = createEmptySnapshot(normalizePersistedSummary(summary))
    PROJECT_MEMORY_BUCKETS.forEach((bucket, index) => {
      snapshot[bucket.snapshotKey] = candidateSets[index] ?? []
    })

    return snapshot
  }

  private async readSummaryHistoryFromDirectory(
    projectDirectory: string,
  ): Promise<SessionSummary[]> {
    const summariesDirectory = path.join(projectDirectory, 'summaries')
    let summaryFiles: string[] = []

    try {
      const entries = await readdir(summariesDirectory, { withFileTypes: true })
      summaryFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    } catch {
      return []
    }

    const summaries = await Promise.all(
      summaryFiles.map(async (fileName) =>
        normalizePersistedSummary(
          await readJsonFile<SessionSummary | null>(
            path.join(summariesDirectory, fileName),
            null,
          ),
        ),
      ),
    )

    return buildSummaryHistory(summaries)
  }

  private async listProjectDirectories(): Promise<string[]> {
    const projectsDirectory = this.getProjectsDirectory()
    if (!projectsDirectory) {
      return []
    }

    try {
      const entries = await readdir(projectsDirectory, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDirectory, entry.name))
        .sort((left, right) => left.localeCompare(right))
    } catch {
      return []
    }
  }

  private async writeCanonicalArtifacts(input: {
    projectDirectory: string
    projectId: string
    projectTitle: string
    createdAt: string
    updatedAt: string
    identity: ProjectIdentity
    snapshot: ProjectMemorySnapshot
    architectureSnapshot?: ProjectArchitectureSnapshot
    sessionsAnalysis?: HistoricalSessionsAnalysisRecord | null
  }): Promise<void> {
    const architectureSnapshot =
      normalizeArchitectureSnapshot(
        input.architectureSnapshot ??
          (await readJsonFile<ProjectArchitectureSnapshot | null>(
            path.join(input.projectDirectory, 'architecture.json'),
            null,
          )),
      )
    const sessionsAnalysis =
      typeof input.sessionsAnalysis === 'undefined'
        ? await this.readHistoricalSessionsAnalysisFromDirectory(
            input.projectDirectory,
          )
        : input.sessionsAnalysis

    await mkdir(path.join(input.projectDirectory, 'summaries'), { recursive: true })
    await writeJsonFile(path.join(input.projectDirectory, 'project.json'), {
      id: input.projectId,
      title: input.projectTitle,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      identity: input.identity,
    })

    for (const bucket of PROJECT_MEMORY_BUCKETS) {
      await writeJsonFile(
        path.join(input.projectDirectory, bucket.fileName),
        input.snapshot[bucket.snapshotKey],
      )
    }

    if (input.snapshot.summary) {
      await writeJsonFile(
        path.join(input.projectDirectory, 'summaries', 'latest.json'),
        input.snapshot.summary,
      )
      await writeUtf8FileAtomic(
        path.join(input.projectDirectory, 'summaries', 'latest.md'),
        `${input.snapshot.summary.summary}\n`,
      )
    } else {
      await rm(path.join(input.projectDirectory, 'summaries', 'latest.json'), {
        force: true,
      })
      await rm(path.join(input.projectDirectory, 'summaries', 'latest.md'), {
        force: true,
      })
    }

    if (architectureSnapshot) {
      await writeJsonFile(
        path.join(input.projectDirectory, 'architecture.json'),
        architectureSnapshot,
      )
      await writeUtf8FileAtomic(
        path.join(input.projectDirectory, 'architecture.md'),
        buildArchitectureMarkdown(architectureSnapshot),
      )
    }

    if (sessionsAnalysis) {
      await writeJsonFile(
        path.join(input.projectDirectory, HISTORICAL_SESSIONS_ANALYSIS_JSON),
        sessionsAnalysis,
      )
      await writeUtf8FileAtomic(
        path.join(input.projectDirectory, HISTORICAL_SESSIONS_ANALYSIS_MD),
        buildHistoricalSessionsAnalysisMarkdown({
          projectTitle: input.projectTitle,
          analysis: sessionsAnalysis,
        }),
      )
    } else {
      await rm(
        path.join(input.projectDirectory, HISTORICAL_SESSIONS_ANALYSIS_JSON),
        { force: true },
      )
      await rm(
        path.join(input.projectDirectory, HISTORICAL_SESSIONS_ANALYSIS_MD),
        { force: true },
      )
    }

    for (const bucket of PROJECT_MEMORY_BUCKETS.filter((item) => item.docFileName)) {
      await writeUtf8FileAtomic(
        path.join(input.projectDirectory, bucket.docFileName as string),
        buildFocusedMemoryMarkdown({
          projectTitle: input.projectTitle,
          title: bucket.docTitle ?? bucket.sectionTitle,
          intro:
            bucket.docDescription ??
            `${bucket.sectionTitle} captured for this logical project.`,
          items: input.snapshot[bucket.snapshotKey],
        }),
      )
    }

    await writeUtf8FileAtomic(
      path.join(input.projectDirectory, 'memory.md'),
      buildMemoryMarkdown(
        input.projectTitle,
        input.snapshot,
        architectureSnapshot ?? undefined,
        sessionsAnalysis,
      ),
    )
  }

  private async normalizeStoredSummaries(
    projectDirectory: string,
  ): Promise<NormalizedSummarySet> {
    const summariesDirectory = path.join(projectDirectory, 'summaries')
    let summaryFiles: string[] = []
    let removedCount = 0

    try {
      const entries = await readdir(summariesDirectory, { withFileTypes: true })
      summaryFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
    } catch {
      return {
        latest: null,
        removedCount: 0,
        summaries: [],
      }
    }

    const normalizedSummaries: SessionSummary[] = []
    for (const fileName of summaryFiles.filter((fileName) => fileName !== 'latest.json')) {
      const filePath = path.join(summariesDirectory, fileName)
      const normalizedSummary = normalizePersistedSummary(
        await readJsonFile<SessionSummary | null>(filePath, null),
      )

      if (!normalizedSummary) {
        removedCount += 1
        await rm(filePath, { force: true })
        continue
      }

      normalizedSummaries.push(normalizedSummary)
      await writeJsonFile(filePath, normalizedSummary)
    }

    let normalizedLatestSummary: SessionSummary | null = null
    if (summaryFiles.includes('latest.json')) {
      normalizedLatestSummary = normalizePersistedSummary(
        await readJsonFile<SessionSummary | null>(
          path.join(summariesDirectory, 'latest.json'),
          null,
        ),
      )
      if (!normalizedLatestSummary) {
        removedCount += 1
      }
    }

    const summaries = buildSummaryHistory([
      ...normalizedSummaries,
      normalizedLatestSummary,
    ])

    return {
      latest: summaries[0] ?? null,
      removedCount,
      summaries,
    }
  }

  private applyRetentionPolicies(
    snapshot: ProjectMemorySnapshot,
    summaryHistory: SessionSummary[],
  ): ProjectMemorySnapshot {
    const withStaleness = createEmptySnapshot(snapshot.summary)

    for (const bucket of PROJECT_MEMORY_BUCKETS) {
      withStaleness[bucket.snapshotKey] = snapshot[bucket.snapshotKey].map((candidate) => {
        const lastReinforcedAt = getLastReinforcedAt(candidate)
        const laterSummaryCount = summaryHistory.reduce((count, summary) => {
          return summary.generatedAt > lastReinforcedAt ? count + 1 : count
        }, 0)

        return {
          ...candidate,
          lastReinforcedAt,
          status:
            candidate.status === 'active' &&
            laterSummaryCount >= this.staleAfterSessionCount
              ? 'stale'
              : candidate.status,
        }
      })
    }

    const totalCandidateBytes = PROJECT_MEMORY_BUCKETS.reduce((total, bucket) => {
      return (
        total +
        withStaleness[bucket.snapshotKey].reduce(
          (bucketTotal, candidate) => bucketTotal + estimateCandidateBytes(candidate),
          0,
        )
      )
    }, 0)

    if (totalCandidateBytes <= this.maxCandidateBytes) {
      return withStaleness
    }

    const now = Date.now()
    const removalOrder = PROJECT_MEMORY_BUCKETS.flatMap((bucket) =>
      withStaleness[bucket.snapshotKey].map((candidate) => ({
        bucketKey: bucket.snapshotKey,
        candidate,
        bytes: estimateCandidateBytes(candidate),
      })),
    ).sort((left, right) =>
      compareCandidateRemovalPriority(left.candidate, right.candidate, now),
    )

    const prunedIds = new Set<string>()
    let remainingBytes = totalCandidateBytes
    for (const entry of removalOrder) {
      if (remainingBytes <= this.maxCandidateBytes) {
        break
      }

      prunedIds.add(entry.candidate.id)
      remainingBytes -= entry.bytes
    }

    const prunedSnapshot = createEmptySnapshot(withStaleness.summary)
    for (const bucket of PROJECT_MEMORY_BUCKETS) {
      prunedSnapshot[bucket.snapshotKey] = withStaleness[bucket.snapshotKey].filter(
        (candidate) => !prunedIds.has(candidate.id),
      )
    }

    return prunedSnapshot
  }

  private async indexArchitectureForProject(
    project: ProjectConfig,
    location: ProjectLocation | null,
    sessionId?: string,
  ): Promise<ProjectArchitectureSnapshot | null> {
    let heuristicSnapshot: ProjectArchitectureSnapshot | null = null

    try {
      heuristicSnapshot = await indexProjectArchitecture({
        projectId: deriveProjectMemoryKey(project),
        title: deriveProjectMemoryTitle(project),
        rootPath: location?.rootPath ?? project.rootPath,
      })
    } catch (error) {
      this.reportDiagnostic({
        level: 'warning',
        code: 'architecture-heuristic-index-failed',
        message:
          error instanceof Error
            ? error.message
            : 'Heuristic architecture indexing failed.',
        projectId: project.id,
        sessionId,
      })
    }

    if (!this.architectureExtractor) {
      return normalizeArchitectureSnapshot(heuristicSnapshot)
    }

    try {
      const synthesizedSnapshot = await this.architectureExtractor.extract({
        project,
        location,
        heuristicSnapshot,
      })
      return normalizeArchitectureSnapshot(synthesizedSnapshot ?? heuristicSnapshot)
    } catch (error) {
      this.reportDiagnostic({
        level: 'warning',
        code: 'architecture-agent-index-failed',
        message:
          error instanceof Error
            ? error.message
            : 'Primary-agent architecture synthesis failed.',
        projectId: project.id,
        sessionId,
      })
      return normalizeArchitectureSnapshot(heuristicSnapshot)
    }
  }

  async readSnapshot(project: ProjectConfig): Promise<ProjectMemorySnapshot> {
    const projectDirectory = this.getProjectDirectory(project)
    if (!projectDirectory) {
      return createEmptySnapshot()
    }

    const [rawSnapshot, summaryHistory] = await Promise.all([
      this.readSnapshotFromDirectory(projectDirectory),
      this.readSummaryHistoryFromDirectory(projectDirectory),
    ])
    const timestamp = new Date().toISOString()
    const normalizedSnapshot = createEmptySnapshot(rawSnapshot.summary)

    for (const bucket of PROJECT_MEMORY_BUCKETS) {
      normalizedSnapshot[bucket.snapshotKey] = normalizeCandidateSet(
        rawSnapshot[bucket.snapshotKey],
        project.id,
        timestamp,
      ).candidates
    }

    return this.applyRetentionPolicies(normalizedSnapshot, summaryHistory)
  }

  async hasSessionSummary(
    project: ProjectConfig,
    sessionId: string,
  ): Promise<boolean> {
    const filePath = this.getSnapshotFilePath(project, `summaries/${sessionId}.json`)
    if (!filePath) {
      return false
    }

    const summary = normalizePersistedSummary(
      await readJsonFile<SessionSummary | null>(filePath, null),
    )
    return isCurrentExtractionSummary(summary)
  }

  private validateCandidates(
    project: ProjectConfig,
    session: SessionConfig,
    locationId: string | null,
    timestamp: string,
    candidates: ProjectMemoryExtractionResult['candidates'],
  ): ProjectMemoryCandidate[] {
    const validated: ProjectMemoryCandidate[] = []

    for (const candidate of candidates) {
      const rawContent = typeof candidate.content === 'string' ? candidate.content : ''
      const rawKey =
        typeof candidate.key === 'string' && candidate.key.trim()
          ? candidate.key
          : rawContent
      const content = normalizeCandidateContent(rawContent)
      const key = normalizeCandidateKey(rawKey || content)
      const confidence = clampConfidence(candidate.confidence)
      const sourceEventIds = uniqueStrings(candidate.sourceEventIds)
      if (
        !content ||
        !key ||
        confidence < 0.3 ||
        isLowSignalCandidate(content) ||
        isEphemeralMemoryCandidate(key, content) ||
        scanMemoryContent(rawKey) ||
        scanMemoryContent(rawContent)
      ) {
        continue
      }

      validated.push({
        id: createId(),
        projectId: project.id,
        locationId: candidate.scope === 'location' ? locationId : null,
        kind: candidate.kind,
        scope: candidate.scope,
        key,
        content,
        confidence,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastReinforcedAt: timestamp,
        sourceSessionId: session.id,
        sourceEventIds,
      })
    }

    return validated
  }

  private mergeCandidates(
    existing: ProjectMemoryCandidate[],
    incoming: ProjectMemoryCandidate[],
  ): ProjectMemoryCandidate[] {
    const next = [...existing]

    for (const candidate of incoming) {
      const sameKeyEntries = next.filter(
        (entry) =>
          entry.kind === candidate.kind &&
          entry.scope === candidate.scope &&
          entry.locationId === candidate.locationId &&
          entry.key === candidate.key,
      )
      const identicalEntry = sameKeyEntries.find(
        (entry) => normalizeCandidateContent(entry.content) === normalizeCandidateContent(candidate.content),
      )

      if (identicalEntry) {
        identicalEntry.updatedAt = candidate.updatedAt
        identicalEntry.lastReinforcedAt = candidate.lastReinforcedAt
        identicalEntry.confidence = Math.max(identicalEntry.confidence, candidate.confidence)
        identicalEntry.sourceEventIds = uniqueStrings([
          ...identicalEntry.sourceEventIds,
          ...candidate.sourceEventIds,
        ])
        identicalEntry.status = 'active'
        continue
      }

      const conflictingEntries = next.filter(
        (entry) =>
          entry.kind === candidate.kind &&
          entry.scope === candidate.scope &&
          entry.locationId === candidate.locationId &&
          entry.status === 'active' &&
          (
            entry.key === candidate.key ||
            areCandidateContentsNearDuplicate(entry.content, candidate.content)
          ),
      )

      for (const entry of conflictingEntries) {
        entry.status = 'conflicted'
        entry.updatedAt = candidate.updatedAt
      }

      next.push(candidate)
    }

    return next
  }

  async captureSession(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    session: SessionConfig
    transcript: TranscriptEvent[]
  }): Promise<void> {
    const projectDirectory = this.getProjectDirectory(input.project)
    if (!projectDirectory) {
      return
    }

    const timestamp = new Date().toISOString()
    const normalizedTranscript = buildNormalizedTranscript(input.transcript)
    const memoryProjectTitle = deriveProjectMemoryTitle(input.project)
    const memoryProjectId = deriveProjectMemoryKey(input.project)
    let extractorResult: ProjectMemoryExtractionResult | null = null
    if (this.extractor) {
      try {
        extractorResult = await this.extractor.extract({
          project: input.project,
          location: input.location,
          session: input.session,
          transcript: input.transcript,
          normalizedTranscript,
        })
      } catch (error) {
        if (isBestEffortExtractorFormatError(error)) {
          extractorResult = {
            summary: '',
            candidates: [],
          }
        } else {
          this.reportDiagnostic({
            level: 'warning',
            code: 'extractor-failed',
            message:
              error instanceof Error
                ? error.message
                : 'Project memory extraction failed.',
            projectId: input.project.id,
            sessionId: input.session.id,
          })
        }
      }
    }

    const architectureSnapshot = await this.indexArchitectureForProject(
      input.project,
      input.location,
      input.session.id,
    )

    const sourceEventIds = normalizeSourceEventIds(
      input.transcript.map((event) => event.id),
    )
    const genericSummary = buildGenericSessionSummary(input.transcript.length)
    const summary: SessionSummary = {
      sessionId: input.session.id,
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: timestamp,
      extractionVersion: PROJECT_MEMORY_EXTRACTION_VERSION,
      summary: sanitizeSummaryText(
        trimExcerpt(extractorResult?.summary ?? null, 600) ??
          buildDeterministicSummary(input.session, input.transcript),
        genericSummary,
      ),
      sourceEventIds,
    }

    const [snapshot, summaryHistory] = await Promise.all([
      this.readSnapshot(input.project),
      this.readSummaryHistoryFromDirectory(projectDirectory),
    ])
    const stableFacts = buildStableFacts(
      input.project,
      input.session,
      sourceEventIds,
      timestamp,
    )
    const extractedCandidates = extractorResult
      ? this.validateCandidates(
          input.project,
          input.session,
          input.location?.id ?? null,
          timestamp,
          extractorResult.candidates,
        )
      : []
    const nextSnapshot = createEmptySnapshot(summary)
    for (const bucket of PROJECT_MEMORY_BUCKETS) {
      const incoming = extractedCandidates.filter(
        (candidate) => candidate.kind === bucket.kind,
      )
      const mergedIncoming =
        bucket.kind === 'fact' ? [...stableFacts, ...incoming] : incoming
      nextSnapshot[bucket.snapshotKey] = this.mergeCandidates(
        snapshot[bucket.snapshotKey],
        mergedIncoming,
      )
    }
    const retainedSnapshot = this.applyRetentionPolicies(
      nextSnapshot,
      buildSummaryHistory([...summaryHistory, summary]),
    )
    await writeJsonFile(
      path.join(projectDirectory, 'summaries', `${input.session.id}.json`),
      summary,
    )
    await this.writeCanonicalArtifacts({
      projectDirectory,
      projectId: memoryProjectId,
      projectTitle: memoryProjectTitle,
      createdAt: input.project.createdAt,
      updatedAt: timestamp,
      identity: buildPortableProjectIdentity(input.project),
      snapshot: retainedSnapshot,
      architectureSnapshot: architectureSnapshot ?? undefined,
    })
  }

  async refreshHistoricalImport(
    projects: ProjectConfig[],
    options: {
      regenerateArchitecture?: boolean
    } = {},
  ): Promise<ProjectMemoryRefreshResult> {
    const projectDirectories = await this.listProjectDirectories()
    if (projectDirectories.length === 0) {
      return {
        cleanedProjectCount: 0,
        removedEmptySummaryCount: 0,
        prunedCandidateCount: 0,
        regeneratedArchitectureCount: 0,
      }
    }

    const timestamp = new Date().toISOString()
    const projectByMemoryKey = buildLatestProjectsByMemoryKey(projects)
    const regenerateArchitecture = options.regenerateArchitecture ?? true

    const result: ProjectMemoryRefreshResult = {
      cleanedProjectCount: 0,
      removedEmptySummaryCount: 0,
      prunedCandidateCount: 0,
      regeneratedArchitectureCount: 0,
    }

    for (const projectDirectory of projectDirectories) {
      const memoryKey = path.basename(projectDirectory)
      const matchedProject = projectByMemoryKey.get(memoryKey) ?? null
      const storedProject = await readJsonFile<StoredProjectRecord | null>(
        path.join(projectDirectory, 'project.json'),
        null,
      )
      const projectId = matchedProject
        ? deriveProjectMemoryKey(matchedProject)
        : typeof storedProject?.id === 'string' && storedProject.id.trim()
          ? storedProject.id.trim()
          : memoryKey
      const projectTitle = matchedProject
        ? deriveProjectMemoryTitle(matchedProject)
        : typeof storedProject?.title === 'string' && storedProject.title.trim()
          ? storedProject.title.trim()
          : memoryKey
      const createdAt =
        typeof storedProject?.createdAt === 'string' && storedProject.createdAt.trim()
          ? storedProject.createdAt.trim()
          : matchedProject?.createdAt ?? timestamp

      const normalizedSummaries = await this.normalizeStoredSummaries(projectDirectory)
      result.removedEmptySummaryCount += normalizedSummaries.removedCount

      const fallbackProjectId = matchedProject?.id ?? projectId
      const normalizedBuckets = new Map<
        ProjectMemorySnapshotCandidateKey,
        NormalizedCandidateSet
      >()
      for (const bucket of PROJECT_MEMORY_BUCKETS) {
        const normalizedSet = normalizeCandidateSet(
          await readJsonFile(
            path.join(projectDirectory, bucket.fileName),
            [] as unknown[],
          ),
          fallbackProjectId,
          timestamp,
        )
        normalizedBuckets.set(bucket.snapshotKey, normalizedSet)
        result.prunedCandidateCount += normalizedSet.prunedCount
      }

      let architectureSnapshot: ProjectArchitectureSnapshot | undefined
      if (matchedProject && regenerateArchitecture) {
        const indexedArchitecture = await this.indexArchitectureForProject(
          matchedProject,
          null,
        )
        if (indexedArchitecture) {
          architectureSnapshot = indexedArchitecture
          result.regeneratedArchitectureCount += 1
        }
      }

      const normalizedSnapshot = PROJECT_MEMORY_BUCKETS.reduce((snapshot, bucket) => {
        snapshot[bucket.snapshotKey] =
          normalizedBuckets.get(bucket.snapshotKey)?.candidates ?? []
        return snapshot
      }, createEmptySnapshot(normalizedSummaries.latest))
      const retainedSnapshot = this.applyRetentionPolicies(
        normalizedSnapshot,
        normalizedSummaries.summaries,
      )

      await this.writeCanonicalArtifacts({
        projectDirectory,
        projectId,
        projectTitle,
        createdAt,
        updatedAt: timestamp,
        identity: matchedProject
          ? buildPortableProjectIdentity(matchedProject)
          : normalizeStoredProjectIdentity(storedProject?.identity),
        snapshot: retainedSnapshot,
        architectureSnapshot,
      })

      result.cleanedProjectCount += 1
    }

    return result
  }

  async analyzeHistoricalArchitecture(
    projects: ProjectConfig[],
  ): Promise<ProjectArchitectureAnalysisResult> {
    const projectByMemoryKey = buildLatestProjectsByMemoryKey(projects)
    if (projectByMemoryKey.size === 0) {
      return {
        analyzedProjectCount: 0,
      }
    }

    let analyzedProjectCount = 0

    for (const project of projectByMemoryKey.values()) {
      const projectDirectory = this.getProjectDirectory(project)
      if (!projectDirectory) {
        continue
      }

      const [snapshot, existingProjectRecord, architectureSnapshot] = await Promise.all([
        this.readSnapshot(project),
        readJsonFile<StoredProjectRecord | null>(
          path.join(projectDirectory, 'project.json'),
          null,
        ),
        this.indexArchitectureForProject(project, null),
      ])

      if (!architectureSnapshot) {
        continue
      }

      await this.writeCanonicalArtifacts({
        projectDirectory,
        projectId: deriveProjectMemoryKey(project),
        projectTitle: deriveProjectMemoryTitle(project),
        createdAt:
          existingProjectRecord?.createdAt?.trim() || project.createdAt,
        updatedAt: new Date().toISOString(),
        identity: buildPortableProjectIdentity(project),
        snapshot,
        architectureSnapshot,
      })
      analyzedProjectCount += 1
    }

    return {
      analyzedProjectCount,
    }
  }

  async analyzeHistoricalSessions(
    inputs: HistoricalProjectSessionAnalysisInput[],
  ): Promise<ProjectSessionsAnalysisResult> {
    if (!this.historicalSessionAnalyzer || inputs.length === 0) {
      return {
        analyzedProjectCount: 0,
        analyzedSessionCount: 0,
      }
    }

    const projectByMemoryKey = buildLatestProjectsByMemoryKey(
      inputs.map((input) => input.project),
    )
    const groupedInputs = new Map<
      string,
      {
        project: ProjectConfig
        transcriptBaseRoot: string
        sessions: HistoricalProjectSessionDescriptor[]
      }
    >()

    for (const input of inputs) {
      const memoryKey = deriveProjectMemoryKey(input.project)
      const canonicalProject = projectByMemoryKey.get(memoryKey)
      const currentGroup = groupedInputs.get(memoryKey)

      if (!currentGroup) {
        groupedInputs.set(memoryKey, {
          project: canonicalProject ?? input.project,
          transcriptBaseRoot: input.transcriptBaseRoot,
          sessions: [...input.sessions],
        })
        continue
      }

      currentGroup.sessions.push(...input.sessions)
    }

    let analyzedProjectCount = 0
    let analyzedSessionCount = 0

    for (const [memoryKey, groupedInput] of groupedInputs) {
      const projectDirectory = this.getProjectDirectory(groupedInput.project)
      if (!projectDirectory) {
        continue
      }

      const currentSessions = groupedInput.sessions
        .slice()
        .sort((left, right) =>
          right.session.updatedAt.localeCompare(left.session.updatedAt),
        )
      if (currentSessions.length === 0) {
        continue
      }

      const [snapshot, existingProjectRecord, analysis, summaryHistory] = await Promise.all([
        this.readSnapshot(groupedInput.project),
        readJsonFile<StoredProjectRecord | null>(
          path.join(projectDirectory, 'project.json'),
          null,
        ),
        this.historicalSessionAnalyzer.analyze({
          project: groupedInput.project,
          canonicalMemoryDirectory: projectDirectory,
          transcriptBaseRoot: groupedInput.transcriptBaseRoot,
          sessions: currentSessions,
        }),
        this.readSummaryHistoryFromDirectory(projectDirectory),
      ])

      const timestamp = new Date().toISOString()
      const syntheticSession: SessionConfig = {
        id: `historical-session-analysis:${memoryKey}`,
        projectId: groupedInput.project.id,
        locationId: undefined,
        title: 'Historical Agent CLIs sessions analysis',
        startupCommand: 'codex',
        pendingFirstPromptTitle: false,
        cwd: groupedInput.project.rootPath,
        shell: 'analysis',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const extractedCandidates = this.validateCandidates(
        groupedInput.project,
        syntheticSession,
        null,
        timestamp,
        analysis.candidates,
      )
      const nextSnapshot = createEmptySnapshot(snapshot.summary)
      for (const bucket of PROJECT_MEMORY_BUCKETS) {
        const incoming = extractedCandidates.filter(
          (candidate) => candidate.kind === bucket.kind,
        )
        nextSnapshot[bucket.snapshotKey] = this.mergeCandidates(
          snapshot[bucket.snapshotKey],
          incoming,
        )
      }
      const retainedSnapshot = this.applyRetentionPolicies(nextSnapshot, summaryHistory)

      await this.writeCanonicalArtifacts({
        projectDirectory,
        projectId: memoryKey,
        projectTitle: deriveProjectMemoryTitle(groupedInput.project),
        createdAt:
          existingProjectRecord?.createdAt?.trim() || groupedInput.project.createdAt,
        updatedAt: timestamp,
        identity: buildPortableProjectIdentity(groupedInput.project),
        snapshot: retainedSnapshot,
        sessionsAnalysis: {
          generatedAt: timestamp,
          analyzedSessionCount: currentSessions.length,
          analyzedSessionIds: currentSessions.map((entry) => entry.session.id),
          summary: sanitizeSummaryText(
            trimExcerpt(analysis.summary, 1_200) ??
              buildGenericHistoricalSessionsSummary(currentSessions.length),
            buildGenericHistoricalSessionsSummary(currentSessions.length),
          ),
        },
      })

      analyzedProjectCount += 1
      analyzedSessionCount += currentSessions.length
    }

    return {
      analyzedProjectCount,
      analyzedSessionCount,
    }
  }

  async prepareArchitectureAnalysis(
    projects: ProjectConfig[],
  ): Promise<{
    project: ProjectConfig
    prepared: PreparedStructuredAgent
  }[]> {
    if (!this.architectureExtractor?.prepare) {
      return []
    }

    const projectByMemoryKey = buildLatestProjectsByMemoryKey(projects)
    const results: {
      project: ProjectConfig
      prepared: PreparedStructuredAgent
    }[] = []

    for (const project of projectByMemoryKey.values()) {
      const prepared = await this.architectureExtractor.prepare({
        project,
        location: null,
        heuristicSnapshot: null,
      })
      results.push({ project, prepared })
    }

    return results
  }

  async finalizeArchitectureAnalysis(
    project: ProjectConfig,
    rawOutput: string,
  ): Promise<ProjectArchitectureAnalysisResult> {
    const projectDirectory = this.getProjectDirectory(project)
    if (!projectDirectory) {
      return { analyzedProjectCount: 0 }
    }

    const architectureSnapshot = finalizeArchitectureExtraction(rawOutput, project)
    if (!architectureSnapshot) {
      return { analyzedProjectCount: 0 }
    }

    const [snapshot, existingProjectRecord] = await Promise.all([
      this.readSnapshot(project),
      readJsonFile<StoredProjectRecord | null>(
        path.join(projectDirectory, 'project.json'),
        null,
      ),
    ])

    await this.writeCanonicalArtifacts({
      projectDirectory,
      projectId: deriveProjectMemoryKey(project),
      projectTitle: deriveProjectMemoryTitle(project),
      createdAt:
        existingProjectRecord?.createdAt?.trim() || project.createdAt,
      updatedAt: new Date().toISOString(),
      identity: buildPortableProjectIdentity(project),
      snapshot,
      architectureSnapshot,
    })

    return { analyzedProjectCount: 1 }
  }

  async prepareSessionsAnalysis(
    inputs: HistoricalProjectSessionAnalysisInput[],
  ): Promise<{
    project: ProjectConfig
    transcriptBaseRoot: string
    sessions: HistoricalProjectSessionDescriptor[]
    prepared: PreparedStructuredAgent
  }[]> {
    if (!this.historicalSessionAnalyzer?.prepare || inputs.length === 0) {
      return []
    }

    const projectByMemoryKey = buildLatestProjectsByMemoryKey(
      inputs.map((input) => input.project),
    )
    const groupedInputs = new Map<
      string,
      {
        project: ProjectConfig
        transcriptBaseRoot: string
        sessions: HistoricalProjectSessionDescriptor[]
      }
    >()

    for (const input of inputs) {
      const memoryKey = deriveProjectMemoryKey(input.project)
      const canonicalProject = projectByMemoryKey.get(memoryKey)
      const currentGroup = groupedInputs.get(memoryKey)

      if (!currentGroup) {
        groupedInputs.set(memoryKey, {
          project: canonicalProject ?? input.project,
          transcriptBaseRoot: input.transcriptBaseRoot,
          sessions: [...input.sessions],
        })
        continue
      }

      currentGroup.sessions.push(...input.sessions)
    }

    const results: {
      project: ProjectConfig
      transcriptBaseRoot: string
      sessions: HistoricalProjectSessionDescriptor[]
      prepared: PreparedStructuredAgent
    }[] = []

    for (const group of groupedInputs.values()) {
      if (group.sessions.length === 0) {
        continue
      }

      const projectDirectory = this.getProjectDirectory(group.project)
      if (!projectDirectory) {
        continue
      }

      const prepared = await this.historicalSessionAnalyzer.prepare({
        project: group.project,
        canonicalMemoryDirectory: projectDirectory,
        transcriptBaseRoot: group.transcriptBaseRoot,
        sessions: group.sessions.slice().sort((left, right) =>
          right.session.updatedAt.localeCompare(left.session.updatedAt),
        ),
      })

      results.push({
        project: group.project,
        transcriptBaseRoot: group.transcriptBaseRoot,
        sessions: group.sessions,
        prepared,
      })
    }

    return results
  }

  async finalizeSessionsAnalysis(
    project: ProjectConfig,
    sessions: HistoricalProjectSessionDescriptor[],
    rawOutput: string,
  ): Promise<ProjectSessionsAnalysisResult> {
    const projectDirectory = this.getProjectDirectory(project)
    if (!projectDirectory) {
      return { analyzedProjectCount: 0, analyzedSessionCount: 0 }
    }

    const memoryKey = deriveProjectMemoryKey(project)
    const analysis = parseProjectMemoryResponse(rawOutput)
    const timestamp = new Date().toISOString()
    const syntheticSession: SessionConfig = {
      id: `historical-session-analysis:${memoryKey}`,
      projectId: project.id,
      locationId: undefined,
      title: 'Historical Agent CLIs sessions analysis',
      startupCommand: 'codex',
      pendingFirstPromptTitle: false,
      cwd: project.rootPath,
      shell: 'analysis',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    const extractedCandidates = this.validateCandidates(
      project,
      syntheticSession,
      null,
      timestamp,
      analysis.candidates,
    )

    const [snapshot, existingProjectRecord, summaryHistory] = await Promise.all([
      this.readSnapshot(project),
      readJsonFile<StoredProjectRecord | null>(
        path.join(projectDirectory, 'project.json'),
        null,
      ),
      this.readSummaryHistoryFromDirectory(projectDirectory),
    ])

    const nextSnapshot = createEmptySnapshot(snapshot.summary)
    for (const bucket of PROJECT_MEMORY_BUCKETS) {
      const incoming = extractedCandidates.filter(
        (candidate) => candidate.kind === bucket.kind,
      )
      nextSnapshot[bucket.snapshotKey] = this.mergeCandidates(
        snapshot[bucket.snapshotKey],
        incoming,
      )
    }
    const retainedSnapshot = this.applyRetentionPolicies(nextSnapshot, summaryHistory)

    await this.writeCanonicalArtifacts({
      projectDirectory,
      projectId: memoryKey,
      projectTitle: deriveProjectMemoryTitle(project),
      createdAt:
        existingProjectRecord?.createdAt?.trim() || project.createdAt,
      updatedAt: timestamp,
      identity: buildPortableProjectIdentity(project),
      snapshot: retainedSnapshot,
      sessionsAnalysis: {
        generatedAt: timestamp,
        analyzedSessionCount: sessions.length,
        analyzedSessionIds: sessions.map((entry) => entry.session.id),
        summary: sanitizeSummaryText(
          trimExcerpt(analysis.summary, 1_200) ??
            buildGenericHistoricalSessionsSummary(sessions.length),
          buildGenericHistoricalSessionsSummary(sessions.length),
        ),
      },
    })

    return {
      analyzedProjectCount: 1,
      analyzedSessionCount: sessions.length,
    }
  }

  async assembleContext(input: {
    project: ProjectConfig
    location: ProjectLocation | null
    query?: string
  }): Promise<AssembledProjectContext> {
    const projectDirectory = this.getProjectDirectory(input.project)
    if (!projectDirectory) {
      return {
        projectId: input.project.id,
        locationId: input.location?.id ?? null,
        generatedAt: new Date().toISOString(),
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
      }
    }

    const [snapshot, architectureSnapshot, sessionsAnalysis] = await Promise.all([
      this.readSnapshot(input.project),
      this.readArchitectureSnapshot(input.project),
      this.readHistoricalSessionsAnalysisFromDirectory(projectDirectory),
    ])
    const hasMaterial =
      Boolean(snapshot.summary?.summary) ||
      PROJECT_MEMORY_BUCKETS.some(
        (bucket) => snapshot[bucket.snapshotKey].length > 0,
      ) ||
      Boolean(architectureSnapshot?.systemOverview) ||
      (architectureSnapshot?.modules.length ?? 0) > 0 ||
      Boolean(sessionsAnalysis?.summary)
    if (!hasMaterial) {
      return {
        projectId: input.project.id,
        locationId: input.location?.id ?? null,
        generatedAt: new Date().toISOString(),
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
        architectureExcerpt: null,
      }
    }

    const locationId = input.location?.id ?? null
    const hasQuery = Boolean(input.query?.trim())
    const slotLimits = hasQuery
      ? { facts: 6, decisions: 4, preferences: 4, workflows: 4,
          troubleshooting: 4, userAssist: 3, componentWorkflows: 4,
          conventions: 4, debug: 4, criticalFiles: 5, modules: 3, interactions: 2 }
      : { facts: 6, decisions: 4, preferences: 4, workflows: 2,
          troubleshooting: 2, userAssist: 1, componentWorkflows: 2,
          conventions: 4, debug: 2, criticalFiles: 5, modules: 3, interactions: 2 }
    const relevantFacts = selectRelevantEntries(
      snapshot.facts,
      locationId,
      input.query,
    ).slice(0, slotLimits.facts)
    const relevantDecisions = selectRelevantEntries(
      snapshot.decisions,
      locationId,
      input.query,
    ).slice(0, slotLimits.decisions)
    const relevantPreferences = selectRelevantEntries(
      snapshot.preferences,
      locationId,
      input.query,
    ).slice(0, slotLimits.preferences)
    const relevantWorkflows = selectRelevantEntries(
      snapshot.workflows,
      locationId,
      input.query,
    ).slice(0, slotLimits.workflows)
    const relevantTroubleshooting = selectRelevantEntries(
      snapshot.troubleshootingPatterns,
      locationId,
      input.query,
    ).slice(0, slotLimits.troubleshooting)
    const relevantUserAssistPatterns = selectRelevantEntries(
      snapshot.userAssistPatterns,
      locationId,
      input.query,
    ).slice(0, slotLimits.userAssist)
    const relevantComponentWorkflows = selectRelevantEntries(
      snapshot.componentWorkflows,
      locationId,
      input.query,
    ).slice(0, slotLimits.componentWorkflows)
    const relevantProjectConventions = selectRelevantEntries(
      snapshot.projectConventions,
      locationId,
      input.query,
    ).slice(0, slotLimits.conventions)
    const relevantDebugApproaches = selectRelevantEntries(
      snapshot.debugApproaches,
      locationId,
      input.query,
    ).slice(0, slotLimits.debug)
    const relevantCriticalFiles = selectRelevantEntries(
      snapshot.criticalFiles,
      locationId,
      input.query,
    ).slice(0, slotLimits.criticalFiles)
    const relevantModules = architectureSnapshot
      ? selectRelevantModules(architectureSnapshot.modules, input.query).slice(0, slotLimits.modules)
      : []
    const relevantInteractions = architectureSnapshot
      ? selectRelevantInteractions(
          architectureSnapshot.interactions,
          relevantModules.map((module) => module.id),
          input.query,
        ).slice(0, slotLimits.interactions)
      : []
    const architectureExcerpt = trimExcerpt(
      architectureSnapshot?.systemOverview ?? null,
      260,
    )
    const sessionsAnalysisExcerpt = trimExcerpt(sessionsAnalysis?.summary ?? null, 260)
    const fileReferences = [
      path.join(projectDirectory, 'memory.md'),
      path.join(projectDirectory, 'summaries', 'latest.md'),
      ...(sessionsAnalysis
        ? [path.join(projectDirectory, HISTORICAL_SESSIONS_ANALYSIS_MD)]
        : []),
      ...(architectureSnapshot
        ? [
            path.join(projectDirectory, 'architecture.md'),
            path.join(projectDirectory, 'architecture.json'),
          ]
        : []),
      ...PROJECT_MEMORY_BUCKETS.flatMap((bucket) => {
        if (!bucket.docFileName || getActiveCandidates(snapshot[bucket.snapshotKey]).length === 0) {
          return []
        }

        return [path.join(projectDirectory, bucket.docFileName)]
      }),
    ]
    const summaryExcerpt = trimExcerpt(snapshot.summary?.summary ?? null, 240)
    const formatPreview = (
      items: ProjectMemoryCandidate[],
      limit = 2,
    ): string =>
      items
        .slice(0, limit)
        .map((entry) => `- ${entry.content}`)
        .join('\n')
    const projectFactPreview = relevantFacts
      .slice(0, 3)
      .map((entry) => `- ${entry.content}`)
      .join('\n')
    const decisionPreview = formatPreview(relevantDecisions)
    const preferencePreview = formatPreview(relevantPreferences)
    const workflowPreview = formatPreview(relevantWorkflows)
    const troubleshootingPreview = formatPreview(relevantTroubleshooting)
    const userAssistPreview = formatPreview(relevantUserAssistPatterns)
    const componentWorkflowPreview = formatPreview(relevantComponentWorkflows)
    const conventionPreview = formatPreview(relevantProjectConventions)
    const debugPreview = formatPreview(relevantDebugApproaches)
    const criticalFilePreview = formatPreview(relevantCriticalFiles, 3)
    const modulePreview = relevantModules
      .map((module) => {
        const pathLabel = module.paths[0] ? ` [${module.paths[0]}]` : ''
        return `- ${module.name}${pathLabel}: ${module.responsibility}`
      })
      .join('\n')
    const moduleNameById = new Map(
      architectureSnapshot?.modules.map((module) => [module.id, module.name]) ?? [],
    )
    const interactionPreview = relevantInteractions
      .map((interaction) => {
        const fromName = moduleNameById.get(interaction.from) ?? interaction.from
        const toName = moduleNameById.get(interaction.to) ?? interaction.to
        return `- ${fromName} -> ${toName} via ${interaction.via}: ${interaction.purpose}`
      })
      .join('\n')
    const locationLine = input.location
      ? `Current local checkout: ${input.location.label}`
      : null
    const bootstrapParts = [
      'Use the project memory for this logical project before proceeding.',
      'Read:',
      ...fileReferences.map((filePath) => `- ${filePath}`),
      locationLine,
      summaryExcerpt ? `Latest summary: ${summaryExcerpt}` : null,
      sessionsAnalysisExcerpt
        ? `Historical sessions analysis: ${sessionsAnalysisExcerpt}`
        : null,
      architectureExcerpt ? `Architecture overview: ${architectureExcerpt}` : null,
      conventionPreview ? `Project conventions:\n${conventionPreview}` : null,
      componentWorkflowPreview
        ? `Component workflows:\n${componentWorkflowPreview}`
        : null,
      troubleshootingPreview
        ? `Troubleshooting patterns:\n${troubleshootingPreview}`
        : null,
      debugPreview ? `Debug playbook:\n${debugPreview}` : null,
      criticalFilePreview ? `Critical files:\n${criticalFilePreview}` : null,
      userAssistPreview ? `User assist patterns:\n${userAssistPreview}` : null,
      projectFactPreview ? `Relevant facts:\n${projectFactPreview}` : null,
      decisionPreview ? `Active decisions:\n${decisionPreview}` : null,
      preferencePreview ? `Project preferences:\n${preferencePreview}` : null,
      workflowPreview ? `Useful workflows:\n${workflowPreview}` : null,
      modulePreview ? `Relevant modules:\n${modulePreview}` : null,
      interactionPreview ? `Key interactions:\n${interactionPreview}` : null,
      'Treat decisions and preferences as defaults unless the user overrides them.',
    ].filter(Boolean)

    return {
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: new Date().toISOString(),
      bootstrapMessage: bootstrapParts.join('\n'),
      fileReferences,
      summaryExcerpt,
      architectureExcerpt,
    }
  }
}
