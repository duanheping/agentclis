import type { IBuffer, ILink, ILinkProvider, Terminal } from '@xterm/xterm'

import { findExternalLinks } from '../shared/externalLinks'
import { findFileReferences } from '../shared/fileReferences'

interface WrappedLineSegment {
  bufferLineNumber: number
  text: string
}

interface WrappedLineMatchContext {
  text: string
  segments: WrappedLineSegment[]
}

export function createMarkdownFileLinkProvider(
  terminal: Pick<Terminal, 'buffer'>,
  onActivate: (target: string) => void,
  onActivateExternal?: (target: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const context = readWrappedLineContext(terminal.buffer.active, bufferLineNumber)
      if (!context) {
        callback(undefined)
        return
      }

      const links = [
        ...findFileReferences(context.text).map((match) => ({
          fullMatch: match.fullMatch,
          startIndex: match.startIndex,
          endIndex: match.endIndex,
          activate: () => onActivate(match.target.raw),
        })),
        ...findExternalLinks(context.text).map((match) => ({
          fullMatch: match.fullMatch,
          startIndex: match.startIndex,
          endIndex: match.endIndex,
          activate: () => (onActivateExternal ?? onActivate)(match.target.raw),
        })),
      ]
        .sort((left, right) => left.startIndex - right.startIndex)
        .map((match) => {
          const start = mapOffsetToBufferPosition(context.segments, match.startIndex)
          const end = mapOffsetToBufferPosition(context.segments, match.endIndex - 1)
          if (!start || !end) {
            return null
          }

          const link: ILink = {
            range: {
              start,
              end,
            },
            text: match.fullMatch,
            activate: match.activate,
            decorations: {
              pointerCursor: true,
              underline: true,
            },
          }

          return link
        })
        .filter((link): link is ILink => link !== null)

      callback(links.length > 0 ? links : undefined)
    },
  }
}

function readWrappedLineContext(
  buffer: IBuffer,
  bufferLineNumber: number,
): WrappedLineMatchContext | null {
  const startLineIndex = findWrappedLineStart(buffer, bufferLineNumber - 1)
  const segments: WrappedLineSegment[] = []

  for (
    let lineIndex = startLineIndex;
    lineIndex < buffer.length;
    lineIndex += 1
  ) {
    const line = buffer.getLine(lineIndex)
    if (!line) {
      break
    }

    segments.push({
      bufferLineNumber: lineIndex + 1,
      text: line.translateToString(true),
    })

    const nextLine = buffer.getLine(lineIndex + 1)
    if (!nextLine?.isWrapped) {
      break
    }
  }

  const text = segments.map((segment) => segment.text).join('')
  if (!text) {
    return null
  }

  return { text, segments }
}

function findWrappedLineStart(buffer: IBuffer, lineIndex: number): number {
  let currentLineIndex = Math.max(0, lineIndex)

  while (currentLineIndex > 0 && buffer.getLine(currentLineIndex)?.isWrapped) {
    currentLineIndex -= 1
  }

  return currentLineIndex
}

function mapOffsetToBufferPosition(
  segments: WrappedLineSegment[],
  offset: number,
): { x: number; y: number } | null {
  if (offset < 0) {
    return null
  }

  let remaining = offset
  for (const segment of segments) {
    if (remaining < segment.text.length) {
      return {
        x: remaining + 1,
        y: segment.bufferLineNumber,
      }
    }

    remaining -= segment.text.length
  }

  return null
}
