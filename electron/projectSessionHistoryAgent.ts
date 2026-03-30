import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  PROJECT_MEMORY_CANDIDATE_KINDS,
  PROJECT_MEMORY_SCOPES,
  type ProjectLocation,
  type ProjectMemoryCandidateKind,
  type ProjectMemoryScope,
  type TranscriptEvent,
} from '../src/shared/projectMemory'
import type { ProjectConfig, SessionConfig } from '../src/shared/session'
import type { SkillAiMergeAgent } from '../src/shared/skills'
import { buildTranscriptEvidenceDigest } from './projectMemoryEvidence'
import { loadProjectMemorySkill } from './projectMemorySkillLoader'
import { parseProjectMemoryResponse } from './projectMemoryAgent'
import {
  prepareStructuredAgent,
  runStructuredAgent,
  truncateUtf8,
} from './structuredAgentRunner'
import type { PreparedStructuredAgent } from './structuredAgentRunner'

const MAX_PROJECT_SESSION_ANALYSIS_PROMPT_BYTES = 240_000
const MAX_SESSION_CATALOG_BYTES = 100_000
const MAX_SESSION_EVIDENCE_CATALOG_BYTES = 72_000
const MAX_SESSION_EVIDENCE_BYTES = 1_400
const MAX_TEXT_EXCERPT_BYTES = 16_000
const AGENTS_CANDIDATES = ['AGENTS.md']
const README_CANDIDATES = ['README.md', 'Readme.md', 'readme.md']

export interface HistoricalProjectSessionDescriptor {
  session: SessionConfig
  location: ProjectLocation | null
  transcriptEventCount: number
  lastTranscriptEventAt: string | null
  transcriptPath: string
  transcriptIndexPath: string
}

export interface ProjectSessionHistoryAnalysisResult {
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

export interface ProjectSessionHistoryAnalyzer {
  analyze(input: {
    project: ProjectConfig
    canonicalMemoryDirectory: string
    transcriptBaseRoot: string
    sessions: HistoricalProjectSessionDescriptor[]
  }): Promise<ProjectSessionHistoryAnalysisResult>

