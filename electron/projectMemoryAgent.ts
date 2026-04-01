import type {
  ProjectMemoryCandidateKind,
  ProjectMemoryScope,
} from '../src/shared/projectMemory'
import {
  PROJECT_MEMORY_CANDIDATE_KINDS,
  PROJECT_MEMORY_SCOPES,
} from '../src/shared/projectMemory'
import type { SkillAiMergeAgent } from '../src/shared/skills'
import type {
  ProjectMemoryExtractor,
  ProjectMemoryExtractionResult,
} from './projectMemoryManager'
import { buildTranscriptEvidenceDigest } from './projectMemoryEvidence'
import { extractJsonObject, runStructuredAgent, truncateUtf8 } from './structuredAgentRunner'

const VALID_CANDIDATE_KINDS = new Set(PROJECT_MEMORY_CANDIDATE_KINDS)
const VALID_CANDIDATE_SCOPES = new Set(PROJECT_MEMORY_SCOPES)
export const MAX_PROJECT_MEMORY_PROMPT_BYTES = 240_000
const MAX_TRANSCRIPT_DIGEST_BYTES = 120_000
const MAX_TRANSCRIPT_EVENT_PREVIEW_BYTES = 90_000
const MAX_TRANSCRIPT_EVIDENCE_BYTES = 24_000
const MAX_TRANSCRIPT_EVENT_PREVIEW_LINES = 160
const MAX_TRANSCRIPT_EVENT_PREVIEW_CHARS = 320

function buildTranscriptDigestForPrompt(
  normalizedTranscript: string,
  maxBytes: number,
): string {
  if (!normalizedTranscript.trim()) {
    return '(empty transcript digest)'
  }

  const lines = normalizedTranscript.split('\n')
  const keptLines: string[] = []
  let usedBytes = 0

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    const separatorBytes = keptLines.length > 0 ? 1 : 0
    const nextBytes = Buffer.byteLength(line, 'utf8') + separatorBytes
    if (keptLines.length > 0 && usedBytes + nextBytes > maxBytes) {
      break
    }

    if (keptLines.length === 0 && nextBytes > maxBytes) {
      keptLines.push(truncateUtf8(line, maxBytes))
      usedBytes = Buffer.byteLength(keptLines[0], 'utf8')
      break
    }

    keptLines.push(line)
    usedBytes += nextBytes
  }

  keptLines.reverse()
  let digest = keptLines.join('\n')
  const omittedLineCount = Math.max(0, lines.length - keptLines.length)
  if (omittedLineCount > 0) {
    const prefix = `[older transcript omitted: ${omittedLineCount} lines]\n`
    digest = truncateUtf8(`${prefix}${digest}`, maxBytes)
  }

  return digest
}

function buildTranscriptPreviewForPrompt(
  transcript: Parameters<ProjectMemoryExtractor['extract']>[0]['transcript'],
  maxBytes: number,
): string {
  if (transcript.length === 0) {
    return '(no transcript events)'
  }

  const keptLines: string[] = []
  let usedBytes = 0
  let omittedEventCount = 0

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index]
    const payload = event.chunk?.trim()
    const preview = payload
      ? payload.slice(0, MAX_TRANSCRIPT_EVENT_PREVIEW_CHARS)
      : JSON.stringify(event.metadata ?? {})
    const line = `${event.id} ${event.kind}/${event.source}: ${preview}`
    const separatorBytes = keptLines.length > 0 ? 1 : 0
    const nextBytes = Buffer.byteLength(line, 'utf8') + separatorBytes

    if (keptLines.length >= MAX_TRANSCRIPT_EVENT_PREVIEW_LINES) {
      omittedEventCount = index + 1
      break
    }

    if (keptLines.length > 0 && usedBytes + nextBytes > maxBytes) {
      omittedEventCount = index + 1
      break
    }

    if (keptLines.length === 0 && nextBytes > maxBytes) {
      keptLines.push(truncateUtf8(line, maxBytes))
      usedBytes = Buffer.byteLength(keptLines[0], 'utf8')
      omittedEventCount = index
      break
    }

    keptLines.push(line)
    usedBytes += nextBytes
  }

  keptLines.reverse()
  let preview = keptLines.join('\n')
  if (omittedEventCount > 0) {
    const prefix = `[older events omitted: ${omittedEventCount}]\n`
    preview = truncateUtf8(`${prefix}${preview}`, maxBytes)
  }

  return preview
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

