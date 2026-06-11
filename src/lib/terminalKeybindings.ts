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

  if (
    (event.key === ' ' || event.key === 'Spacebar') &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    return '\n'
  }

  if (
    (event.key === ' ' || event.key === 'Spacebar') &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    return ' '
  }

  return null
}
