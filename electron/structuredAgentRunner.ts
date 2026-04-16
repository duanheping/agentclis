import { spawn, spawnSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SkillAiMergeAgent } from '../src/shared/skills'
import {
  buildQuotaFailureSummary,
  detectQuotaFailure,
} from './agentFailureSummary'

const MAX_PROCESS_OUTPUT_BYTES = 4_000
const activeStructuredAgentProcesses = new Set<ReturnType<typeof spawn>>()

function formatProcessOutput(label: string, output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) {
    return null
  }

  return `${label}: ${truncateUtf8Tail(trimmed, MAX_PROCESS_OUTPUT_BYTES)}`
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

async function runCommand(
  command: string,
  workingDirectory: string,
  args: string[],
  input: string | null,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    let cleanupScript: (() => void) | null = null
    let settled = false

    const finalize = () => {
      if (settled) {
        return
      }

      settled = true
      activeStructuredAgentProcesses.delete(child)
      cleanupScript?.()
      cleanupScript = null
    }

    if (process.platform === 'win32') {
      // Write the command to a temp batch script to avoid the ~32KB
      // Windows command-line length limit (ENAMETOOLONG).
      const scriptDir = os.tmpdir()
      const scriptName = `agenclis-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cmd`
      const scriptPath = path.join(scriptDir, scriptName)
      const scriptContent = `@echo off\n${joinCommandTokens([command, ...args])}\n`
      writeFileSync(scriptPath, scriptContent, 'utf8')

      cleanupScript = () => {
        try { unlinkSync(scriptPath) } catch { /* ignore */ }
      }

      child = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/Q', '/D', '/C', scriptPath],
        {
          cwd: workingDirectory,
          stdio: 'pipe',
          windowsHide: true,
        },
      )
    } else {
      child = spawn(command, args, {
        cwd: workingDirectory,
        stdio: 'pipe',
      })
    }

    activeStructuredAgentProcesses.add(child)

    let stdout = ''
    let stderr = ''

    child.stdout!.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr!.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      finalize()
      reject(error)
    })
    child.on('close', (code) => {
      finalize()
      if (code === 0) {
        resolve(stdout)
        return
      }

      const combinedOutput = `${stderr}\n${stdout}`
      if (detectQuotaFailure(combinedOutput)) {
        reject(
          new Error(
            `${command} exited with code ${code ?? 'unknown'}. ${buildQuotaFailureSummary(command)}`,
          ),
        )
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
      child.stdin!.write(input)
    }
    child.stdin!.end()
  })
}

function killStructuredAgentProcessTree(
  child: ReturnType<typeof spawn>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    platform === 'win32' &&
    typeof child.pid === 'number' &&
    Number.isInteger(child.pid) &&
    child.pid > 0
  ) {
    const result = spawnSync(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    )

    if (!result.error && result.status === 0) {
      return
    }
  }

  try {
    child.kill()
  } catch {
    // Ignore kill failures during app shutdown.
  }
}

export function truncateUtf8(value: string, maxBytes: number): string {
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

export function truncateUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return ''
  }

  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value
  }

  const prefix = '...'
  const prefixBytes = Buffer.byteLength(prefix, 'utf8')
  if (prefixBytes >= maxBytes) {
    return prefix.slice(0, maxBytes)
  }

  let low = 0
  let high = value.length
  let bestStart = value.length

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = value.slice(mid)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes - prefixBytes) {
      bestStart = mid
      high = mid - 1
    } else {
      low = mid + 1
    }
  }

  return `${prefix}${value.slice(bestStart).trimStart()}`
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function listAccessibleDirectories(
  directories: string[],
): Promise<string[]> {
  const normalized = [...new Set(directories.map((value) => value.trim()).filter(Boolean))]
  const accessible: string[] = []

  for (const directory of normalized) {
    try {
      const details = await stat(directory)
      if (details.isDirectory()) {
        accessible.push(directory)
      }
    } catch {
      continue
    }
  }

  return accessible
}

async function runCodexStructured(input: {
  tempRoot: string
  schemaPath: string
  outputPath: string
  prompt: string
  contextDirectories: string[]
}): Promise<string> {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--full-auto',
    '--color',
    'never',
    ...input.contextDirectories.flatMap((directory) => ['--add-dir', directory]),
    '--output-schema',
    input.schemaPath,
    '--output-last-message',
    input.outputPath,
    '-',
  ]
  await runCommand('codex', input.tempRoot, args, input.prompt)

  return await readFile(input.outputPath, 'utf8')
}

