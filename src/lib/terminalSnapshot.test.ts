import { describe, expect, it, vi } from 'vitest'

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
    expect(captureTerminalSnapshot(buildTerminal([]), null)).toBeNull()
  })

  it('captures terminal lines and serialized state with session metadata', () => {
    const serializer = {
      serialize: vi.fn(() => '\u001b[2Jserialized'),
    }
    const snapshot = captureTerminalSnapshot(
      buildTerminal(['line-1', 'line-2', 'line-3'], 100, 30),
      serializer,
      {
        capturedAt: '2026-04-15T20:30:00.000Z',
      },
    )

    expect(snapshot).toEqual({
      text: 'line-1\r\nline-2\r\nline-3',
      serialized: '\u001b[2Jserialized',
      lineCount: 3,
      cols: 100,
      rows: 30,
      capturedAt: '2026-04-15T20:30:00.000Z',
    })
    expect(serializer.serialize).toHaveBeenCalledWith({
      scrollback: 0,
      excludeAltBuffer: false,
      excludeModes: false,
    })
  })

  it('keeps only the newest lines within the configured line cap', () => {
    const snapshot = captureTerminalSnapshot(
      buildTerminal(['line-1', 'line-2', 'line-3', 'line-4']),
      null,
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
      null,
      {
        maxTextBytes: 10,
      },
    )

    expect(snapshot?.text).toBe('bbbb\r\ncccc')
    expect(snapshot?.lineCount).toBe(2)
  })

  it('reduces serialized scrollback to stay within the configured byte limit', () => {
    const serializer = {
      serialize: vi.fn(({ scrollback = 0 }: { scrollback?: number }) =>
        `lines:${scrollback + 4}:${'x'.repeat((scrollback + 4) * 8)}`,
      ),
    }

    const snapshot = captureTerminalSnapshot(
      buildTerminal(
        ['line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6'],
        120,
        4,
      ),
      serializer,
      {
        maxLines: 6,
        maxSerializedBytes: 50,
      },
    )

    expect(snapshot?.serialized).toBe(
      'lines:5:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    )
  })
})
