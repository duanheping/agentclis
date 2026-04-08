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

export function stripScrollbackClear(chunk: string): string {
  if (chunk.indexOf('\x1b[3J') === -1) {
    return chunk
  }

  return chunk.replace(ERASE_SCROLLBACK_RE, '')
}
