import type { Terminal } from '@xterm/xterm'
import type { SerializeAddon } from '@xterm/addon-serialize'

import type { UpdateSessionTerminalSnapshotInput } from '../shared/ipc'

const DEFAULT_MAX_LINES = 12_000
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_SERIALIZED_BYTES = 4 * 1024 * 1024
const UTF8_ENCODER = new TextEncoder()

type SnapshotPayload = Omit<UpdateSessionTerminalSnapshotInput, 'sessionId'>

export interface CaptureTerminalSnapshotOptions {
  capturedAt?: string
  maxLines?: number
  maxTextBytes?: number
  maxSerializedBytes?: number
}

export function captureTerminalSnapshot(
  terminal: Pick<Terminal, 'buffer' | 'cols' | 'rows'>,
  serializer?: Pick<SerializeAddon, 'serialize'> | null,
  options: CaptureTerminalSnapshotOptions = {},
): SnapshotPayload | null {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES)
  const maxTextBytes = Math.max(1, options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES)
  const buffer = terminal.buffer.active
  const totalLines = buffer.length
  if (totalLines < 1) {
    return null
  }

  const selectedLines: string[] = []
  let byteCount = 0
  const firstLine = Math.max(0, totalLines - maxLines)

  for (let index = totalLines - 1; index >= firstLine; index -= 1) {
    const line = buffer.getLine(index)
    if (!line) {
      continue
    }

    const translatedLine = line.translateToString(true)
    const lineBytes =
      UTF8_ENCODER.encode(translatedLine).length +
      (selectedLines.length > 0 ? 2 : 0)

    if (selectedLines.length > 0 && byteCount + lineBytes > maxTextBytes) {
      break
    }

    selectedLines.push(translatedLine)
    byteCount += lineBytes
  }

  if (selectedLines.length < 1) {
    return null
  }

  selectedLines.reverse()
  while (selectedLines.length > 1 && selectedLines[0] === '') {
    selectedLines.shift()
  }

  const text = selectedLines.join('\r\n')
  if (!text.trim()) {
    return null
  }

  const serialized = captureSerializedSnapshot(
    terminal,
    serializer,
    Math.max(selectedLines.length, terminal.rows),
    Math.max(1, options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES),
  )

  return {
    text,
    serialized,
    lineCount: selectedLines.length,
    cols: terminal.cols,
    rows: terminal.rows,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  }
}

function captureSerializedSnapshot(
  terminal: Pick<Terminal, 'buffer' | 'rows'>,
  serializer: Pick<SerializeAddon, 'serialize'> | null | undefined,
  maxLines: number,
  maxBytes: number,
): string | undefined {
  if (!serializer) {
    return undefined
  }

  const totalLines = terminal.buffer.active.length
  if (totalLines < 1) {
    return undefined
  }

  const targetLines = Math.min(totalLines, Math.max(terminal.rows, maxLines))
  const serializeAt = (lineCount: number) => {
    const scrollback = Math.max(0, lineCount - terminal.rows)
    return serializer.serialize({
      scrollback,
      excludeAltBuffer: false,
      excludeModes: false,
    })
  }

  const best = serializeAt(targetLines)
  if (!best.trim()) {
    return undefined
  }

  if (UTF8_ENCODER.encode(best).length <= maxBytes) {
    return best
  }

  let low = Math.min(terminal.rows, targetLines)
  let high = targetLines
  let bestWithinLimit: string | undefined

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = serializeAt(middle)
    if (!candidate.trim()) {
      high = middle - 1
      continue
    }

    if (UTF8_ENCODER.encode(candidate).length <= maxBytes) {
      bestWithinLimit = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return bestWithinLimit
}
