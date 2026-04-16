import { describe, expect, it } from 'vitest'

import { captureTerminalSnapshot } from './terminalSnapshot'

function buildTerminal(lines: string[], cols = 120, rows = 36) {
  return {
    cols,
    rows,
    buffer: {
      normal: null,
      alternate: null,
      onBufferChange: () => ({ dispose() {} }),
      active: {
        length: lines.length,
        getLine: (index: number) => {
          const line = lines[index]
          if (line === undefined) {
            return null
          }

          return {
            translateToString: () => line,
          }
        },
      },
    },
  } as unknown as Parameters<typeof captureTerminalSnapshot>[0]
}

describe('captureTerminalSnapshot', () => {
  it('returns null when the terminal buffer is empty', () => {
    expect(captureTerminalSnapshot(buildTerminal([]))).toBeNull()
  })

  it('captures terminal lines with session metadata', () => {
    const snapshot = captureTerminalSnapshot(
      buildTerminal(['line-1', 'line-2', 'line-3'], 100, 30),
      {
        capturedAt: '2026-04-15T20:30:00.000Z',
      },
    )

    expect(snapshot).toEqual({
      text: 'line-1\r\nline-2\r\nline-3',
      lineCount: 3,
      cols: 100,
      rows: 30,
      capturedAt: '2026-04-15T20:30:00.000Z',
    })
  })

  it('keeps only the newest lines within the configured line cap', () => {
    const snapshot = captureTerminalSnapshot(
      buildTerminal(['line-1', 'line-2', 'line-3', 'line-4']),
      {
        maxLines: 2,
      },
    )

    expect(snapshot?.text).toBe('line-3\r\nline-4')
    expect(snapshot?.lineCount).toBe(2)
  })

  it('caps the snapshot by byte size', () => {
    const snapshot = captureTerminalSnapshot(
      buildTerminal(['aaaa', 'bbbb', 'cccc']),
      {
        maxBytes: 10,
      },
    )

    expect(snapshot?.text).toBe('bbbb\r\ncccc')
    expect(snapshot?.lineCount).toBe(2)
  })
})
