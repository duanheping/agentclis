/**
 * Strip escape sequences that erase the terminal scrollback buffer.
 *
 * The Copilot CLI (and other TUI programs) may emit ESC[3J (ED 3 — Erase
 * Saved Lines) which wipes the scrollback buffer, preventing the user from
 * scrolling up to review earlier conversation turns.  We filter this
 * sequence out so the scrollback is preserved.
 *
 * ESC[2J (Erase Display) is intentionally kept — it clears the visible
 * screen without touching scrollback.
 */

// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK_RE = /\x1b\[3J/g
// eslint-disable-next-line no-control-regex
const CSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const OSC_ESCAPE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const CLEAR_ONLY_ESCAPE_RE = /\x1b\[(?:2J|K)/

export function stripScrollbackClear(chunk: string): string {
  if (chunk.indexOf('\x1b[3J') === -1) {
    return chunk
  }

  return chunk.replace(ERASE_SCROLLBACK_RE, '')
}

export function hasVisibleTerminalContent(chunk: string): boolean {
  if (!chunk) {
    return false
  }

  return chunk
    .replace(OSC_ESCAPE_RE, '')
    .replace(CSI_ESCAPE_RE, '')
    .replace(/\s+/g, '').length > 0
}

export function isPureTerminalClearChunk(chunk: string): boolean {
  if (!chunk || !CLEAR_ONLY_ESCAPE_RE.test(chunk)) {
    return false
  }

  return !hasVisibleTerminalContent(chunk)
}
