import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { SkillAiMergeAgent } from '../src/shared/skills'

const MAX_PROCESS_OUTPUT_BYTES = 4_000

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

async function runCopilotStructured(input: {
  tempRoot: string
  prompt: string
  contextDirectories: string[]
}): Promise<string> {
  return await runCommand(
    'copilot',
    input.tempRoot,
    [
      '--output-format',
      'json',
      '--stream',
      'off',
      '--allow-all',
      '--no-ask-user',
      '--no-custom-instructions',
      ...input.contextDirectories.flatMap((directory) => ['--add-dir', directory]),
      '--prompt',
      `${input.prompt}\nReturn only JSON. Do not wrap it in markdown.`,
    ],
    null,
  )
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
  await writeFile(promptPath, input.prompt, 'utf8')

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
    cwd: input.agent === 'claude'
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
      [
        '$prompt | & claude --print --output-format json',
        '--json-schema $schema',
        '--no-session-persistence --permission-mode dontAsk',
        `| Tee-Object -FilePath ${q(input.outputPath)}`,
      ].join(' '),
    )
  } else {
    const dirArgs = input.contextDirectories
      .map((d) => `--add-dir ${q(d)}`)
      .join(' ')
    lines.push(
      `$prompt = (Get-Content -Raw ${q(input.promptPath)}) + "\`nReturn only JSON. Do not wrap it in markdown."`,
      [
        '& copilot --output-format json --stream off',
        '--allow-all --no-ask-user --no-custom-instructions',
        dirArgs,
        '--prompt $prompt',
        `| Tee-Object -FilePath ${q(input.outputPath)}`,
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