async function runClaudeStructured(input: {
  schema: string
  prompt: string
  contextDirectories: string[]
  tempRoot: string
}): Promise<string> {
  const workingDirectory = input.contextDirectories[0] ?? input.tempRoot
  return await runCommand(
    'claude',
    workingDirectory,
    [
      '--print',
      '--output-format',
      'json',
      '--json-schema',
      input.schema,
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
    ],
    input.prompt,
  )
}

function buildCopilotPromptContent(input: {
  prompt: string
  schema: string
  outputPath?: string
}): string {
  const parts = [input.prompt.trimEnd()]
  const schema = input.schema.trim()

  if (schema) {
    parts.push('', 'JSON schema to follow:', schema)
  }

  if (input.outputPath) {
    parts.push(
      '',
      `Write your complete JSON response to the file: ${input.outputPath}`,
      'Do not print the raw JSON in your conversation response — only write it to that file.',
    )
  } else {
    parts.push('', 'Return only JSON. Do not wrap it in markdown.')
  }

  return parts.join('\n')
}

function extractCopilotAssistantMessage(raw: string): {
  finalAnswer: string | null
  lastAssistantMessage: string | null
} {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  let lastAssistantMessage: string | null = null

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as {
        type?: string
        data?: {
          content?: unknown
          phase?: unknown
        }
      }
      if (
        event?.type === 'assistant.message' &&
        typeof event.data?.content === 'string' &&
        event.data.content.trim()
      ) {
        const content = event.data.content.trim()
        if (event.data?.phase === 'final_answer') {
          return {
            finalAnswer: content,
            lastAssistantMessage,
          }
        }
        lastAssistantMessage = content
      }
    } catch {
      continue
    }
  }

  return {
    finalAnswer: null,
    lastAssistantMessage,
  }
}

async function runCopilotStructured(input: {
  tempRoot: string
  schema: string
  prompt: string
  contextDirectories: string[]
}): Promise<string> {
  const outputPath = path.join(input.tempRoot, 'response.json')
  const promptPath = path.join(input.tempRoot, 'copilot-prompt.txt')
  await writeFile(
    promptPath,
    buildCopilotPromptContent({
      prompt: input.prompt,
      schema: input.schema,
      outputPath,
    }),
    'utf8',
  )

  const workingDirectory = input.contextDirectories[0] ?? input.tempRoot
  const stdout = await runCommand(
    'copilot',
    workingDirectory,
    [
      '--allow-all',
      '--no-ask-user',
      '--no-custom-instructions',
      '--output-format',
      'json',
      '--stream',
      'off',
      '--silent',
      ...input.contextDirectories.flatMap((directory) => ['--add-dir', directory]),
      '--prompt',
      `Read and follow all instructions in the file at ${promptPath}.`,
    ],
    null,
  )

  const assistantMessage = extractCopilotAssistantMessage(stdout)
  if (assistantMessage.finalAnswer) {
    return assistantMessage.finalAnswer
  }

  const fileOutput = await readFile(outputPath, 'utf8').catch(() => '')
  const trimmedFileOutput = fileOutput.trim()
  return trimmedFileOutput || assistantMessage.lastAssistantMessage || stdout
}

