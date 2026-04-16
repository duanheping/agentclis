import type { Terminal } from '@xterm/xterm'

import type { UpdateSessionTerminalSnapshotInput } from '../shared/ipc'

const DEFAULT_MAX_LINES = 12_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const UTF8_ENCODER = new TextEncoder()

type SnapshotPayload = Omit<UpdateSessionTerminalSnapshotInput, 'sessionId'>

export interface CaptureTerminalSnapshotOptions {
  capturedAt?: string
  maxLines?: number
  maxBytes?: number
}

export function captureTerminalSnapshot(
  terminal: Pick<Terminal, 'buffer' | 'cols' | 'rows'>,
  options: CaptureTerminalSnapshotOptions = {},
): SnapshotPayload | null {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES)
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES)
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

    if (selectedLines.length > 0 && byteCount + lineBytes > maxBytes) {
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

  return {
    text,
    lineCount: selectedLines.length,
    cols: terminal.cols,
    rows: terminal.rows,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
  }
}
