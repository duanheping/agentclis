import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SkillAiMergeAgent } from '../src/shared/skills'
import type {
  ProjectMemoryExtractor,
  ProjectMemoryExtractionResult,
} from './projectMemoryManager'

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

function buildPrompt(input: Parameters<ProjectMemoryExtractor['extract']>[0]): string {
  const transcriptPreview = input.transcript
    .map((event) => {
      const payload = event.chunk?.trim()
      const preview = payload ? payload.slice(0, 400) : JSON.stringify(event.metadata ?? {})
      return `${event.id} ${event.kind}/${event.source}: ${preview}`
    })
    .join('\n')

  return [
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
    input.normalizedTranscript || '(empty transcript digest)',
    '',
    'Transcript events with ids:',
    transcriptPreview || '(no transcript events)',
  ].join('\n')
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
            stderr.trim() ? `stderr: ${stderr.trim()}` : null,
            stdout.trim() ? `stdout: ${stdout.trim()}` : null,
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

function parseResponse(rawOutput: string): ProjectMemoryExtractionResult {
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

      return parseResponse(rawOutput)
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
