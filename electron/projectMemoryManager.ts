import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

import type {
  AssembledProjectContext,
  ProjectLocation,
  ProjectMemoryCandidate,
  ProjectMemoryCandidateKind,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  SessionSummary,
  TranscriptEvent,
} from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'

const MEMORY_ROOT_DIRECTORY = '.agenclis-memory'
const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  'gu',
)

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

function buildStableFacts(
  project: ProjectConfig,
  session: SessionConfig,
  locationId: string | null,
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
      locationId,
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
  project: ProjectConfig,
  snapshot: ProjectMemorySnapshot,
): string {
  const sections: string[] = [
    `# ${project.title}`,
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

  private getSnapshotFilePath(
    project: ProjectConfig,
    fileName: string,
  ): string | null {
    const projectDirectory = this.getProjectDirectory(project)
    return projectDirectory ? path.join(projectDirectory, fileName) : null
  }

  private async readCandidates(
    project: ProjectConfig,
    fileName: string,
  ): Promise<ProjectMemoryCandidate[]> {
    const filePath = this.getSnapshotFilePath(project, fileName)
    return filePath ? await readJsonFile(filePath, [] as ProjectMemoryCandidate[]) : []
  }

  private async writeCandidates(
    project: ProjectConfig,
    fileName: string,
    candidates: ProjectMemoryCandidate[],
  ): Promise<void> {
    const filePath = this.getSnapshotFilePath(project, fileName)
    if (!filePath) {
      return
    }

    await writeJsonFile(filePath, candidates)
  }

  async readSnapshot(project: ProjectConfig): Promise<ProjectMemorySnapshot> {
    const [summary, facts, decisions, preferences, workflows] = await Promise.all([
      (async () => {
        const filePath = this.getSnapshotFilePath(project, 'summaries/latest.json')
        return filePath ? await readJsonFile<SessionSummary | null>(filePath, null) : null
      })(),
      this.readCandidates(project, 'facts.json'),
      this.readCandidates(project, 'decisions.json'),
      this.readCandidates(project, 'preferences.json'),
      this.readCandidates(project, 'workflows.json'),
    ])

    return {
      summary,
      facts,
      decisions,
      preferences,
      workflows,
    }
  }

  async hasSessionSummary(
    project: ProjectConfig,
    sessionId: string,
  ): Promise<boolean> {
    const filePath = this.getSnapshotFilePath(project, `summaries/${sessionId}.json`)
    if (!filePath) {
      return false
    }

    const summary = await readJsonFile<SessionSummary | null>(filePath, null)
    return Boolean(summary?.summary?.trim())
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

    const sourceEventIds = uniqueStrings(input.transcript.map((event) => event.id))
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
      input.location?.id ?? null,
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
    const memoryProjectTitle = deriveProjectMemoryTitle(input.project)
    const memoryProjectId = deriveProjectMemoryKey(input.project)

    await mkdir(path.join(projectDirectory, 'summaries'), { recursive: true })
    await writeJsonFile(path.join(projectDirectory, 'project.json'), {
      id: memoryProjectId,
      title: memoryProjectTitle,
      createdAt: input.project.createdAt,
      updatedAt: timestamp,
      identity: input.project.identity,
    })
    await this.writeCandidates(input.project, 'facts.json', facts)
    await this.writeCandidates(input.project, 'decisions.json', decisions)
    await this.writeCandidates(input.project, 'preferences.json', preferences)
    await this.writeCandidates(input.project, 'workflows.json', workflows)
    await writeJsonFile(path.join(projectDirectory, 'summaries', `${input.session.id}.json`), summary)
    await writeJsonFile(path.join(projectDirectory, 'summaries', 'latest.json'), summary)
    await writeFile(
      path.join(projectDirectory, 'summaries', 'latest.md'),
      `${summary.summary}\n`,
      'utf8',
    )
    await writeFile(
      path.join(projectDirectory, 'memory.md'),
      buildMemoryMarkdown(
        {
          ...input.project,
          title: memoryProjectTitle,
        },
        {
        summary,
        facts,
        decisions,
        preferences,
        workflows,
        },
      ),
      'utf8',
    )
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

    const snapshot = await this.readSnapshot(input.project)
    const hasMaterial =
      Boolean(snapshot.summary?.summary) ||
      snapshot.facts.length > 0 ||
      snapshot.decisions.length > 0 ||
      snapshot.preferences.length > 0 ||
      snapshot.workflows.length > 0
    if (!hasMaterial) {
      return {
        projectId: input.project.id,
        locationId: input.location?.id ?? null,
        generatedAt: new Date().toISOString(),
        bootstrapMessage: null,
        fileReferences: [],
        summaryExcerpt: null,
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
    const fileReferences = [
      path.join(projectDirectory, 'memory.md'),
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
    const locationLine = input.location
      ? `Current local checkout: ${input.location.label}`
      : null
    const bootstrapParts = [
      'Use the project memory for this logical project before proceeding.',
      'Read:',
      ...fileReferences.map((filePath) => `- ${filePath}`),
      locationLine,
      summaryExcerpt ? `Latest summary: ${summaryExcerpt}` : null,
      projectFactPreview ? `Relevant facts:\n${projectFactPreview}` : null,
      decisionPreview ? `Active decisions:\n${decisionPreview}` : null,
      preferencePreview ? `Project preferences:\n${preferencePreview}` : null,
      workflowPreview ? `Useful workflows:\n${workflowPreview}` : null,
      'Treat decisions and preferences as defaults unless the user overrides them.',
    ].filter(Boolean)

    return {
      projectId: input.project.id,
      locationId: input.location?.id ?? null,
      generatedAt: new Date().toISOString(),
      bootstrapMessage: bootstrapParts.join('\n'),
      fileReferences,
      summaryExcerpt,
    }
  }
}
