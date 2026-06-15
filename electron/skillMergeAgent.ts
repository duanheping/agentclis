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
  FullSyncLogLevel,
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

export interface SkillMergeProgressEvent {
  detail: string
  message: string
  level?: FullSyncLogLevel
}

type SkillMergeProgressListener = (event: SkillMergeProgressEvent) => void

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

  if (agent === 'opencode') {
    return 'opencode'
  }

  return 'Copilot'
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))

  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

function sanitizeTracePreview(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized) {
    return ''
  }

  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized
}

function reportProgress(
  listener: SkillMergeProgressListener | undefined,
  detail: string,
  message: string,
  level: FullSyncLogLevel = 'info',
): void {
  listener?.({ detail, message, level })
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

function buildRefineMergePrompt(
  skillName: string,
  sourceRoots: SkillSyncRoot[],
  reviewSummary: string,
  reviewRationale: string,
  reviewWarnings: string[],
): string {
  const suggestions = [
    `Review summary: ${reviewSummary}`,
    `Review rationale: ${reviewRationale}`,
    ...(reviewWarnings.length > 0
      ? [`Review warnings:\n${reviewWarnings.map((w) => `- ${w}`).join('\n')}`]
      : []),
  ].join('\n')

  return [
    'You are re-merging multiple conflicting versions of an Agent CLIs skill after receiving feedback from an independent reviewer.',
    `The skill name is "${skillName}".`,
    `Available source roots: ${sourceRoots.join(', ')}.`,
    'Each available root folder in the current workspace contains one complete version of the skill:',
    '- ./library',
    '- ./discovered',
    'Your previous merge attempt is saved under ./proposal.',
    'Only some of those folders may exist.',
    '',
    'A secondary reviewer has reviewed your previous merge and provided this feedback:',
    suggestions,
    '',
    'Your task:',
    '1. Consider both your original analysis and the reviewer suggestions above.',
    '2. Re-examine all available source versions.',
    '3. Create an improved merged skill under ./merged, incorporating valid reviewer feedback.',
    '4. If a reviewer suggestion conflicts with your analysis, use your best judgment to determine the correct outcome.',
    '5. Preserve strong instructions from each version, but remove duplication and contradictions.',
    '6. Merge SKILL.md into one coherent document.',
    '7. Combine non-overlapping scripts, references, and assets when they add value.',
    '8. Do not modify the source folders or the ./proposal folder.',
    '9. Ensure ./merged/SKILL.md exists and every merged file is plain text.',
    'When finished, return JSON matching the provided schema:',
    '- summary: one short description of the refined merged result',
    '- rationale: brief explanation of the important merge decisions, including how reviewer feedback was addressed',
    '- warnings: remaining risks or manual follow-ups, if any',
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
  onProgress?: SkillMergeProgressListener,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const agentLabel = formatAgentLabel(agent)
    const startedAt = Date.now()
    let lastOutputAt = startedAt
    let stdoutChunkCount = 0
    let stderrChunkCount = 0
    const heartbeat = setInterval(() => {
      const elapsed = formatDuration(Date.now() - startedAt)
      const idleFor = formatDuration(Date.now() - lastOutputAt)
      reportProgress(
        onProgress,
        `Waiting for ${agentLabel} (${elapsed})`,
        `Still waiting for ${agentLabel} to finish (${elapsed} elapsed, ${idleFor} since last output).`,
      )
    }, 15000)
    heartbeat.unref?.()

    reportProgress(
      onProgress,
      `Launching ${agentLabel}`,
      `Launching ${agentLabel} in the temporary merge workspace.`,
    )

    const stopHeartbeat = () => {
      clearInterval(heartbeat)
    }
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
      const outputChunk = Buffer.from(chunk)
      stdoutChunks.push(outputChunk)
      stdoutChunkCount += 1
      lastOutputAt = Date.now()
      reportProgress(
        onProgress,
        `Receiving ${agentLabel} output`,
        `Received stdout chunk ${stdoutChunkCount} from ${agentLabel} (${outputChunk.byteLength} bytes).`,
      )
    })
    child.stderr.on('data', (chunk) => {
      const errorChunk = Buffer.from(chunk)
      stderrChunks.push(errorChunk)
      stderrChunkCount += 1
      lastOutputAt = Date.now()
      const preview = sanitizeTracePreview(errorChunk.toString('utf8'))
      reportProgress(
        onProgress,
        `Receiving ${agentLabel} diagnostics`,
        preview
          ? `Received stderr chunk ${stderrChunkCount} from ${agentLabel}: ${preview}`
          : `Received stderr chunk ${stderrChunkCount} from ${agentLabel}.`,
        'warning',
      )
    })
    child.on('error', (error) => {
      stopHeartbeat()
      reportProgress(
        onProgress,
        `${agentLabel} failed to start`,
        `${agentLabel} failed to start: ${error.message}`,
        'error',
      )
      reject(error)
    })
    child.on('exit', (code) => {
      stopHeartbeat()
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      if (code === 0) {
        reportProgress(
          onProgress,
          `${agentLabel} finished`,
          `${agentLabel} finished successfully in ${formatDuration(Date.now() - startedAt)}.`,
          'success',
        )
        resolve({ stdout, stderr })
        return
      }

      reportProgress(
        onProgress,
        `${agentLabel} failed`,
        `${agentLabel} exited with code ${code ?? 'unknown'} after ${formatDuration(Date.now() - startedAt)}.`,
        'error',
      )

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
  onProgress?: SkillMergeProgressListener,
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
    onProgress,
  )
}

async function runClaudeStructured(
  workingDirectory: string,
  schema: string,
  prompt: string,
  permissionMode: 'bypassPermissions' | 'dontAsk',
  onProgress?: SkillMergeProgressListener,
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
    onProgress,
  )

  return result.stdout
}

