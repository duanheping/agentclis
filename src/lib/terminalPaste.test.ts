import { describe, expect, it, vi } from 'vitest'

import {
  attachPlainTextPasteHandler,
  extractClipboardText,
  hasBinaryClipboardPayload,
} from './terminalPaste'

interface ClipboardStub {
  getData: (type: string) => string
  items?: ArrayLike<{ kind: string; type: string }>
  types?: ArrayLike<string>
}

function createClipboardData(data: {
  plainText?: string
  html?: string
  uriList?: string
  items?: ArrayLike<{ kind: string; type: string }>
  types?: ArrayLike<string>
}): ClipboardStub {
  return {
    getData: (type: string) => {
      if (type === 'text/plain') {
        return data.plainText ?? ''
      }

      if (type === 'text/html') {
        return data.html ?? ''
      }

      if (type === 'text/uri-list') {
        return data.uriList ?? ''
      }

      return ''
    },
    items: data.items,
    types: data.types,
  }
}

describe('extractClipboardText', () => {
  it('prefers plain text when available', () => {
    const clipboardData = createClipboardData({
      plainText: 'copied text',
      html: '<strong>ignored</strong>',
    })

    expect(extractClipboardText(clipboardData)).toBe('copied text')
  })

  it('falls back to html text when plain text is missing', () => {
    const clipboardData = createClipboardData({
      html: '<div>line one</div><div>line two</div>',
    })

    expect(extractClipboardText(clipboardData)).toContain('line one')
    expect(extractClipboardText(clipboardData)).toContain('line two')
  })
})

describe('hasBinaryClipboardPayload', () => {
  it('detects image clipboard items', () => {
    const clipboardData = createClipboardData({
      items: [{ kind: 'file', type: 'image/png' }],
    })

    expect(hasBinaryClipboardPayload(clipboardData)).toBe(true)
  })

  it('ignores string-only clipboard items', () => {
    const clipboardData = createClipboardData({
      items: [{ kind: 'string', type: 'text/plain' }],
      types: ['text/plain'],
    })

    expect(hasBinaryClipboardPayload(clipboardData)).toBe(false)
  })
})

describe('attachPlainTextPasteHandler', () => {
  it('pastes plain text into the terminal and blocks the default event', () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const paste = vi.fn()
    const detach = attachPlainTextPasteHandler({
      element,
      textarea,
      paste,
    })

    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardData({
        plainText: 'paste me',
        items: [{ kind: 'string', type: 'text/plain' }],
        types: ['text/plain'],
      }),
    })

    textarea.dispatchEvent(pasteEvent)

    expect(paste).toHaveBeenCalledWith('paste me')
    expect(pasteEvent.defaultPrevented).toBe(true)

    detach()
  })

  it('blocks binary payloads without sending text to the terminal', () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const paste = vi.fn()
    const detach = attachPlainTextPasteHandler({
      element,
      textarea,
      paste,
    })

    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardData({
        items: [{ kind: 'file', type: 'image/png' }],
        types: ['Files'],
      }),
    })

    textarea.dispatchEvent(pasteEvent)

    expect(paste).not.toHaveBeenCalled()
    expect(pasteEvent.defaultPrevented).toBe(true)

    detach()
  })
})
