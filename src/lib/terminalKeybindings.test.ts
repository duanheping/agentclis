import { describe, expect, it } from 'vitest'

import { getTerminalShortcutInput } from './terminalKeybindings'

function createKeyboardEvent(
  patch: Partial<{
    key: string
    type: string
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    metaKey: boolean
  }> = {},
) {
  return {
    key: 'Enter',
    type: 'keydown',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...patch,
  }
}

describe('getTerminalShortcutInput', () => {
  it('maps Ctrl+Enter to a newline', () => {
    expect(
      getTerminalShortcutInput(
        createKeyboardEvent({
          ctrlKey: true,
        }),
      ),
    ).toBe('\n')
  })

  it('maps Shift+Enter to a newline', () => {
    expect(
      getTerminalShortcutInput(
        createKeyboardEvent({
          shiftKey: true,
        }),
      ),
    ).toBe('\n')
  })

  it('does not intercept plain Enter', () => {
    expect(getTerminalShortcutInput(createKeyboardEvent())).toBeNull()
  })

  it('does not intercept Alt+Enter', () => {
    expect(
      getTerminalShortcutInput(
        createKeyboardEvent({
          altKey: true,
        }),
      ),
    ).toBeNull()
  })

  it('ignores non-keydown events', () => {
    expect(
      getTerminalShortcutInput(
        createKeyboardEvent({
          ctrlKey: true,
          type: 'keyup',
        }),
      ),
    ).toBeNull()
  })
})