export async function runStructuredAgent(input: {
  agent: SkillAiMergeAgent
  schema: string
  prompt: string
  contextDirectories?: string[]
}): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-structured-agent-'))

  try {
    const contextDirectories = await listAccessibleDirectories(
      input.contextDirectories ?? [],
    )
    const schemaPath = path.join(tempRoot, 'response-schema.json')
    const outputPath = path.join(tempRoot, 'response.json')
    await writeFile(schemaPath, `${input.schema}\n`, 'utf8')

    if (input.agent === 'codex') {
      return await runCodexStructured({
        tempRoot,
        schemaPath,
        outputPath,
        prompt: input.prompt,
        contextDirectories,
      })
    }

    if (input.agent === 'claude') {
      return await runClaudeStructured({
        schema: input.schema,
        prompt: input.prompt,
        contextDirectories,
        tempRoot,
      })
    }

    return await runCopilotStructured({
      tempRoot,
      schema: input.schema,
      prompt: input.prompt,
      contextDirectories,
    })
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface PreparedStructuredAgent {
  tempRoot: string
  outputPath: string
  startupCommand: string
  cwd: string
}

export async function prepareStructuredAgent(input: {
  agent: SkillAiMergeAgent
  schema: string
  prompt: string
  contextDirectories?: string[]
}): Promise<PreparedStructuredAgent> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agenclis-structured-agent-'))
  const contextDirectories = await listAccessibleDirectories(
    input.contextDirectories ?? [],
  )
  const schemaPath = path.join(tempRoot, 'response-schema.json')
  const outputPath = path.join(tempRoot, 'response.json')
  const promptPath = path.join(tempRoot, 'prompt.txt')
  const scriptPath = path.join(tempRoot, 'run.ps1')

  await writeFile(schemaPath, `${input.schema}\n`, 'utf8')
  const promptContent = input.agent === 'copilot'
    ? buildCopilotPromptContent({
      prompt: input.prompt,
      schema: input.schema,
      outputPath,
    })
    : input.prompt
  await writeFile(promptPath, promptContent, 'utf8')

  const scriptContent = buildAnalysisScript({
    agent: input.agent,
    promptPath,
    schemaPath,
    outputPath,
    contextDirectories,
  })
  await writeFile(scriptPath, scriptContent, 'utf8')

  const startupCommand = `& ${quotePowerShellString(scriptPath)}; exit $LASTEXITCODE`

  return {
    tempRoot,
    outputPath,
    startupCommand,
    cwd: input.agent === 'claude' || input.agent === 'copilot'
      ? (contextDirectories[0] ?? tempRoot)
      : tempRoot,
  }
}

function buildAnalysisScript(input: {
  agent: SkillAiMergeAgent
  promptPath: string
  schemaPath: string
  outputPath: string
  contextDirectories: string[]
}): string {
  const q = quotePowerShellString
  const lines: string[] = ['$ErrorActionPreference = "Continue"']

  if (input.agent === 'codex') {
    const dirArgs = input.contextDirectories
      .map((d) => `--add-dir ${q(d)}`)
      .join(' ')
    lines.push(
      `$prompt = Get-Content -Raw ${q(input.promptPath)}`,
      [
        '$prompt | & codex exec',
        '--skip-git-repo-check',
        '--full-auto',
        dirArgs,
        `--output-schema ${q(input.schemaPath)}`,
        `--output-last-message ${q(input.outputPath)}`,
        '-',
      ].filter(Boolean).join(' '),
    )
  } else if (input.agent === 'claude') {
    lines.push(
      `$schema = Get-Content -Raw ${q(input.schemaPath)}`,
      `$prompt = Get-Content -Raw ${q(input.promptPath)}`,
      `Write-Host 'Running analysis with Claude...' -ForegroundColor Cyan`,
      [
        '$prompt | & claude --print',
        '--json-schema $schema',
        '--no-session-persistence --permission-mode dontAsk',
        `> ${q(input.outputPath)}`,
      ].join(' '),
      `Write-Host 'Analysis complete.' -ForegroundColor Green`,
    )
  } else {
    const dirArgs = input.contextDirectories
      .map((d) => `--add-dir ${q(d)}`)
      .join(' ')
    lines.push(
      [
        '& copilot',
        '--allow-all --no-ask-user --no-custom-instructions',
        dirArgs,
        `--prompt ${q(`Read and follow all instructions in the file at ${input.promptPath}.`)}`,
      ].filter(Boolean).join(' '),
    )
  }

  return lines.join('\n') + '\n'
}

export async function cleanupStructuredAgentTemp(
  tempRoot: string,
): Promise<void> {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
}

export function abortStructuredAgentProcesses(): void {
  for (const child of Array.from(activeStructuredAgentProcesses)) {
    killStructuredAgentProcessTree(child)
  }
}

/**
 * Extract the first top-level JSON object from agent output that may
 * contain markdown code fences, trailing text, or concatenated objects.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim()

  // Strip markdown code fences wrapping the JSON
  const fenceMatch = trimmed.match(
    /^```(?:json)?\s*\n([\s\S]*?)\n\s*```/,
  )
  const body = fenceMatch ? fenceMatch[1].trim() : trimmed

  // Fast path: try parsing the whole body first
  try {
    JSON.parse(body)
    return body
  } catch {
    // fall through to brace-matching
  }

  // Find the first '{' and walk forward counting braces to locate
  // the end of the top-level object.
  const start = body.indexOf('{')
  if (start === -1) {
    return body
  }

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < body.length; i++) {
    const ch = body[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === '\\' && inString) {
      escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return body.slice(start, i + 1)
      }
    }
  }

  // Could not find balanced braces — return the body as-is and let
  // the caller's JSON.parse surface the original error.
  return body
}