export function buildPrompt(
  input: Parameters<ProjectMemoryExtractor['extract']>[0],
): string {
  const transcriptDigest = buildTranscriptDigestForPrompt(
    input.normalizedTranscript,
    MAX_TRANSCRIPT_DIGEST_BYTES,
  )
  const transcriptPreview = buildTranscriptPreviewForPrompt(
    input.transcript,
    MAX_TRANSCRIPT_EVENT_PREVIEW_BYTES,
  )
  const transcriptEvidence = buildTranscriptEvidenceDigest(
    input.transcript,
    MAX_TRANSCRIPT_EVIDENCE_BYTES,
  )

  return truncateUtf8(
    [
      'You are extracting durable project memory from an Agent CLIs session.',
      'Return only structured JSON matching the provided schema.',
      'The goal is to reduce analysis time in future sessions.',
      'Use the transcript as the primary source, and inspect the repository when that helps sharpen the memory.',
      'Do not modify the repository.',
      'Prefer high-signal, project-specific guidance over generic summaries.',
      'If evidence is weak, omit the item.',
      'When the session shows multiple attempted approaches, preserve the final working method and why it should be preferred.',
      'Capture user corrections and tool-choice convergence aggressively when they are likely to matter again.',
      'Memory kinds:',
      '- fact: stable verifiable project facts that will stay useful',
      '- decision: technical choices, constraints, or chosen approaches',
      '- preference: durable user or team defaults',
      '- workflow: repeatable task recipes for doing work in this repo',
      '- troubleshooting-pattern: how the agent diagnosed and fixed an error, including the decisive signal and the resolution',
      '- user-assist-pattern: how the user unblocked the task or corrected the agent, and when to ask for that help again',
      '- component-workflow: how a concrete subsystem works end to end, including trigger, state transitions, collaborating components, and outputs',
      '- project-convention: repo-specific conventions, edit boundaries, naming/layout rules, generated code rules, and integration contracts',
      '- debug-approach: effective debugging or validation playbooks that worked for this project',
      '- critical-file: a high-value file or folder to read first, with why it matters and what structure it contains',
      'Rules:',
      '- Keep every content field self-contained and directly usable by a future agent.',
      '- Use relative repo paths when useful. Never include machine-specific absolute paths.',
      '- Do not record branch names, temporary worktrees, or ephemeral environment details.',
      '- Do not record ticket-specific progress state such as numbered PRs, current branch/commit state, force-push history, or Jenkins/build status updates.',
      '- Do not repeat the same lesson in multiple memory kinds. Choose the narrowest category that preserves the lesson once.',
      '- When recording commands or prompts, preserve the exact corrected syntax, including required prefixes or shell markers. If the session corrected an earlier spelling, keep only the corrected final form.',
      '- Prefer code, config, build, and test paths over generic instruction documents. Only keep files such as AGENTS.md, README.md, or github/copilot-instructions.md when they are the authoritative source for a durable repo-specific rule.',
      '- It is valid to record a durable workflow or preference such as "prefer GitHub REST API for PR creation over gh CLI or MCP" when the session establishes that as the repeatable successful path.',
      '- sourceEventIds may be empty if the item mainly comes from repo inspection rather than a specific transcript event.',
      '- Use scope="location" only if the guidance is specific to this local checkout.',
      `Logical project title: ${input.project.title}`,
      `Managed CLI session title: ${input.session.title}`,
      `Current checkout label: ${input.location?.label ?? 'n/a'}`,
      `Repository root: ${input.location?.rootPath ?? input.project.rootPath}`,
      `Known remote fingerprint: ${input.project.identity?.remoteFingerprint ?? 'n/a'}`,
      'Transcript digest:',
      transcriptDigest,
      '',
      'High-signal evidence from across the session:',
      transcriptEvidence,
      '',
      'Transcript events with ids:',
      transcriptPreview,
    ].join('\n'),
    MAX_PROJECT_MEMORY_PROMPT_BYTES,
  )
}

export function parseProjectMemoryResponse(
  rawOutput: string,
): ProjectMemoryExtractionResult {
  const parsed = JSON.parse(extractJsonObject(rawOutput)) as Partial<ProjectMemoryExtractionResult>
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Project memory extraction returned invalid JSON.')
  }

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    candidates: Array.isArray(parsed.candidates)
      ? parsed.candidates.flatMap((candidate) => {
          if (!candidate || typeof candidate !== 'object') {
            return []
          }

          const normalized = candidate as {
            kind: ProjectMemoryCandidateKind
            scope: ProjectMemoryScope
            key: string
            content: string
            confidence: number
            sourceEventIds: string[]
          }
          if (
            !VALID_CANDIDATE_KINDS.has(normalized.kind) ||
            !VALID_CANDIDATE_SCOPES.has(normalized.scope) ||
            typeof normalized.key !== 'string' ||
            typeof normalized.content !== 'string' ||
            typeof normalized.confidence !== 'number'
          ) {
            return []
          }

          return [
            {
              kind: normalized.kind,
              scope: normalized.scope,
              key: normalized.key,
              content: normalized.content,
              confidence: normalized.confidence,
              sourceEventIds: Array.isArray(normalized.sourceEventIds)
                ? normalized.sourceEventIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [],
            },
          ]
        })
      : [],
  }
}

export class ProjectMemoryAgentExtractor implements ProjectMemoryExtractor {
  private readonly getAgent: () => SkillAiMergeAgent

  constructor(getAgent: () => SkillAiMergeAgent) {
    this.getAgent = getAgent
  }

  async extract(
    input: Parameters<ProjectMemoryExtractor['extract']>[0],
  ): Promise<ProjectMemoryExtractionResult> {
    if (!input.normalizedTranscript.trim()) {
      return {
        summary: '',
        candidates: [],
      }
    }

    const agent = this.getAgent()
    const schema = buildSchema()
    const prompt = buildPrompt(input)
    const rawOutput = await runStructuredAgent({
      agent,
      schema,
      prompt,
      contextDirectories: [
        input.location?.rootPath ?? '',
        input.project.identity?.repoRoot ?? '',
        input.project.rootPath,
      ],
    })

    return parseProjectMemoryResponse(rawOutput)
  }
}
