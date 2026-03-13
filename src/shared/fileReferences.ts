export interface FileReferenceTarget {
  raw: string
  path: string
  line?: number
  column?: number
}

export interface MarkdownFileReferenceMatch {
  fullMatch: string
  label: string
  href: string
  startIndex: number
  endIndex: number
  target: FileReferenceTarget
}

export interface PlainFileReferenceMatch {
  fullMatch: string
  startIndex: number
  endIndex: number
  target: FileReferenceTarget
}

export type FileReferenceMatch =
  | MarkdownFileReferenceMatch
  | PlainFileReferenceMatch

interface FileReferenceParseOptions {
  homeDir?: string
}

const MARKDOWN_LINK_PATTERN = /\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/gu
const PLAIN_FILE_REFERENCE_PATTERN =
  /(?:^|[\s([{"'])((?:~[\\/]|[a-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+[\\/]|\/)\S*)/giu
const HASH_LINE_SUFFIX_PATTERN = /#L(?<line>\d+)(?:C(?<column>\d+))?$/u
const COLON_LINE_SUFFIX_PATTERN = /:(?<line>\d+)(?::(?<column>\d+))?$/u
const TRAILING_PUNCTUATION_PATTERN = /[)\]}>,.;!?'"`]+$/u

export function parseFileReferenceTarget(
  value: string,
  options: FileReferenceParseOptions = {},
): FileReferenceTarget | null {
  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  const { path, line, column } = splitPathAndLocation(normalized)
  const resolvedPath = resolveFilePath(path, options.homeDir)
  if (!resolvedPath) {
    return null
  }

  return {
    raw: normalized,
    path: resolvedPath,
    line,
    column,
  }
}

export function findMarkdownFileReferences(text: string): MarkdownFileReferenceMatch[] {
  const matches: MarkdownFileReferenceMatch[] = []

  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const fullMatch = match[0]
    const label = match[1]
    const href = match[2]
    const startIndex = match.index ?? -1
    if (startIndex < 0) {
      continue
    }

    const target = parseFileReferenceTarget(href)
    if (!target) {
      continue
    }

    matches.push({
      fullMatch,
      label,
      href,
      startIndex,
      endIndex: startIndex + fullMatch.length,
      target,
    })
  }

  return matches
}

export function findPlainFileReferences(text: string): PlainFileReferenceMatch[] {
  const markdownMatches = findMarkdownFileReferences(text)
  const matches: PlainFileReferenceMatch[] = []

  for (const match of text.matchAll(PLAIN_FILE_REFERENCE_PATTERN)) {
    const fullMatch = match[0]
    const candidate = match[1]
    const startIndex = match.index ?? -1
    if (startIndex < 0 || !candidate) {
      continue
    }

    const candidateStartIndex = startIndex + fullMatch.length - candidate.length
    const trimmed = trimPlainFileReferenceCandidate(candidate)
    if (!trimmed) {
      continue
    }

    const candidateEndIndex = candidateStartIndex + trimmed.fullMatch.length
    if (overlapsExistingMatch(candidateStartIndex, candidateEndIndex, markdownMatches)) {
      continue
    }

    matches.push({
      fullMatch: trimmed.fullMatch,
      startIndex: candidateStartIndex,
      endIndex: candidateEndIndex,
      target: trimmed.target,
    })
  }

  return matches
}

export function findFileReferences(text: string): FileReferenceMatch[] {
  const markdownMatches = findMarkdownFileReferences(text)
  const plainMatches = findPlainFileReferences(text)

  return [...markdownMatches, ...plainMatches].sort(
    (left, right) => left.startIndex - right.startIndex,
  )
}

function splitPathAndLocation(
  value: string,
): Pick<FileReferenceTarget, 'path' | 'line' | 'column'> {
  const hashMatch = value.match(HASH_LINE_SUFFIX_PATTERN)
  if (hashMatch?.index !== undefined) {
    return {
      path: value.slice(0, hashMatch.index),
      line: Number.parseInt(hashMatch.groups?.line ?? '', 10),
      column: parseOptionalInteger(hashMatch.groups?.column),
    }
  }

  const colonMatch = value.match(COLON_LINE_SUFFIX_PATTERN)
  if (colonMatch?.index !== undefined) {
    return {
      path: value.slice(0, colonMatch.index),
      line: Number.parseInt(colonMatch.groups?.line ?? '', 10),
      column: parseOptionalInteger(colonMatch.groups?.column),
    }
  }

  return { path: value }
}

function resolveFilePath(value: string, homeDir?: string): string | null {
  if (isAbsoluteFilePath(value)) {
    return value
  }

  if (isHomeRelativeFilePath(value)) {
    if (!homeDir?.trim()) {
      return value
    }

    return joinHomeRelativePath(homeDir, value)
  }

  if (!value.startsWith('file://')) {
    return null
  }

  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') {
      return null
    }

    const decodedPath = decodeURIComponent(url.pathname)
    if (/^\/[a-z]:[\\/]/iu.test(decodedPath)) {
      return decodedPath.slice(1)
    }

    return decodedPath
  } catch {
    return null
  }
}

function isAbsoluteFilePath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/iu.test(value) ||
    /^[\\/]{2}[^\\/]+[\\/][^\\/]+/u.test(value) ||
    /^\/(?!\/)/u.test(value)
  )
}

function isHomeRelativeFilePath(value: string): boolean {
  return /^~[\\/]/u.test(value)
}

function joinHomeRelativePath(homeDir: string, value: string): string {
  const trimmedHomeDir = homeDir.trim().replace(/[\\/]+$/u, '')
  const suffix = value.slice(1).replace(/^[\\/]+/u, '')
  if (!suffix) {
    return trimmedHomeDir
  }

  const separator = trimmedHomeDir.includes('\\') ? '\\' : '/'
  return `${trimmedHomeDir}${separator}${suffix.replace(/[\\/]/gu, separator)}`
}

function trimPlainFileReferenceCandidate(
  value: string,
): { fullMatch: string; target: FileReferenceTarget } | null {
  let candidate = value

  while (candidate) {
    const target = parseFileReferenceTarget(candidate)
    if (target && looksLikeFileReferencePath(target.path)) {
      return {
        fullMatch: candidate,
        target,
      }
    }

    const trimmedCandidate = candidate.replace(TRAILING_PUNCTUATION_PATTERN, '')
    if (trimmedCandidate === candidate) {
      break
    }

    candidate = trimmedCandidate
  }

  return null
}

function looksLikeFileReferencePath(value: string): boolean {
  const normalized = value.replace(/[\\/]+$/u, '')
  const basename = normalized.split(/[\\/]/u).at(-1) ?? ''
  if (!basename || basename === '.' || basename === '..') {
    return false
  }

  if (basename.startsWith('.')) {
    return basename.length > 1 && !basename.endsWith('.')
  }

  const extensionSeparatorIndex = basename.lastIndexOf('.')
  return (
    extensionSeparatorIndex > 0 &&
    extensionSeparatorIndex < basename.length - 1
  )
}

function overlapsExistingMatch(
  startIndex: number,
  endIndex: number,
  matches: Array<Pick<MarkdownFileReferenceMatch, 'startIndex' | 'endIndex'>>,
): boolean {
  return matches.some(
    (match) => startIndex < match.endIndex && endIndex > match.startIndex,
  )
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  return Number.parseInt(value, 10)
}
