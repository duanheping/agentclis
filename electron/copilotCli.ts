import { tokenizeCommand } from './codexCli'

const COPILOT_EXECUTABLE_PATTERN = /(^|[\\/])copilot(?:\.exe)?$/i
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'help',
  'init',
  'login',
  'plugin',
  'update',
  'version',
])
const NON_INTERACTIVE_FLAGS = new Set([
  '--acp',
  '-h',
  '--help',
  '-v',
  '--version',
  '-p',
  '--prompt',
])
const INTERACTIVE_PROMPT_FLAGS = new Set(['-i', '--interactive'])
const RESUME_FLAGS = new Set(['--continue', '--resume'])
const FLAG_OPTIONS = new Set([
  '--allow-all',
  '--allow-all-paths',
  '--allow-all-tools',
  '--allow-all-urls',
  '--autopilot',
  '--banner',
  '--disable-builtin-mcps',
  '--disallow-temp-dir',
  '--enable-all-github-mcp-tools',
  '--experimental',
  '--no-alt-screen',
  '--no-ask-user',
  '--no-auto-update',
  '--no-bash-env',
  '--no-color',
  '--no-custom-instructions',
  '--no-experimental',
  '--plain-diff',
  '--remote',
  '-s',
  '--silent',
  '--screen-reader',
  '--yolo',
])
const OPTIONS_WITH_SINGLE_VALUE = new Set([
  '--agent',
  '--config-dir',
  '--log-dir',
  '--log-level',
  '--max-autopilot-continues',
  '--model',
  '--output-format',
  '--share',
  '--stream',
])
const OPTIONS_WITH_OPTIONAL_VALUE = new Set([
  '--alt-screen',
  '--bash-env',
  '--mouse',
])
const OPTIONS_WITH_MULTI_VALUE = new Set([
  '--add-dir',
  '--add-github-mcp-tool',
  '--add-github-mcp-toolset',
  '--additional-mcp-config',
  '--allow-tool',
  '--allow-url',
  '--available-tools',
  '--deny-tool',
  '--deny-url',
  '--disable-mcp-server',
  '--excluded-tools',
  '--plugin-dir',
  '--secret-env-vars',
])

export interface CopilotSessionMeta {
  sessionId: string
  timestamp: string
  cwd: string
  summary?: string
}

interface ParsedCopilotCommand {
  executable: string
  resumeOptions: string[]
  optionNames: Set<string>
}

export function supportsCopilotSessionResume(command: string): boolean {
  return parseCopilotCommand(command) !== null
}

export function buildCopilotResumeCommand(
  command: string,
  sessionId: string,
): string | null {
  const parsed = parseCopilotCommand(command)
  if (!parsed) {
    return null
  }

  return joinCommandTokens([
    parsed.executable,
    ...parsed.resumeOptions,
    '--resume',
    sessionId,
  ])
}

export function withCopilotFullAccess(command: string): string | null {
  const parsed = parseCopilotCommand(command)
  if (!parsed) {
    return null
  }

  const resumeOptions = [...parsed.resumeOptions]
  if (!parsed.optionNames.has('--allow-all')) {
    resumeOptions.push('--allow-all')
  }
  if (!parsed.optionNames.has('--no-ask-user')) {
    resumeOptions.push('--no-ask-user')
  }

  return joinCommandTokens([parsed.executable, ...resumeOptions])
}

export function withCopilotAdditionalMcpConfig(
  command: string,
  configPath: string,
): string | null {
  const parsed = parseCopilotCommand(command)
  if (!parsed) {
    return null
  }

  if (parsed.optionNames.has('--disable-mcp-server')) {
    return joinCommandTokens([parsed.executable, ...parsed.resumeOptions])
  }

  return joinCommandTokens([
    parsed.executable,
    ...parsed.resumeOptions,
    '--additional-mcp-config',
    `@${configPath}`,
  ])
}

