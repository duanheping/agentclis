import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import {
  PROJECT_MEMORY_CANDIDATE_KINDS,
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
  ArchitectureModuleCard,
  ProjectArchitectureSnapshot,
} from '../src/shared/projectArchitecture'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import { indexProjectArchitecture } from './projectArchitectureIndexer'

const MEMORY_ROOT_DIRECTORY = '.agenclis-memory'
const MAX_SOURCE_EVENT_IDS = 32
const PROJECT_MEMORY_CANDIDATE_FILES = [
  'facts.json',
  'decisions.json',
  'preferences.json',
  'workflows.json',
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

function createId(): string {
  return crypto.randomUUID()
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

function buildDeterministicSummary(
  session: SessionConfig,
  transcript: TranscriptEvent[],
): string {
  const latestUserInput = [...transcript]
    .reverse()
    .find((event) => event.kind === 'input' && event.source === 'user' && event.chunk)
    ?.chunk
  const normalizedInput = latestUserInput ? normalizeWhitespace(stripAnsi(latestUserInput)) : ''

  if (normalizedInput) {
    return `Session "${session.title}" focused on ${normalizedInput.slice(0, 180)}.`
  }

  return `Session "${session.title}" recorded ${transcript.length} transcript event${transcript.length === 1 ? '' : 's'}.`
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
    BRANCH_OR_COMMIT_REGEXES.some((pattern) => pattern.test(combinedText))
  )
}

function compareCandidatePriority(
  left: ProjectMemoryCandidate,
  right: ProjectMemoryCandidate,
): number {
  return (
    right.confidence - left.confidence ||
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

function normalizePersistedSummary(value: unknown): SessionSummary | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<SessionSummary>
  const sessionId =
    typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : ''
  const projectId =
    typeof candidate.projectId === 'string' ? candidate.projectId.trim() : ''
  const summary =
    typeof candidate.summary === 'string'
      ? normalizeWhitespace(candidate.summary)
      : ''
  const sourceEventIds = normalizeSourceEventIds(
    Array.isArray(candidate.sourceEventIds)
      ? candidate.sourceEventIds.map((entry) => String(entry))
      : [],
  )

  if (!sessionId || !projectId || !summary || sourceEventIds.length === 0) {
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
    summary,
    sourceEventIds,
  }
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

  const content = normalizeCandidateContent(
    typeof candidate.content === 'string' ? candidate.content : '',
  )
  const key = normalizeCandidateKey(
    typeof candidate.key === 'string' && candidate.key.trim()
      ? candidate.key
      : content,
  )
  const confidence = clampConfidence(
    typeof candidate.confidence === 'number' ? candidate.confidence : 0,
  )

  if (
    !content ||
    !key ||
    confidence < 0.3 ||
    isLowSignalCandidate(content) ||
    isEphemeralMemoryCandidate(key, content)
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
    group.forEach((candidate, index) => {
      candidate.status = index === 0 ? 'active' : 'conflicted'
      candidates.push(candidate)
    })
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
    if (isLowSignalCandidate(normalizedContent)) {
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
      sourceSessionId: session.id,
      sourceEventIds,
    })
  }

  pushFact('default-agent-cli', `Default managed CLI: ${session.startupCommand}`, 0.9)
  pushFact('shell', `Preferred shell: ${session.shell}`, 0.8)

  if (project.identity?.remoteFingerprint) {
    pushFact(
      'remote',
      `Canonical remote: ${project.identity.remoteFingerprint}`,
      0.95,
    )
  }

  return facts
}

function buildMemoryMarkdown(
  projectTitle: string,
  snapshot: ProjectMemorySnapshot,
): string {
  const sections: string[] = [
    `# ${projectTitle}`,
    '',
    '## Latest Summary',
    snapshot.summary?.summary || 'No captured session summary yet.',
    '',
  ]

  const appendSection = (title: string, items: ProjectMemoryCandidate[]) => {
    sections.push(`## ${title}`)
    if (items.length === 0) {
      sections.push('No entries yet.', '')
      return
    }

    for (const item of items) {
      sections.push(`- ${item.content}`)
    }
    sections.push('')
  }

  appendSection('Facts', snapshot.facts.filter((item) => item.status === 'active'))
  appendSection(
    'Decisions',
    snapshot.decisions.filter((item) => item.status === 'active'),
  )
  appendSection(
    'Preferences',
    snapshot.preferences.filter((item) => item.status === 'active'),
  )
  appendSection(
    'Workflows',
    snapshot.workflows.filter((item) => item.status === 'active'),
  )

  return `${sections.join('\n').trim()}\n`
}

function buildArchitectureMarkdown(
  snapshot: ProjectArchitectureSnapshot,
): string {
  const moduleNameById = new Map(
    snapshot.modules.map((module) => [module.id, module.name]),
  )
  const sections: string[] = [
    `# ${snapshot.title} Architecture`,
    '',
    '## System Overview',
    snapshot.systemOverview || 'No architecture overview available yet.',
    '',
    '## Modules',
  ]

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

function selectRelevantEntries(
  items: ProjectMemoryCandidate[],
  locationId: string | null,
  query?: string,
): ProjectMemoryCandidate[] {
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
    return activeItems
  }

  const queryTerms = normalizedQuery.split(/\s+/).filter((term) => term.length >= 3)
  if (queryTerms.length === 0) {
    return activeItems
  }

  const scoredItems = activeItems
    .map((item) => ({
      item,
      score: queryTerms.reduce((score, term) => {
        return item.content.toLowerCase().includes(term) || item.key.includes(term)
          ? score + 1
          : score
      }, 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)

  return scoredItems.length > 0 ? scoredItems : activeItems
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
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export class ProjectMemoryManager {
  private readonly getLibraryRoot: () => string
  private readonly extractor?: ProjectMemoryExtractor
  private diagnosticReporter?: ProjectMemoryDiagnosticReporter

  constructor(getLibraryRoot: () => string, extractor?: ProjectMemoryExtractor) {
    this.getLibraryRoot = getLibraryRoot
    this.extractor = extractor
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
      ? await readJsonFile<ProjectArchitectureSnapshot | null>(filePath, null)
      : null
  }

  private async readSnapshotFromDirectory(
    projectDirectory: string,
  ): Promise<ProjectMemorySnapshot> {
    const [summary, facts, decisions, preferences, workflows] = await Promise.all([
      readJsonFile<SessionSummary | null>(
        path.join(projectDirectory, 'summaries', 'latest.json'),
        null,
      ),
      readJsonFile(path.join(projectDirectory, 'facts.json'), [] as ProjectMemoryCandidate[]),
      readJsonFile(
        path.join(projectDirectory, 'decisions.json'),
        [] as ProjectMemoryCandidate[],
      ),
      readJsonFile(
        path.join(projectDirectory, 'preferences.json'),
        [] as ProjectMemoryCandidate[],
      ),
      readJsonFile(
        path.join(projectDirectory, 'workflows.json'),
        [] as ProjectMemoryCandidate[],
      ),
    ])

    return {
      summary: normalizePersistedSummary(summary),
      facts,
      decisions,
      preferences,
      workflows,
    }
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
  }): Promise<void> {
    await mkdir(path.join(input.projectDirectory, 'summaries'), { recursive: true })
    await writeJsonFile(path.join(input.projectDirectory, 'project.json'), {
      id: input.projectId,
      title: input.projectTitle,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      identity: input.identity,
    })

    for (const fileName of PROJECT_MEMORY_CANDIDATE_FILES) {
      const key = fileName.replace('.json', '') as keyof Omit<
        ProjectMemorySnapshot,
        'summary'
      >
      await writeJsonFile(
        path.join(input.projectDirectory, fileName),
        input.snapshot[key],
      )
    }

    if (input.snapshot.summary) {
      await writeJsonFile(
        path.join(input.projectDirectory, 'summaries', 'latest.json'),
        input.snapshot.summary,
      )
      await writeFile(
        path.join(input.projectDirectory, 'summaries', 'latest.md'),
        `${input.snapshot.summary.summary}\n`,
        'utf8',
      )
    } else {
      await rm(path.join(input.projectDirectory, 'summaries', 'latest.json'), {
        force: true,
      })
      await rm(path.join(input.projectDirectory, 'summaries', 'latest.md'), {
        force: true,
      })
    }

    if (input.architectureSnapshot) {
      await writeJsonFile(
        path.join(input.projectDirectory, 'architecture.json'),
        input.architectureSnapshot,
      )
      await writeFile(
        path.join(input.projectDirectory, 'architecture.md'),
        buildArchitectureMarkdown(input.architectureSnapshot),
        'utf8',
      )
    }

    await writeFile(
      path.join(input.projectDirectory, 'memory.md'),
      buildMemoryMarkdown(input.projectTitle, input.snapshot),
      'utf8',
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

    normalizedSummaries.sort(compareSummaryPriority)

    return {
      latest: normalizedSummaries[0] ?? normalizedLatestSummary,
      removedCount,
    }
  }

  private async indexArchitectureForProject(
    project: ProjectConfig,
    location: ProjectLocation | null,
    sessionId?: string,
  ): Promise<ProjectArchitectureSnapshot | null> {
    try {
      return await indexProjectArchitecture({
        projectId: deriveProjectMemoryKey(project),
        title: deriveProjectMemoryTitle(project),
        rootPath: location?.rootPath ?? project.rootPath,
      })
    } catch (error) {
      this.reportDiagnostic({
        level: 'warning',
        code: 'architecture-index-failed',
        message:
          error instanceof Error
            ? error.message
            : 'Architecture indexing failed.',
        projectId: project.id,
        sessionId,
      })
      return null
    }
  }

  async readSnapshot(project: ProjectConfig): Promise<ProjectMemorySnapshot> {
    const projectDirectory = this.getProjectDirectory(project)
    if (!projectDirectory) {
      return {
        summary: null,
        facts: [],
        decisions: [],
        preferences: [],
        workflows: [],
      }
    }

    return await this.readSnapshotFromDirectory(projectDirectory)
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
    return summary !== null
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
      const content = normalizeCandidateContent(candidate.content)
      const key = normalizeCandidateKey(candidate.key || content)
      const confidence = clampConfidence(candidate.confidence)
      const sourceEventIds = uniqueStrings(candidate.sourceEventIds)
      if (!content || !key || confidence < 0.3 || isLowSignalCandidate(content)) {
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
        identicalEntry.confidence = Math.max(identicalEntry.confidence, candidate.confidence)
        identicalEntry.sourceEventIds = uniqueStrings([
          ...identicalEntry.sourceEventIds,
          ...candidate.sourceEventIds,
        ])
        identicalEntry.status = 'active'
        continue
      }

      for (const entry of sameKeyEntries.filter((item) => item.status === 'active')) {
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

    const architectureSnapshot = await this.indexArchitectureForProject(
      input.project,
      input.location,
      input.session.id,
    )

    const sourceEventIds = normalizeSourceEventIds(
      input.transcript.map((event) => event.id),
    )
    const summary: SessionSummary = {
      sessionId: input.session.id,
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: timestamp,
      summary:
        trimExcerpt(extractorResult?.summary ?? null, 600) ??
        buildDeterministicSummary(input.session, input.transcript),
      sourceEventIds,
    }

    const snapshot = await this.readSnapshot(input.project)
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

    const facts = this.mergeCandidates(
      snapshot.facts,
      [...stableFacts, ...extractedCandidates.filter((candidate) => candidate.kind === 'fact')],
    )
    const decisions = this.mergeCandidates(
      snapshot.decisions,
      extractedCandidates.filter((candidate) => candidate.kind === 'decision'),
    )
    const preferences = this.mergeCandidates(
      snapshot.preferences,
      extractedCandidates.filter((candidate) => candidate.kind === 'preference'),
    )
    const workflows = this.mergeCandidates(
      snapshot.workflows,
      extractedCandidates.filter((candidate) => candidate.kind === 'workflow'),
    )

    await writeJsonFile(path.join(projectDirectory, 'summaries', `${input.session.id}.json`), summary)
    await this.writeCanonicalArtifacts({
      projectDirectory,
      projectId: memoryProjectId,
      projectTitle: memoryProjectTitle,
      createdAt: input.project.createdAt,
      updatedAt: timestamp,
      identity: buildPortableProjectIdentity(input.project),
      snapshot: {
        summary,
        facts,
        decisions,
        preferences,
        workflows,
      },
      architectureSnapshot: architectureSnapshot ?? undefined,
    })
  }

  async refreshHistoricalImport(
    projects: ProjectConfig[],
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
    const projectByMemoryKey = new Map<string, ProjectConfig>()
    for (const project of projects) {
      const memoryKey = deriveProjectMemoryKey(project)
      const current = projectByMemoryKey.get(memoryKey)
      if (!current || project.updatedAt.localeCompare(current.updatedAt) > 0) {
        projectByMemoryKey.set(memoryKey, project)
      }
    }

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
      const facts = normalizeCandidateSet(
        await readJsonFile(path.join(projectDirectory, 'facts.json'), [] as unknown[]),
        fallbackProjectId,
        timestamp,
      )
      const decisions = normalizeCandidateSet(
        await readJsonFile(path.join(projectDirectory, 'decisions.json'), [] as unknown[]),
        fallbackProjectId,
        timestamp,
      )
      const preferences = normalizeCandidateSet(
        await readJsonFile(
          path.join(projectDirectory, 'preferences.json'),
          [] as unknown[],
        ),
        fallbackProjectId,
        timestamp,
      )
      const workflows = normalizeCandidateSet(
        await readJsonFile(path.join(projectDirectory, 'workflows.json'), [] as unknown[]),
        fallbackProjectId,
        timestamp,
      )

      result.prunedCandidateCount +=
        facts.prunedCount +
        decisions.prunedCount +
        preferences.prunedCount +
        workflows.prunedCount

      let architectureSnapshot: ProjectArchitectureSnapshot | undefined
      if (matchedProject) {
        const indexedArchitecture = await this.indexArchitectureForProject(
          matchedProject,
          null,
        )
        if (indexedArchitecture) {
          architectureSnapshot = indexedArchitecture
          result.regeneratedArchitectureCount += 1
        }
      }

      await this.writeCanonicalArtifacts({
        projectDirectory,
        projectId,
        projectTitle,
        createdAt,
        updatedAt: timestamp,
        identity: matchedProject
          ? buildPortableProjectIdentity(matchedProject)
          : normalizeStoredProjectIdentity(storedProject?.identity),
        snapshot: {
          summary: normalizedSummaries.latest,
          facts: facts.candidates,
          decisions: decisions.candidates,
          preferences: preferences.candidates,
          workflows: workflows.candidates,
        },
        architectureSnapshot,
      })

      result.cleanedProjectCount += 1
    }

    return result
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

    const [snapshot, architectureSnapshot] = await Promise.all([
      this.readSnapshot(input.project),
      this.readArchitectureSnapshot(input.project),
    ])
    const hasMaterial =
      Boolean(snapshot.summary?.summary) ||
      snapshot.facts.length > 0 ||
      snapshot.decisions.length > 0 ||
      snapshot.preferences.length > 0 ||
      snapshot.workflows.length > 0 ||
      Boolean(architectureSnapshot?.systemOverview) ||
      (architectureSnapshot?.modules.length ?? 0) > 0
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
    const relevantFacts = selectRelevantEntries(
      snapshot.facts,
      locationId,
      input.query,
    ).slice(0, 6)
    const relevantDecisions = selectRelevantEntries(
      snapshot.decisions,
      locationId,
      input.query,
    ).slice(0, 4)
    const relevantPreferences = selectRelevantEntries(
      snapshot.preferences,
      locationId,
      input.query,
    ).slice(0, 4)
    const relevantWorkflows = selectRelevantEntries(
      snapshot.workflows,
      locationId,
      input.query,
    ).slice(0, 4)
    const relevantModules = architectureSnapshot
      ? selectRelevantModules(architectureSnapshot.modules, input.query).slice(0, 3)
      : []
    const relevantInteractions = architectureSnapshot
      ? selectRelevantInteractions(
          architectureSnapshot.interactions,
          relevantModules.map((module) => module.id),
          input.query,
        ).slice(0, 2)
      : []
    const architectureExcerpt = trimExcerpt(
      architectureSnapshot?.systemOverview ?? null,
      260,
    )
    const fileReferences = [
      path.join(projectDirectory, 'memory.md'),
      ...(architectureSnapshot
        ? [
            path.join(projectDirectory, 'architecture.md'),
            path.join(projectDirectory, 'architecture.json'),
          ]
        : []),
      path.join(projectDirectory, 'decisions.json'),
      path.join(projectDirectory, 'preferences.json'),
      path.join(projectDirectory, 'summaries', 'latest.md'),
    ]
    const summaryExcerpt = trimExcerpt(snapshot.summary?.summary ?? null, 240)
    const projectFactPreview = relevantFacts
      .slice(0, 3)
      .map((entry) => `- ${entry.content}`)
      .join('\n')
    const decisionPreview = relevantDecisions
      .slice(0, 2)
      .map((entry) => `- ${entry.content}`)
      .join('\n')
    const preferencePreview = relevantPreferences
      .slice(0, 2)
      .map((entry) => `- ${entry.content}`)
      .join('\n')
    const workflowPreview = relevantWorkflows
      .slice(0, 2)
      .map((entry) => `- ${entry.content}`)
      .join('\n')
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
      architectureExcerpt ? `Architecture overview: ${architectureExcerpt}` : null,
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
