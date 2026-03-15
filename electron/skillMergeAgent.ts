import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  SkillAiMergeAgent,
  SkillAiMergeProposal,
  SkillAiMergeReview,
  SkillAiMergeReviewStatus,
  SkillSyncRoot,
} from '../src/shared/skills'
import { resolveCommandPromptCommand } from './windowsShell'

export interface SkillMergeSource {
  root: SkillSyncRoot
  files: Map<string, Buffer>
}

interface SkillMergeResponse {
  summary: string
  rationale: string
  warnings: string[]
}

interface SkillReviewResponse {
  status: SkillAiMergeReviewStatus
  summary: string
  rationale: string
  warnings: string[]
}

interface DirectoryFiles {
  files: Map<string, string>
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

function formatAgentLabel(agent: SkillAiMergeAgent): string {
  if (agent === 'codex') {
    return 'Codex'
  }

  if (agent === 'claude') {
    return 'Claude'
  }

  return 'Copilot'
}

async function listFilesRecursive(rootPath: string): Promise<DirectoryFiles> {
  const files = new Map<string, string>()

  async function visit(currentPath: string, relativePath = ''): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const nextRelativePath = relativePath
        ? path.posix.join(relativePath, entry.name)
        : entry.name
      const nextPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        await visit(nextPath, nextRelativePath)
        continue
      }

      if (entry.isFile()) {
        files.set(nextRelativePath, nextPath)
      }
    }
  }

  await visit(rootPath)
  return { files }
}

async function writeSourceDirectory(
  rootPath: string,
  files: Map<string, Buffer>,
): Promise<void> {
  for (const [relativePath, content] of files.entries()) {
    const targetPath = path.join(rootPath, ...relativePath.split('/'))
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }
}

function buildMergeSchema(): string {
  return JSON.stringify(
    {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'rationale', 'warnings'],
      properties: {
        summary: {
          type: 'string',
        },
        rationale: {
          type: 'string',
        },
        warnings: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    }
  )
}

function buildReviewSchema(): string {
  return JSON.stringify(
    {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'summary', 'rationale', 'warnings'],
      properties: {
        status: {
          type: 'string',
          enum: ['approved', 'approved-with-warnings', 'changes-requested'],
        },
        summary: {
          type: 'string',
        },
        rationale: {
          type: 'string',
        },
        warnings: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    }
  )
}

function buildMergePrompt(skillName: string, sourceRoots: SkillSyncRoot[]): string {
  return [
    'You are merging multiple conflicting versions of an Agent CLIs skill.',
    `The skill name is "${skillName}".`,
    `Available source roots: ${sourceRoots.join(', ')}.`,
    'Each available root folder in the current workspace contains one complete version of the skill:',
    '- ./library',
    '- ./discovered',
    'Only some of those folders may exist.',
    'Your task:',
    '1. Compare all available versions semantically.',
    '2. Create one best merged skill under ./merged.',
    '3. Preserve strong instructions from each version, but remove duplication and contradictions.',
    '4. Merge SKILL.md into one coherent document.',
    '5. Combine non-overlapping scripts, references, and assets when they add value.',
    '6. If two files overlap heavily, either choose the better version or consolidate them into one consistent result.',
    '7. Do not modify the source folders.',
    '8. Ensure ./merged/SKILL.md exists and every merged file is plain text.',
    '9. Prefer correctness, completeness, and maintainability over provider-specific quirks unless a provider-specific detail is clearly necessary.',
    'When finished, return JSON matching the provided schema:',
    '- summary: one short description of the merged result',
    '- rationale: brief explanation of the important merge decisions',
    '- warnings: remaining risks or manual follow-ups, if any',
  ].join('\n')
}

