import { tokenizeCommand } from './codexCli'

const OPENCODE_EXECUTABLE_PATTERN = /(^|[\\/])opencode(?:\.exe)?$/i

// Subcommands that put the CLI into a non-interactive / non-TUI mode.
// When any of these is the first positional argument we cannot manage the
// command as an interactive session.
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'run',
  'serve',
  'web',
  'acp',
  'attach',
  'agent',
  'auth',
  'github',
  'gitlab',
  'mcp',
  'models',
  'session',
  'stats',
  'export',
  'import',
  'plugin',
  'plug',
  'pr',
  'db',
  'debug',
  'uninstall',
  'upgrade',
  'help',
])

// Flags that signal a non-interactive invocation.
const NON_INTERACTIVE_FLAGS = new Set([
  '-h',
  '--help',
  '-v',
  '--version',
])

// Flags that resume / continue an existing session. These are dropped when
// re-deriving a managed resume command (we add our own `--session <id>`).
const RESUME_FLAGS = new Set(['-c', '--continue', '--session', '-s'])

// Standalone boolean flags accepted by the TUI launcher.
const FLAG_OPTIONS = new Set([
  '--fork',
  '--mdns',
  '--print-logs',
  '--pure',
  '--dangerously-skip-permissions',
])

// Options that take a single value (either `--opt value` or `--opt=value`).
const OPTIONS_WITH_SINGLE_VALUE = new Set([
  '--prompt',
  '--model',
  '-m',
  '--agent',
  '--port',
  '--hostname',
  '--mdns-domain',
  '--cors',
  '--log-level',
])

export interface OpencodeSessionMeta {
  sessionId: string
  timestamp: string
  cwd: string
  summary?: string
}

interface ParsedOpencodeCommand {
  executable: string
  resumeOptions: string[]
  optionNames: Set<string>
}

export function supportsOpencodeSessionResume(command: string): boolean {
  return parseOpencodeCommand(command) !== null
}

export function buildOpencodeResumeCommand(
  command: string,
  sessionId: string,
): string | null {
  const parsed = parseOpencodeCommand(command)
  if (!parsed) {
    return null
  }

  return joinCommandTokens([
    parsed.executable,
    ...parsed.resumeOptions,
    '--session',
    sessionId,
  ])
}

export function withOpencodeFullAccess(command: string): string | null {
  const parsed = parseOpencodeCommand(command)
  if (!parsed) {
    return null
  }

  const resumeOptions = [...parsed.resumeOptions]
  if (!parsed.optionNames.has('--dangerously-skip-permissions')) {
    resumeOptions.push('--dangerously-skip-permissions')
  }

  return joinCommandTokens([parsed.executable, ...resumeOptions])
}

/**
 * Parse a session record emitted by `opencode session list --format json`
 * or `opencode export <id>`.
 *
 * opencode stores sessions in a database rather than loose transcript files,
 * so callers obtain the JSON via the CLI and hand the raw string here.
 *
 * Accepts either a single session object or an array; when given an array the
 * first entry is used.
 */
export function extractOpencodeSessionMeta(
  content: string,
): OpencodeSessionMeta | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }

  const record = Array.isArray(parsed) ? parsed[0] : parsed
  if (!record || typeof record !== 'object') {
    return null
  }

  const value = record as Record<string, unknown>
  // The session payload may be nested under `info`/`session` depending on the
  // command used.
  const info =
    isObject(value.info) ? (value.info as Record<string, unknown>)
      : isObject(value.session) ? (value.session as Record<string, unknown>)
      : value

  const sessionId = firstString(info.id, info.sessionID, info.sessionId)
  const cwd = firstString(info.directory, info.cwd, info.path)
  const timestamp = firstTimestamp(info.time, info.created, info.updated, info)

  if (!sessionId || !cwd || !timestamp) {
    return null
  }

  const summary = firstString(info.title, info.summary, info.name)

  return {
    sessionId,
    timestamp,
    cwd,
    summary: summary?.trim() || undefined,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return undefined
}

function firstTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // opencode timestamps are epoch milliseconds.
      return new Date(value).toISOString()
    }
    if (isObject(value)) {
      const nested = firstTimestamp(
        value.created,
        value.updated,
        value.created_at,
        value.updated_at,
      )
      if (nested) {
        return nested
      }
    }
  }
  return undefined
}

function parseOpencodeCommand(command: string): ParsedOpencodeCommand | null {
  const tokens = tokenizeCommand(command)
  const executable = tokens[0]
  if (!executable || !OPENCODE_EXECUTABLE_PATTERN.test(executable)) {
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

    if (RESUME_FLAGS.has(optionName)) {
      if (
        (optionName === '--session' || optionName === '-s') &&
        !hasInlineValue
      ) {
        index += consumeSingleValue(tokens, index)
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

    if (token.startsWith('-')) {
      resumeOptions.push(token)
      optionNames.add(optionName)
      continue
    }

    // First positional argument. `opencode [project]` launches the TUI in the
    // given directory, but any known subcommand is non-interactive.
    if (NON_INTERACTIVE_SUBCOMMANDS.has(token.toLowerCase())) {
      return null
    }

    resumeOptions.push(token)
  }

  return {
    executable,
    resumeOptions,
    optionNames,
  }
}

function consumeSingleValue(tokens: string[], optionIndex: number): number {
  return tokens[optionIndex + 1] ? 1 : 0
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
