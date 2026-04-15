import { describe, expect, it } from 'vitest'
import {
  hasVisibleTerminalContent,
  isPureTerminalClearChunk,
  stripScrollbackClear,
} from './terminalEscapeFilter'

describe('stripScrollbackClear', () => {
  it('returns chunk unchanged when no ESC[3J is present', () => {
    const plain = 'hello world'
    expect(stripScrollbackClear(plain)).toBe(plain)
  })

  it('strips standalone ESC[3J', () => {
    expect(stripScrollbackClear('\x1b[3J')).toBe('')
  })

  it('strips ESC[3J from within a chunk', () => {
    const input = 'before\x1b[3Jafter'
    expect(stripScrollbackClear(input)).toBe('beforeafter')
  })

  it('strips multiple ESC[3J occurrences', () => {
    const input = '\x1b[3Jhello\x1b[3Jworld\x1b[3J'
    expect(stripScrollbackClear(input)).toBe('helloworld')
  })

  it('preserves ESC[2J (clear screen)', () => {
    const input = '\x1b[2J\x1b[3J'
    expect(stripScrollbackClear(input)).toBe('\x1b[2J')
  })

  it('preserves ESC[H and other cursor sequences', () => {
    const input = '\x1b[H\x1b[2J\x1b[3Jcontent'
    expect(stripScrollbackClear(input)).toBe('\x1b[H\x1b[2Jcontent')
  })

  it('handles empty string', () => {
    expect(stripScrollbackClear('')).toBe('')
  })

  it('detects visible terminal content after stripping control sequences', () => {
    expect(
      hasVisibleTerminalContent(
        '\x1b[2m╭────────────────────╮\x1b[22m\r\n│ OpenAI Codex │',
      ),
    ).toBe(true)
  })

  it('treats shell clear chunks without visible text as pure clear operations', () => {
    expect(
      isPureTerminalClearChunk(
        '\x1b[?2004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;pwsh\x07\x1b[?25h',
      ),
    ).toBe(true)
  })

  it('does not treat redraw chunks with visible text as pure clear operations', () => {
    expect(
      isPureTerminalClearChunk(
        '\x1b[2J\x1b[H\x1b[2m╭────────────────────╮\x1b[22m\r\n│ OpenAI Codex │',
      ),
    ).toBe(false)
  })
})
