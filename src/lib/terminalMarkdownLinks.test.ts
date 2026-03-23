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
      activate: (...args: unknown[]) => void
    }> = []

    provider.provideLinks(2, (value) => {
      links = (value ?? []) as unknown as typeof links
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('[main.c](C:/repo/src/main.c#L42)')
    expect(links[0]?.range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 11, y: 2 },
    })

    links[0]?.activate(undefined, links[0]?.text)
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
      activate: (...args: unknown[]) => void
    }> = []

    provider.provideLinks(1, (value) => {
      links = (value ?? []) as unknown as typeof links
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('~\\Downloads\\ECG2_Callout_Logic_Analysis.md')
    expect(links[0]?.range).toEqual({
      start: { x: 6, y: 1 },
      end: { x: 47, y: 1 },
    })

    links[0]?.activate(undefined, links[0]?.text)
    expect(onActivate).toHaveBeenCalledWith(
      '~\\Downloads\\ECG2_Callout_Logic_Analysis.md',
    )
  })

  it('returns clickable plain web links that span wrapped lines', () => {
    const onActivateFile = vi.fn()
    const onActivateExternal = vi.fn()
    const provider = createMarkdownFileLinkProvider(
      createTerminalBuffer([
        { text: 'Open https://github.com/duanheping/' },
        { text: 'agentclis/pull/123 now', isWrapped: true },
      ]),
      onActivateFile,
      onActivateExternal,
    )

    let links: Array<{
      text: string
      range: {
        start: { x: number; y: number }
        end: { x: number; y: number }
      }
      activate: (...args: unknown[]) => void
    }> = []

    provider.provideLinks(2, (value) => {
      links = (value ?? []) as unknown as typeof links
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('https://github.com/duanheping/agentclis/pull/123')

    links[0]?.activate(undefined, links[0]?.text)
    expect(onActivateFile).not.toHaveBeenCalled()
    expect(onActivateExternal).toHaveBeenCalledWith(
      'https://github.com/duanheping/agentclis/pull/123',
    )
  })

  it('returns clickable markdown web links', () => {
    const onActivateFile = vi.fn()
    const onActivateExternal = vi.fn()
    const provider = createMarkdownFileLinkProvider(
      createTerminalBuffer([
        { text: 'See [PR link](https://github.com/duanheping/agentclis/pull/123)' },
      ]),
      onActivateFile,
      onActivateExternal,
    )

    let links: Array<{
      text: string
      activate: (...args: unknown[]) => void
    }> = []

    provider.provideLinks(1, (value) => {
      links = (value ?? []) as unknown as typeof links
    })

    expect(links).toHaveLength(1)
    expect(links[0]?.text).toBe('[PR link](https://github.com/duanheping/agentclis/pull/123)')

    links[0]?.activate(undefined, links[0]?.text)
    expect(onActivateExternal).toHaveBeenCalledWith(
      'https://github.com/duanheping/agentclis/pull/123',
    )
  })
})