export function extractCopilotSessionMeta(content: string): CopilotSessionMeta | null {
  const sessionId = findYamlValue(content, 'id')
  const cwd = findYamlValue(content, 'cwd')
  const timestamp =
    findYamlValue(content, 'created_at') ?? findYamlValue(content, 'updated_at')
  const summary = findYamlValue(content, 'summary')?.trim()

  if (!sessionId || !cwd || !timestamp) {
    return null
  }

  return {
    sessionId,
    timestamp,
    cwd,
    summary: summary || undefined,
  }
}

function parseCopilotCommand(command: string): ParsedCopilotCommand | null {
  const tokens = tokenizeCommand(command)
  const executable = tokens[0]
  if (!executable || !COPILOT_EXECUTABLE_PATTERN.test(executable)) {
    return null
  }

  const resumeOptions: string[] = []
  const optionNames = new Set<string>()

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      break
    }

    const [optionName] = token.split('=', 1)
    const hasInlineValue = token.includes('=')

    if (NON_INTERACTIVE_FLAGS.has(optionName)) {
      return null
    }

    if (INTERACTIVE_PROMPT_FLAGS.has(optionName)) {
      if (!hasInlineValue) {
        index += consumeSingleValue(tokens, index)
      }
      continue
    }

    if (RESUME_FLAGS.has(optionName)) {
      if (optionName === '--resume' && !hasInlineValue) {
        index += consumeOptionalValue(tokens, index)
      }
      continue
    }

    if (FLAG_OPTIONS.has(optionName)) {
      resumeOptions.push(token)
      optionNames.add(optionName)
      continue
    }

    if (OPTIONS_WITH_SINGLE_VALUE.has(optionName)) {
      resumeOptions.push(token)
      optionNames.add(optionName)
      if (!hasInlineValue) {
        const consumed = consumeSingleValue(tokens, index)
        if (consumed === 1) {
          resumeOptions.push(tokens[index + 1])
        }
        index += consumed
      }
      continue
    }

    if (OPTIONS_WITH_OPTIONAL_VALUE.has(optionName)) {
      resumeOptions.push(token)
      optionNames.add(optionName)
      if (!hasInlineValue) {
        const consumed = consumeOptionalValue(tokens, index)
        if (consumed === 1) {
          resumeOptions.push(tokens[index + 1])
        }
        index += consumed
      }
      continue
    }

    if (OPTIONS_WITH_MULTI_VALUE.has(optionName)) {
      resumeOptions.push(token)
      optionNames.add(optionName)
      if (!hasInlineValue) {
        const consumedValues = collectFollowingValues(tokens, index)
        for (const value of consumedValues) {
          resumeOptions.push(value)
        }
        index += consumedValues.length
      }
      continue
    }

    if (token.startsWith('-')) {
      resumeOptions.push(token)
      optionNames.add(optionName)
      continue
    }

    if (NON_INTERACTIVE_SUBCOMMANDS.has(token.toLowerCase())) {
      return null
    }

    return null
  }

  return {
    executable,
    resumeOptions,
    optionNames,
  }
}

function collectFollowingValues(tokens: string[], optionIndex: number): string[] {
  const values: string[] = []

  for (let index = optionIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith('-')) {
      break
    }

    values.push(token)
  }

  return values
}

function consumeSingleValue(tokens: string[], optionIndex: number): number {
  return tokens[optionIndex + 1] ? 1 : 0
}

function consumeOptionalValue(tokens: string[], optionIndex: number): number {
  const value = tokens[optionIndex + 1]
  if (!value || value.startsWith('-')) {
    return 0
  }

  return 1
}

function findYamlValue(content: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = content.match(new RegExp(`^${escapedKey}:\\s*(.+)$`, 'm'))
  if (!match) {
    return null
  }

  return match[1].trim()
}

function joinCommandTokens(tokens: string[]): string {
  return tokens.map((token) => quoteWindowsArg(token)).join(' ')
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
