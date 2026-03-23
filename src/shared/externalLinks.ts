export interface ExternalLinkTarget {
  raw: string
  url: string
}

export interface MarkdownExternalLinkMatch {
  fullMatch: string
  label: string
  href: string
  startIndex: number
  endIndex: number
  target: ExternalLinkTarget
}

export interface PlainExternalLinkMatch {
  fullMatch: string
  startIndex: number
  endIndex: number
  target: ExternalLinkTarget
}

export type ExternalLinkMatch =
  | MarkdownExternalLinkMatch
  | PlainExternalLinkMatch

const MARKDOWN_EXTERNAL_LINK_PATTERN = /\[([^\]\r\n]+)\]\((https?:\/\/[^)\r\n]+)\)/giu
const PLAIN_EXTERNAL_LINK_PATTERN =
  /(?:^|[\s([{"'])((?:https?:\/\/)\S*)/giu
const TRAILING_EXTERNAL_PUNCTUATION_PATTERN = /[)\]}>,.;!?'"`]+$/u

export function parseExternalLinkTarget(value: string): ExternalLinkTarget | null {
  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  try {
    const url = new URL(normalized)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }

    return {
      raw: normalized,
      url: url.toString(),
    }
  } catch {
    return null
  }
}

export function findMarkdownExternalLinks(text: string): MarkdownExternalLinkMatch[] {
  const matches: MarkdownExternalLinkMatch[] = []

  for (const match of text.matchAll(MARKDOWN_EXTERNAL_LINK_PATTERN)) {
    const fullMatch = match[0]
    const label = match[1]
    const href = match[2]
    const startIndex = match.index ?? -1
    if (startIndex < 0 || !fullMatch || !label || !href) {
      continue
    }

    const target = parseExternalLinkTarget(href)
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

export function findPlainExternalLinks(text: string): PlainExternalLinkMatch[] {
  const markdownMatches = findMarkdownExternalLinks(text)
  const matches: PlainExternalLinkMatch[] = []

  for (const match of text.matchAll(PLAIN_EXTERNAL_LINK_PATTERN)) {
    const fullMatch = match[0]
    const candidate = match[1]
    const startIndex = match.index ?? -1
    if (startIndex < 0 || !candidate || !fullMatch) {
      continue
    }

    const candidateStartIndex = startIndex + fullMatch.length - candidate.length
    const trimmed = trimPlainExternalLinkCandidate(candidate)
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

export function findExternalLinks(text: string): ExternalLinkMatch[] {
  const markdownMatches = findMarkdownExternalLinks(text)
  const plainMatches = findPlainExternalLinks(text)

  return [...markdownMatches, ...plainMatches].sort(
    (left, right) => left.startIndex - right.startIndex,
  )
}

function trimPlainExternalLinkCandidate(
  value: string,
): { fullMatch: string; target: ExternalLinkTarget } | null {
  let candidate = value

  while (candidate) {
    const parseCandidate = candidate.replace(TRAILING_EXTERNAL_PUNCTUATION_PATTERN, '')
    const target = parseExternalLinkTarget(parseCandidate || candidate)
    if (target) {
      return {
        fullMatch: parseCandidate || candidate,
        target,
      }
    }

    const trimmedCandidate = parseCandidate
    if (trimmedCandidate === candidate) {
      break
    }

    candidate = trimmedCandidate
  }

  return null
}

function overlapsExistingMatch(
  startIndex: number,
  endIndex: number,
  matches: Array<Pick<MarkdownExternalLinkMatch, 'startIndex' | 'endIndex'>>,
): boolean {
  return matches.some(
    (match) => startIndex < match.endIndex && endIndex > match.startIndex,
  )
}