async function runCopilotStructured(
  workingDirectory: string,
  prompt: string,
  onProgress?: SkillMergeProgressListener,
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
    onProgress,
  )

  return result.stdout
}

async function runOpencodeStructured(
  workingDirectory: string,
  prompt: string,
  onProgress?: SkillMergeProgressListener,
): Promise<string> {
  const structuredPrompt = `${prompt}\nReturn only JSON. Do not wrap it in markdown.`
  const result = await runCommand(
    'opencode',
    workingDirectory,
    [
      'run',
      '--format',
      'json',
      structuredPrompt,
    ],
    null,
    onProgress,
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
  onProgress?: SkillMergeProgressListener,
): Promise<SkillAiMergeProposal> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skill-merge-'))

  try {
    reportProgress(
      onProgress,
      `Preparing ${skillName}`,
      `Created a temporary workspace for merging ${skillName}.`,
    )
    const mergedRoot = path.join(tempRoot, 'merged')
    const schemaPath = path.join(tempRoot, 'response-schema.json')
    const outputPath = path.join(tempRoot, 'response.json')
    const sourceFileCount = sources.reduce((count, source) => count + source.files.size, 0)

    for (const source of sources) {
      await writeSourceDirectory(path.join(tempRoot, source.root), source.files)
    }
    reportProgress(
      onProgress,
      `Wrote ${skillName} sources`,
      `Wrote ${sourceFileCount} source file${sourceFileCount === 1 ? '' : 's'} from ${sources.length} root${sources.length === 1 ? '' : 's'} for ${skillName}.`,
    )

    await mkdir(mergedRoot, { recursive: true })
    const mergeSchema = buildMergeSchema()
    await writeFile(schemaPath, `${mergeSchema}\n`, 'utf8')

    const prompt = buildMergePrompt(
      skillName,
      sources.map((source) => source.root),
    )
    reportProgress(
      onProgress,
      `Built merge prompt for ${skillName}`,
      `Built merge instructions for ${skillName} from ${sources.map((source) => source.root).join(', ')}.`,
    )

    if (agent === 'codex') {
      await runCodexMerge(tempRoot, schemaPath, outputPath, prompt, onProgress)
    } else if (agent === 'claude') {
      const output = await runClaudeStructured(
        tempRoot,
        mergeSchema,
        prompt,
        'bypassPermissions',
        onProgress,
      )
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else if (agent === 'opencode') {
      const output = await runOpencodeStructured(tempRoot, prompt, onProgress)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else {
      const output = await runCopilotStructured(tempRoot, prompt, onProgress)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    }

    reportProgress(
      onProgress,
      `Parsing ${skillName} merge output`,
      `Parsing the structured ${formatAgentLabel(agent)} merge response for ${skillName}.`,
    )
    const response = parseStructuredResponse<SkillMergeResponse>(
      await readFile(outputPath, 'utf8'),
      isMergeResponse,
      `${formatAgentLabel(agent)} merge`,
    )
    const files = await readMergedFiles(mergedRoot)
    reportProgress(
      onProgress,
      `Reading merged files for ${skillName}`,
      `Loaded ${files.length} merged file${files.length === 1 ? '' : 's'} for ${skillName}.`,
    )

    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`${formatAgentLabel(agent)} merge did not produce merged/SKILL.md.`)
    }

    reportProgress(
      onProgress,
      `Finished ${skillName}`,
      `${formatAgentLabel(agent)} produced a merge proposal for ${skillName}.`,
      'success',
    )
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
    reportProgress(
      onProgress,
      `${skillName} merge failed`,
      `Merge failed for ${skillName}: ${error instanceof Error ? error.message : 'unknown error'}`,
      'error',
    )
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
  onProgress?: SkillMergeProgressListener,
): Promise<SkillAiMergeReview> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skill-review-'))

  try {
    reportProgress(
      onProgress,
      `Preparing review for ${proposal.skillName}`,
      `Created a temporary workspace for reviewing ${proposal.skillName}.`,
    )
    const proposalFiles = new Map(
      proposal.files.map((file) => [file.path, Buffer.from(file.content, 'utf8')]),
    )
    const schemaPath = path.join(tempRoot, 'review-schema.json')
    const outputPath = path.join(tempRoot, 'review.json')
    const sourceFileCount = sources.reduce((count, source) => count + source.files.size, 0)

    for (const source of sources) {
      await writeSourceDirectory(path.join(tempRoot, source.root), source.files)
    }

    await writeSourceDirectory(path.join(tempRoot, 'proposal'), proposalFiles)
    reportProgress(
      onProgress,
      `Wrote review inputs for ${proposal.skillName}`,
      `Wrote ${sourceFileCount} source file${sourceFileCount === 1 ? '' : 's'} and ${proposal.files.length} proposal file${proposal.files.length === 1 ? '' : 's'} for ${proposal.skillName}.`,
    )
    const reviewSchema = buildReviewSchema()
    await writeFile(schemaPath, `${reviewSchema}\n`, 'utf8')

    const prompt = buildReviewPrompt(
      proposal.skillName,
      proposal.mergeAgent,
      reviewer,
      sources.map((source) => source.root),
    )
    reportProgress(
      onProgress,
      `Built review prompt for ${proposal.skillName}`,
      `Built review instructions for ${proposal.skillName} using ${formatAgentLabel(reviewer)}.`,
    )

    if (reviewer === 'codex') {
      await runCodexMerge(tempRoot, schemaPath, outputPath, prompt, onProgress)
    } else if (reviewer === 'claude') {
      const output = await runClaudeStructured(
        tempRoot,
        reviewSchema,
        prompt,
        'dontAsk',
        onProgress,
      )
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else if (reviewer === 'opencode') {
      const output = await runOpencodeStructured(tempRoot, prompt, onProgress)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else {
      const output = await runCopilotStructured(tempRoot, prompt, onProgress)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    }

    reportProgress(
      onProgress,
      `Parsing review verdict for ${proposal.skillName}`,
      `Parsing the structured ${formatAgentLabel(reviewer)} review response for ${proposal.skillName}.`,
    )
    const response = parseStructuredResponse<SkillReviewResponse>(
      await readFile(outputPath, 'utf8'),
      isReviewResponse,
      `${formatAgentLabel(reviewer)} review`,
    )

    reportProgress(
      onProgress,
      `Finished review for ${proposal.skillName}`,
      `${formatAgentLabel(reviewer)} review completed with status ${response.status} for ${proposal.skillName}.`,
      response.status === 'changes-requested' ? 'warning' : 'success',
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
    reportProgress(
      onProgress,
      `${proposal.skillName} review failed`,
      `Review failed for ${proposal.skillName}: ${error instanceof Error ? error.message : 'unknown error'}`,
      'error',
    )
    throw new Error(
      error instanceof Error ? error.message : 'Failed to review AI merge proposal.',
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function refineSkillMerge(
  agent: SkillAiMergeAgent,
  previousProposal: SkillAiMergeProposal,
  review: SkillAiMergeReview,
  sources: SkillMergeSource[],
  onProgress?: SkillMergeProgressListener,
): Promise<SkillAiMergeProposal> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-skill-refine-'))

  try {
    reportProgress(
      onProgress,
      `Preparing refinement for ${previousProposal.skillName}`,
      `Created a temporary workspace for refining ${previousProposal.skillName}.`,
    )
    const mergedRoot = path.join(tempRoot, 'merged')
    const schemaPath = path.join(tempRoot, 'response-schema.json')
    const outputPath = path.join(tempRoot, 'response.json')
    const sourceFileCount = sources.reduce((count, source) => count + source.files.size, 0)

    for (const source of sources) {
      await writeSourceDirectory(path.join(tempRoot, source.root), source.files)
    }

    const proposalFiles = new Map(
      previousProposal.files.map((file) => [file.path, Buffer.from(file.content, 'utf8')]),
    )
    await writeSourceDirectory(path.join(tempRoot, 'proposal'), proposalFiles)
    reportProgress(
      onProgress,
      `Wrote refinement inputs for ${previousProposal.skillName}`,
      `Wrote ${sourceFileCount} source file${sourceFileCount === 1 ? '' : 's'} and ${previousProposal.files.length} proposal file${previousProposal.files.length === 1 ? '' : 's'} for refinement.`,
    )

    await mkdir(mergedRoot, { recursive: true })
    const mergeSchema = buildMergeSchema()
    await writeFile(schemaPath, `${mergeSchema}\n`, 'utf8')

    const prompt = buildRefineMergePrompt(
      previousProposal.skillName,
      sources.map((source) => source.root),
      review.summary,
      review.rationale,
      review.warnings,
    )
    reportProgress(
      onProgress,
      `Built refinement prompt for ${previousProposal.skillName}`,
      `Built refinement instructions for ${previousProposal.skillName} using reviewer feedback.`,
    )

    if (agent === 'codex') {
      await runCodexMerge(tempRoot, schemaPath, outputPath, prompt, onProgress)
    } else if (agent === 'claude') {
      const output = await runClaudeStructured(
        tempRoot,
        mergeSchema,
        prompt,
        'bypassPermissions',
        onProgress,
      )
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else if (agent === 'opencode') {
      const output = await runOpencodeStructured(tempRoot, prompt, onProgress)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    } else {
      const output = await runCopilotStructured(tempRoot, prompt, onProgress)
      await writeFile(outputPath, `${output.trim()}\n`, 'utf8')
    }

    reportProgress(
      onProgress,
      `Parsing refined merge output for ${previousProposal.skillName}`,
      `Parsing the refined ${formatAgentLabel(agent)} merge response for ${previousProposal.skillName}.`,
    )
    const response = parseStructuredResponse<SkillMergeResponse>(
      await readFile(outputPath, 'utf8'),
      isMergeResponse,
      `${formatAgentLabel(agent)} refined merge`,
    )
    const files = await readMergedFiles(mergedRoot)
    reportProgress(
      onProgress,
      `Reading refined files for ${previousProposal.skillName}`,
      `Loaded ${files.length} refined file${files.length === 1 ? '' : 's'} for ${previousProposal.skillName}.`,
    )

    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`${formatAgentLabel(agent)} refined merge did not produce merged/SKILL.md.`)
    }

    reportProgress(
      onProgress,
      `Finished refinement for ${previousProposal.skillName}`,
      `${formatAgentLabel(agent)} produced a refined merge proposal for ${previousProposal.skillName}.`,
      'success',
    )
    return {
      skillName: previousProposal.skillName,
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
    reportProgress(
      onProgress,
      `${previousProposal.skillName} refinement failed`,
      `Refinement failed for ${previousProposal.skillName}: ${error instanceof Error ? error.message : 'unknown error'}`,
      'error',
    )
    throw new Error(
      error instanceof Error ? error.message : 'Failed to refine AI merge proposal.',
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}
