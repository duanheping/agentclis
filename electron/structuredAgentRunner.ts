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
