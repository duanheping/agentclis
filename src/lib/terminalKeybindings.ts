interface TerminalShortcutKeyboardEvent {
  key: string
  type: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function getTerminalShortcutInput(
  event: TerminalShortcutKeyboardEvent,
): string | null {
  if (event.type !== 'keydown') {
    return null
  }

  if (event.key !== 'Enter') {
    return null
  }

  if (event.altKey || event.metaKey) {
    return null
  }

  if (!event.ctrlKey && !event.shiftKey) {
    return null
  }

  // Codex CLI uses Ctrl+J/LF for "insert newline". xterm collapses modified
  // Enter to CR on Windows, so we translate it here before it reaches xterm.
  return '\n'
}
