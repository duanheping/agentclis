import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SkillAiMergeAgent } from '../src/shared/skills'
import type {
  ProjectMemoryExtractor,
  ProjectMemoryExtractionResult,
} from './projectMemoryManager'

const VALID_CANDIDATE_KINDS = new Set([
  'fact',
  'decision',
  'preference',
  'workflow',
])
const VALID_CANDIDATE_SCOPES = new Set(['project', 'location'])
export const MAX_PROJECT_MEMORY_PROMPT_BYTES = 240_000
const MAX_TRANSCRIPT_DIGEST_BYTES = 120_000
const MAX_TRANSCRIPT_EVENT_PREVIEW_BYTES = 90_000
const MAX_TRANSCRIPT_EVENT_PREVIEW_LINES = 160
const MAX_TRANSCRIPT_EVENT_PREVIEW_CHARS = 320
const MAX_PROCESS_OUTPUT_BYTES = 4_000

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }

  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value
  }

  const suffix = '...'
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  if (suffixBytes >= maxBytes) {
    return suffix.slice(0, maxBytes)
  }

  let low = 0
  let high = value.length
  let best = ''

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = value.slice(0, mid)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes - suffixBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return `${best.trimEnd()}${suffix}`
}

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

function formatProcessOutput(label: string, output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) {
    return null
  }

  return `${label}: ${truncateUtf8(trimmed, MAX_PROCESS_OUTPUT_BYTES)}`
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value
  }

  const escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1')
  return `"${escaped}"`
}

function joinCommandTokens(tokens: string[]): string {
  return tokens.map((token) => quoteWindowsArg(token)).join(' ')
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
                enum: ['fact', 'decision', 'preference', 'workflow'],
              },
              scope: {
                type: 'string',
                enum: ['project', 'location'],
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

  return truncateUtf8([
    'You are extracting durable project memory from an Agent CLIs session transcript.',
    'Return only structured JSON matching the provided schema.',
    'Focus on information that is useful across future sessions.',
    'Facts should be stable and verifiable.',
    'Decisions should capture chosen technical directions or constraints.',
    'Preferences should capture durable user or project defaults.',
    'Workflows should capture repeatable task recipes.',
    'Do not include transient errors, throwaway exploration, or machine-specific absolute paths.',
    'If a memory only applies to the current local checkout, use scope="location".',
    `Logical project title: ${input.project.title}`,
    `Managed CLI session title: ${input.session.title}`,
    `Current checkout label: ${input.location?.label ?? 'n/a'}`,
    `Known remote fingerprint: ${input.project.identity?.remoteFingerprint ?? 'n/a'}`,
    'Transcript digest:',
    transcriptDigest,
    '',
    'Transcript events with ids:',
    transcriptPreview,
  ].join('\n'), MAX_PROJECT_MEMORY_PROMPT_BYTES)
}

async function runCommand(
  command: string,
  workingDirectory: string,
  args: string[],
  input: string | null,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn(
            process.env.ComSpec || 'cmd.exe',
            ['/Q', '/D', '/C', joinCommandTokens([command, ...args])],
            {
              cwd: workingDirectory,
              stdio: 'pipe',
              windowsHide: true,
            },
          )
        : spawn(command, args, {
            cwd: workingDirectory,
            stdio: 'pipe',
          })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }

      reject(
        new Error(
          [
            `${command} exited with code ${code ?? 'unknown'}.`,
            formatProcessOutput('stderr', stderr),
            formatProcessOutput('stdout', stdout),
          ]
            .filter(Boolean)
            .join(' '),
        ),
      )
    })

    if (input !== null) {
      child.stdin.write(input)
    }
    child.stdin.end()
  })
}

export function parseProjectMemoryResponse(
  rawOutput: string,
): ProjectMemoryExtractionResult {
  const parsed = JSON.parse(rawOutput) as Partial<ProjectMemoryExtractionResult>
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

          const normalized = candidate as ProjectMemoryExtractionResult['candidates'][number]
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
                ? normalized.sourceEventIds.filter((value): value is string => typeof value === 'string')
                : [],
            },
          ]
        })
      : [],
  }
}

async function runCodexStructured(
  workingDirectory: string,
  schemaPath: string,
  outputPath: string,
  prompt: string,
): Promise<string> {
  await runCommand(
    'codex',
    workingDirectory,
    [
      'exec',
      '--skip-git-repo-check',
      '--full-auto',
      '--color',
      'never',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputPath,
      '-',
    ],
    prompt,
  )

  return await readFile(outputPath, 'utf8')
}

async function runClaudeStructured(
  workingDirectory: string,
  schema: string,
  prompt: string,
): Promise<string> {
  return await runCommand(
    'claude',
    workingDirectory,
    [
      '--print',
      '--output-format',
      'json',
      '--json-schema',
      schema,
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
    ],
    prompt,
  )
}

async function runCopilotStructured(
  workingDirectory: string,
  prompt: string,
): Promise<string> {
  return await runCommand(
    'copilot',
    workingDirectory,
    [
      '--output-format',
      'json',
      '--stream',
      'off',
      '--allow-all',
      '--no-ask-user',
      '--no-custom-instructions',
      '--add-dir',
      workingDirectory,
      '--prompt',
      `${prompt}\nReturn only JSON. Do not wrap it in markdown.`,
    ],
    null,
  )
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

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-project-memory-'))

    try {
      const agent = this.getAgent()
      const schema = buildSchema()
      const schemaPath = path.join(tempRoot, 'response-schema.json')
      const outputPath = path.join(tempRoot, 'response.json')
      await writeFile(schemaPath, `${schema}\n`, 'utf8')
      const prompt = buildPrompt(input)

      let rawOutput = ''
      if (agent === 'codex') {
        rawOutput = await runCodexStructured(tempRoot, schemaPath, outputPath, prompt)
      } else if (agent === 'claude') {
        rawOutput = await runClaudeStructured(tempRoot, schema, prompt)
      } else {
        rawOutput = await runCopilotStructured(tempRoot, prompt)
      }

      return parseProjectMemoryResponse(rawOutput)
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
