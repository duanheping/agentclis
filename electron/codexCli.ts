const CODEX_EXECUTABLE_PATTERN = /(^|[\\/])codex(?:\.exe)?$/i
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'exec',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'app-server',
  'completion',
  'sandbox',
  'debug',
  'apply',
  'cloud',
  'features',
  'help',
])
const GLOBAL_FLAGS = new Set([
  '--oss',
  '--search',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--no-alt-screen',
  '-h',
  '--help',
  '-V',
  '--version',
])
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-C',
  '--cd',
  '--add-dir',
])

export interface CodexSessionMeta {
  sessionId: string
  timestamp: string
  cwd: string
  originator?: string
  source?: string
}

interface ParsedCodexCommand {
  executable: string
  globalOptions: string[]
  trailingTokens: string[]
}

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escape = false

  const normalizedCommand = command.trim()

  for (let index = 0; index < normalizedCommand.length; index += 1) {
    const char = normalizedCommand[index]

    if (escape) {
      current += char
      escape = false
      continue
    }

    if (
      quote === '"' &&
      char === '\\' &&
      normalizedCommand[index + 1] === '"'
    ) {
      escape = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

export function supportsCodexSessionResume(command: string): boolean {
  return parseCodexCommand(command) !== null
}

export function buildCodexResumeCommand(
  command: string,
  sessionId: string,
): string | null {
  const parsed = parseCodexCommand(command)
  if (!parsed) {
    return null
  }

  return joinCommandTokens([
    parsed.executable,
    ...parsed.globalOptions,
    'resume',
    sessionId,
  ])
}

export function withCodexDangerousBypass(command: string): string | null {
  const parsed = parseCodexCommand(command)
  if (!parsed) {
    return null
  }

  const globalOptions = parsed.globalOptions.filter(
    (token) => token !== '--full-auto',
  )

  if (!globalOptions.includes('--dangerously-bypass-approvals-and-sandbox')) {
    globalOptions.push('--dangerously-bypass-approvals-and-sandbox')
  }

  return joinCommandTokens([
    parsed.executable,
    ...globalOptions,
    ...parsed.trailingTokens,
  ])
}

export function withCodexDeveloperInstructions(
  command: string,
  memoryText: string,
): string | null {
  const parsed = parseCodexCommand(command)
  if (!parsed) {
    return null
  }

  const globalOptions = stripConfigOverride(
    parsed.globalOptions,
    'developer_instructions',
  )
  globalOptions.push('-c', `developer_instructions=${memoryText}`)

  return joinCommandTokens([
    parsed.executable,
    ...globalOptions,
    ...parsed.trailingTokens,
  ])
}

function stripConfigOverride(
  tokens: string[],
  key: string,
): string[] {
  const result: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (
      (token === '-c' || token === '--config') &&
      tokens[index + 1]?.startsWith(`${key}=`)
    ) {
      index += 1
      continue
    }

    result.push(token)
  }

  return result
}

export function extractCodexSessionMeta(content: string): CodexSessionMeta | null {
  const match = content.match(
    /"type":"session_meta"[\s\S]*?"payload":\{"id":"([^"]+)","timestamp":"([^"]+)","cwd":"((?:\\.|[^"])*)"/u,
  )
  if (!match) {
    return null
  }

  const originator = extractSessionMetaField(content, 'originator')
  const source = extractSessionMetaField(content, 'source')

  return {
    sessionId: match[1],
    timestamp: match[2],
    cwd: parseJsonString(match[3]),
    originator,
    source,
  }
}

function parseCodexCommand(command: string): ParsedCodexCommand | null {
  const tokens = tokenizeCommand(command)
  const executable = tokens[0]
  if (!executable || !CODEX_EXECUTABLE_PATTERN.test(executable)) {
    return null
  }

  const globalOptions: string[] = []

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return {
        executable,
        globalOptions,
        trailingTokens: tokens.slice(index),
      }
    }

    if (GLOBAL_FLAGS.has(token)) {
      globalOptions.push(token)
      continue
    }

    if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      globalOptions.push(token)
      const value = tokens[index + 1]
      if (value) {
        globalOptions.push(value)
        index += 1
      }
      continue
    }

    if (token.startsWith('-')) {
      globalOptions.push(token)
      continue
    }

    const subcommand = token.toLowerCase()
    if (subcommand === 'resume' || subcommand === 'fork') {
      return {
        executable,
        globalOptions,
        trailingTokens: tokens.slice(index),
      }
    }

    if (NON_INTERACTIVE_SUBCOMMANDS.has(subcommand)) {
      return null
    }

    return {
      executable,
      globalOptions,
      trailingTokens: tokens.slice(index),
    }
  }

  return {
    executable,
    globalOptions,
    trailingTokens: [],
  }
}

function joinCommandTokens(tokens: string[]): string {
  return tokens.map((token) => quoteWindowsArg(token)).join(' ')
}

function parseJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value.replace(/\\\\/g, '\\')
  }
}

function extractSessionMetaField(
  content: string,
  fieldName: string,
): string | undefined {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = content.match(
    new RegExp(
      `"type":"session_meta"[\\s\\S]*?"payload":\\{[\\s\\S]*?"${escapedFieldName}":"([^"]+)"`,
      'u',
    ),
  )

  return match?.[1]
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