function buildReviewPrompt(
  skillName: string,
  mergeAgent: SkillAiMergeAgent,
  reviewer: SkillAiMergeAgent,
  sourceRoots: SkillSyncRoot[],
): string {
  return [
    'You are reviewing an AI-generated merge for an Agent CLIs skill.',
    `The skill name is "${skillName}".`,
    `The merged candidate was produced by ${formatAgentLabel(mergeAgent)} and saved under ./proposal.`,
    `Original source roots available for comparison: ${sourceRoots.join(', ')}.`,
    'Original versions may exist under:',
    '- ./library',
    '- ./discovered',
    'Review tasks:',
    '1. Compare the merged candidate in ./proposal against the original versions.',
    '2. Check whether the merged SKILL.md preserves the best instructions and removes contradictions.',
    '3. Check whether scripts, references, and helper files were preserved or combined appropriately.',
    '4. Look for missing content, semantic regressions, duplicated files, or poor merge decisions.',
    '5. Do not modify any files.',
    `6. Act as an independent reviewer using ${formatAgentLabel(reviewer)}.`,
    'Return JSON matching the provided schema:',
    '- status: approved | approved-with-warnings | changes-requested',
    '- summary: one short review verdict',
    '- rationale: concise explanation of the verdict',
    '- warnings: remaining review concerns or manual follow-ups, if any',
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isMergeResponse(value: unknown): value is SkillMergeResponse {
  return (
    isRecord(value) &&
    typeof value.summary === 'string' &&
    typeof value.rationale === 'string' &&
    isStringArray(value.warnings)
  )
}

function isReviewStatus(value: unknown): value is SkillAiMergeReviewStatus {
  return (
    value === 'approved' ||
    value === 'approved-with-warnings' ||
    value === 'changes-requested'
  )
}

function isReviewResponse(value: unknown): value is SkillReviewResponse {
  return (
    isRecord(value) &&
    isReviewStatus(value.status) &&
    typeof value.summary === 'string' &&
    typeof value.rationale === 'string' &&
    isStringArray(value.warnings)
  )
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function collectResponseCandidates(
  value: unknown,
  seen = new Set<object>(),
): unknown[] {
  if (value == null) {
    return []
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return []
    }

    const parsed = safeJsonParse(trimmed)
    return parsed == null
      ? [trimmed]
      : [trimmed, parsed, ...collectResponseCandidates(parsed, seen)]
  }

  if (Array.isArray(value)) {
    return [value, ...value.flatMap((entry) => collectResponseCandidates(entry, seen))]
  }

  if (isRecord(value)) {
    if (seen.has(value)) {
      return [value]
    }

    seen.add(value)
    return [
      value,
      ...Object.values(value).flatMap((entry) => collectResponseCandidates(entry, seen)),
    ]
  }

  return [value]
}

function parseStructuredResponse<T>(
  rawOutput: string,
  validate: (value: unknown) => value is T,
  errorLabel: string,
): T {
  const trimmed = rawOutput.trim()
  if (!trimmed) {
    throw new Error(`${errorLabel} did not return any structured output.`)
  }

  const candidates = collectResponseCandidates(trimmed)
  const objectStart = trimmed.indexOf('{')
  const objectEnd = trimmed.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(...collectResponseCandidates(trimmed.slice(objectStart, objectEnd + 1)))
  }

  for (const candidate of candidates) {
    if (validate(candidate)) {
      return candidate
    }
  }

  throw new Error(`${errorLabel} returned output that did not match the expected schema.`)
}

async function runCommand(
  agent: SkillAiMergeAgent,
  workingDirectory: string,
  args: string[],
  input: string | null,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const child =
      process.platform === 'win32'
        ? spawn(
            resolveCommandPromptCommand(),
            ['/Q', '/D', '/C', joinCommandTokens([agent, ...args])],
            {
              cwd: workingDirectory,
              stdio: 'pipe',
              windowsHide: true,
            },
          )
        : spawn(agent, args, {
            cwd: workingDirectory,
            stdio: 'pipe',
          })

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk))
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('exit', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(
        new Error(
          [
            `${formatAgentLabel(agent)} command failed with exit code ${code ?? 'unknown'}.`,
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

async function runCodexMerge(
  workingDirectory: string,
  schemaPath: string,
  outputPath: string,
  prompt: string,
): Promise<void> {
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
}

async function runClaudeStructured(
  workingDirectory: string,
  schema: string,
  prompt: string,
  permissionMode: 'bypassPermissions' | 'dontAsk',
): Promise<string> {
  const result = await runCommand(
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
      permissionMode,
    ],
    prompt,
  )

  return result.stdout
}

async function runCopilotStructured(
  workingDirectory: string,
  prompt: string,
): Promise<string> {
  const structuredPrompt = `${prompt}\nReturn only JSON. Do not wrap it in markdown.`
  const result = await runCommand(
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
      structuredPrompt,
    ],
    null,
  )

  return result.stdout
}

async function readMergedFiles(mergedRoot: string): Promise<SkillAiMergeProposal['files']> {
  const mergedFiles = await listFilesRecursive(mergedRoot)
  return Promise.all(
    [...mergedFiles.files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([relativePath, absolutePath]) => ({
        path: relativePath,
        content: await readFile(absolutePath, 'utf8'),
      })),
  )
}

export async function generateSkillMerge(
  agent: SkillAiMergeAgent,
  skillName: string,
  sources: SkillMergeSource[],
): Promise<SkillAiMergeProposal> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skill-merge-'))

  try {
    const mergedRoot = path.join(tempRoot, 'merged')
    const schemaPath = path.join(tempRoot, 'response-schema.json')
    const outputPath = path.join(tempRoot, 'response.json')

    for (const source of sources) {
      await writeSourceDirectory(path.join(tempRoot, source.root), source.files)
    }

    await mkdir(mergedRoot, { recursive: true })
    const mergeSchema = buildMergeSchema()
    await writeFile(schemaPath, `${mergeSchema}\n`, 'utf8')

    const prompt = buildMergePrompt(
      skillName,
      sources.map((source) => source.root),
    )

    if (agent === 'codex') {
      await runCodexMerge(tempRoot, schemaPath, outputPath, prompt)
    } else if (agent === 'claude') {
      const output = await runClaudeStructured(
        tempRoot,
        mergeSchema,
        prompt,
        'bypassPermissions',
      )
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else {
      const output = await runCopilotStructured(tempRoot, prompt)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    }

    const response = parseStructuredResponse<SkillMergeResponse>(
      await readFile(outputPath, 'utf8'),
      isMergeResponse,
      `${formatAgentLabel(agent)} merge`,
    )
    const files = await readMergedFiles(mergedRoot)

    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`${formatAgentLabel(agent)} merge did not produce merged/SKILL.md.`)
    }

    return {
      skillName,
      mergeAgent: agent,
      generatedAt: new Date().toISOString(),
      summary: response.summary.trim(),
      rationale: response.rationale.trim(),
      warnings: response.warnings.map((warning) => warning.trim()).filter(Boolean),
      sourceRoots: sources.map((source) => source.root),
      files,
      review: null,
    }
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to generate AI merge proposal.',
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function reviewSkillMerge(
  reviewer: SkillAiMergeAgent,
  proposal: SkillAiMergeProposal,
  sources: SkillMergeSource[],
): Promise<SkillAiMergeReview> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skill-review-'))

  try {
    const proposalFiles = new Map(
      proposal.files.map((file) => [file.path, Buffer.from(file.content, 'utf8')]),
    )
    const schemaPath = path.join(tempRoot, 'review-schema.json')
    const outputPath = path.join(tempRoot, 'review.json')

    for (const source of sources) {
      await writeSourceDirectory(path.join(tempRoot, source.root), source.files)
    }

    await writeSourceDirectory(path.join(tempRoot, 'proposal'), proposalFiles)
    const reviewSchema = buildReviewSchema()
    await writeFile(schemaPath, `${reviewSchema}\n`, 'utf8')

    const prompt = buildReviewPrompt(
      proposal.skillName,
      proposal.mergeAgent,
      reviewer,
      sources.map((source) => source.root),
    )

    if (reviewer === 'codex') {
      await runCodexMerge(tempRoot, schemaPath, outputPath, prompt)
    } else if (reviewer === 'claude') {
      const output = await runClaudeStructured(
        tempRoot,
        reviewSchema,
        prompt,
        'dontAsk',
      )
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else {
      const output = await runCopilotStructured(tempRoot, prompt)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    }

    const response = parseStructuredResponse<SkillReviewResponse>(
      await readFile(outputPath, 'utf8'),
      isReviewResponse,
      `${formatAgentLabel(reviewer)} review`,
    )

    return {
      reviewer,
      reviewedAt: new Date().toISOString(),
      status: response.status,
      summary: response.summary.trim(),
      rationale: response.rationale.trim(),
      warnings: response.warnings.map((warning) => warning.trim()).filter(Boolean),
    }
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'Failed to review AI merge proposal.',
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
