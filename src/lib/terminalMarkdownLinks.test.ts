import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { createMarkdownFileLinkProvider } from './terminalMarkdownLinks'

function createTerminalBuffer(lines: Array<{ text: string; isWrapped?: boolean }>) {
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (index: number) => {
          const line = lines[index]
          if (!line) {
            return undefined
          }

          return {
            isWrapped: Boolean(line.isWrapped),
            translateToString: () => line.text,
          }
        },
      },
    },
  } as unknown as Pick<Terminal, 'buffer'>
}

describe('createMarkdownFileLinkProvider', () => {
  it('returns clickable markdown file links that span wrapped lines', () => {
    const onActivate = vi.fn()
    const provider = createMarkdownFileLinkProvider(
      createTerminalBuffer([
        { text: 'See [main.c](C:/repo/src/' },
        { text: 'main.c#L42) now', isWrapped: true },
      ]),
      onActivate,
    )

    let links: Array<{
      text: string
      range: {
        start: { x: number; y: number }
        end: { x: number; y: number }
      }
      activate: () => void
    }> = []

    provider.provideLinks(2, (value) => {
      links = (value ?? []) as typeof links
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('[main.c](C:/repo/src/main.c#L42)')
    expect(links[0]?.range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 11, y: 2 },
    })

    links[0]?.activate()
    expect(onActivate).toHaveBeenCalledWith('C:/repo/src/main.c#L42')
  })

  it('returns clickable plain home-relative file links', () => {
    const onActivate = vi.fn()
    const provider = createMarkdownFileLinkProvider(
      createTerminalBuffer([
        { text: 'Show ~\\Downloads\\ECG2_Callout_Logic_Analysis.md here' },
      ]),
      onActivate,
    )

    let links: Array<{
      text: string
      range: {
        start: { x: number; y: number }
        end: { x: number; y: number }
      }
      activate: () => void
    }> = []

    provider.provideLinks(1, (value) => {
      links = (value ?? []) as typeof links
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('~\\Downloads\\ECG2_Callout_Logic_Analysis.md')
    expect(links[0]?.range).toEqual({
      start: { x: 6, y: 1 },
      end: { x: 47, y: 1 },
    })

    links[0]?.activate()
    expect(onActivate).toHaveBeenCalledWith(
      '~\\Downloads\\ECG2_Callout_Logic_Analysis.md',
    )
  })
})