  prepare?(input: {
    project: ProjectConfig
    canonicalMemoryDirectory: string
    transcriptBaseRoot: string
    sessions: HistoricalProjectSessionDescriptor[]
  }): Promise<PreparedStructuredAgent>
}

function buildSchema(): string {
  return JSON.stringify(
    {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'candidates'],
      properties: {
        summary: {
          type: 'string',
        },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'kind',
              'scope',
              'key',
              'content',
              'confidence',
              'sourceEventIds',
            ],
            properties: {
              kind: {
                type: 'string',
                enum: PROJECT_MEMORY_CANDIDATE_KINDS,
              },
              scope: {
                type: 'string',
                enum: PROJECT_MEMORY_SCOPES,
              },
              key: {
                type: 'string',
              },
              content: {
                type: 'string',
              },
              confidence: {
                type: 'number',
              },
              sourceEventIds: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
    },
    null,
    2,
  )
}

async function readFirstExistingExcerpt(
  rootPath: string,
  relativePaths: string[],
): Promise<string | null> {
  for (const relativePath of relativePaths) {
    try {
      const content = await readFile(path.join(rootPath, relativePath), 'utf8')
      const normalized = content.trim()
      if (normalized) {
        return `${relativePath}\n${truncateUtf8(normalized, MAX_TEXT_EXCERPT_BYTES)}`
      }
    } catch {
      continue
    }
  }

  return null
}

function formatSessionCatalog(
  sessions: HistoricalProjectSessionDescriptor[],
  transcriptBaseRoot: string,
): string {
  if (sessions.length === 0) {
    return '(no stored sessions with local transcripts)'
  }

  const lines: string[] = []
  let usedBytes = 0

  for (const descriptor of sessions) {
    const transcriptPath = path
      .relative(transcriptBaseRoot, descriptor.transcriptPath)
      .replace(/\\/g, '/')
    const indexPath = path
      .relative(transcriptBaseRoot, descriptor.transcriptIndexPath)
      .replace(/\\/g, '/')
    const locationLabel = descriptor.location?.label ?? 'n/a'
    const line = [
      `- ${descriptor.session.id}`,
      `title="${truncateUtf8(descriptor.session.title, 120)}"`,
      `cli=${descriptor.session.startupCommand}`,
      `location=${locationLabel}`,
      `updatedAt=${descriptor.session.updatedAt}`,
      `events=${descriptor.transcriptEventCount}`,
      `lastEventAt=${descriptor.lastTranscriptEventAt ?? 'n/a'}`,
      `transcript=${transcriptPath}`,
      `index=${indexPath}`,
    ].join(' | ')
    const separatorBytes = lines.length > 0 ? 1 : 0
    const nextBytes = Buffer.byteLength(line, 'utf8') + separatorBytes

    if (lines.length > 0 && usedBytes + nextBytes > MAX_SESSION_CATALOG_BYTES) {
      const omitted = sessions.length - lines.length
      const prefix = `[additional sessions omitted: ${omitted}]\n`
      return truncateUtf8(`${prefix}${lines.join('\n')}`, MAX_SESSION_CATALOG_BYTES)
    }

    lines.push(line)
    usedBytes += nextBytes
  }

  return lines.join('\n')
}

async function readTranscriptEvents(
  transcriptPath: string,
): Promise<TranscriptEvent[]> {
  try {
    const content = await readFile(transcriptPath, 'utf8')
    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as TranscriptEvent]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

async function formatSessionEvidenceCatalog(
  sessions: HistoricalProjectSessionDescriptor[],
  transcriptBaseRoot: string,
): Promise<string> {
  if (sessions.length === 0) {
    return '(no transcript evidence available)'
  }

  const blocks: string[] = []
  let usedBytes = 0

  for (const descriptor of sessions) {
    const transcript = await readTranscriptEvents(descriptor.transcriptPath)
    const evidence = buildTranscriptEvidenceDigest(
      transcript,
      MAX_SESSION_EVIDENCE_BYTES,
      4,
    )
    const transcriptPath = path
      .relative(transcriptBaseRoot, descriptor.transcriptPath)
      .replace(/\\/g, '/')
    const block = [
      `- ${descriptor.session.id} | title="${truncateUtf8(descriptor.session.title, 120)}" | location=${descriptor.location?.label ?? 'n/a'} | updatedAt=${descriptor.session.updatedAt} | events=${descriptor.transcriptEventCount} | transcript=${transcriptPath}`,
      evidence
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    ].join('\n')
    const separatorBytes = blocks.length > 0 ? 2 : 0
    const nextBytes = Buffer.byteLength(block, 'utf8') + separatorBytes

    if (blocks.length > 0 && usedBytes + nextBytes > MAX_SESSION_EVIDENCE_CATALOG_BYTES) {
      const omitted = sessions.length - blocks.length
      const prefix = `[additional session evidence omitted: ${omitted}]\n`
      return truncateUtf8(
        `${prefix}${blocks.join('\n\n')}`,
        MAX_SESSION_EVIDENCE_CATALOG_BYTES,
      )
    }

    blocks.push(block)
    usedBytes += nextBytes
  }

  return blocks.join('\n\n')
}

export function buildPrompt(input: {
  project: ProjectConfig
  canonicalMemoryDirectory: string
  transcriptBaseRoot: string
  sessions: HistoricalProjectSessionDescriptor[]
  agentsExcerpt: string | null
  readmeExcerpt: string | null
  skillGuidance: string | null
  sessionEvidenceCatalog: string
}): string {
  return truncateUtf8(
    [
      'You are synthesizing durable project memory from the full stored Agent CLIs session history for one logical project.',
      'Return only structured JSON matching the provided schema.',
      'Use the repository, the existing canonical memory files, and the stored transcript/index files as the source of truth.',
      'You may inspect files in the provided context directories, but do not modify them.',
      'Analyze the sessions together rather than summarizing them one by one.',
      'Consolidate repeated lessons into stronger, deduplicated memory.',
      'Prefer high-signal, project-specific guidance over generic process narration.',
      'If evidence is weak, omit the item.',
      'When several sessions show failed approaches converging on one successful method, preserve that final method as durable memory.',
      'Capture user corrections and repeated tool-choice convergence aggressively when they will prevent the agent from retrying the same wrong path.',
      '',
      'Task skill guidance:',
      input.skillGuidance ?? '(none found)',
      '',
      'Rules:',
      '- Keep only durable facts, decisions, preferences, workflows, troubleshooting patterns, user-assist patterns, component workflows, conventions, debug approaches, and critical files.',
      '- Use relative repo paths when useful. Never include machine-local absolute paths in the output.',
      '- Do not record branch names, commit hashes, PR numbers, build numbers, temporary files, or historical progress status.',
      '- It is valid to preserve a durable tool-choice preference or workflow, for example preferring a verified REST API path over gh CLI or MCP when repeated sessions establish that as the successful approach.',
      '- Treat the current canonical memory as material to improve and deduplicate, not text to repeat.',
      `Logical project title: ${input.project.title}`,
      `Canonical memory directory: ${input.canonicalMemoryDirectory}`,
      `Transcript store root: ${input.transcriptBaseRoot}`,
      `Known remote fingerprint: ${input.project.identity?.remoteFingerprint ?? 'n/a'}`,
      '',
      'Repository guidance excerpt:',
      input.agentsExcerpt ?? '(none found)',
      '',
      'README excerpt:',
      input.readmeExcerpt ?? '(none found)',
      '',
      'Stored sessions to review:',
      formatSessionCatalog(input.sessions, input.transcriptBaseRoot),
      '',
      'High-signal transcript evidence by session:',
      input.sessionEvidenceCatalog,
    ].join('\n'),
    MAX_PROJECT_SESSION_ANALYSIS_PROMPT_BYTES,
  )
}

export class ProjectSessionHistoryAgentExtractor
  implements ProjectSessionHistoryAnalyzer
{
  private readonly getAgent: () => SkillAiMergeAgent

  constructor(getAgent: () => SkillAiMergeAgent) {
    this.getAgent = getAgent
  }

  async analyze(input: {
    project: ProjectConfig
    canonicalMemoryDirectory: string
    transcriptBaseRoot: string
    sessions: HistoricalProjectSessionDescriptor[]
  }): Promise<ProjectSessionHistoryAnalysisResult> {
    if (input.sessions.length === 0) {
      return {
        summary: '',
        candidates: [],
      }
    }

    const locationRoots = [
      ...new Set(
        input.sessions
          .map((descriptor) => descriptor.location?.rootPath ?? descriptor.session.cwd)
          .filter(Boolean),
      ),
    ]
    const rootPath = locationRoots[0] ?? input.project.rootPath
    const [agentsExcerpt, readmeExcerpt, skill] = await Promise.all([
      readFirstExistingExcerpt(rootPath, AGENTS_CANDIDATES),
      readFirstExistingExcerpt(rootPath, README_CANDIDATES),
      loadProjectMemorySkill('project-memory-sessions-analysis'),
    ])
    const sessionEvidenceCatalog = await formatSessionEvidenceCatalog(
      input.sessions,
      input.transcriptBaseRoot,
    )

    const rawOutput = await runStructuredAgent({
      agent: this.getAgent(),
      schema: buildSchema(),
      prompt: buildPrompt({
        ...input,
        agentsExcerpt,
        readmeExcerpt,
        skillGuidance: skill?.markdown ?? null,
        sessionEvidenceCatalog,
      }),
      contextDirectories: [
        input.canonicalMemoryDirectory,
        input.transcriptBaseRoot,
        input.project.rootPath,
        ...locationRoots,
        skill?.directory ?? '',
      ],
    })

    return parseProjectMemoryResponse(rawOutput)
  }

  async prepare(input: {
    project: ProjectConfig
    canonicalMemoryDirectory: string
    transcriptBaseRoot: string
    sessions: HistoricalProjectSessionDescriptor[]
  }): Promise<PreparedStructuredAgent> {
    const locationRoots = [
      ...new Set(
        input.sessions
          .map((descriptor) => descriptor.location?.rootPath ?? descriptor.session.cwd)
          .filter(Boolean),
      ),
    ]
    const rootPath = locationRoots[0] ?? input.project.rootPath
    const [agentsExcerpt, readmeExcerpt, skill] = await Promise.all([
      readFirstExistingExcerpt(rootPath, AGENTS_CANDIDATES),
      readFirstExistingExcerpt(rootPath, README_CANDIDATES),
      loadProjectMemorySkill('project-memory-sessions-analysis'),
    ])
    const sessionEvidenceCatalog = await formatSessionEvidenceCatalog(
      input.sessions,
      input.transcriptBaseRoot,
    )

    return await prepareStructuredAgent({
      agent: this.getAgent(),
      schema: buildSchema(),
      prompt: buildPrompt({
        ...input,
        agentsExcerpt,
        readmeExcerpt,
        skillGuidance: skill?.markdown ?? null,
        sessionEvidenceCatalog,
      }),
      contextDirectories: [
        input.canonicalMemoryDirectory,
        input.transcriptBaseRoot,
        input.project.rootPath,
        ...locationRoots,
        skill?.directory ?? '',
      ],
    })
  }
}
