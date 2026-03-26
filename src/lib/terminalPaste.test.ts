import { waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  attachPlainTextPasteHandler,
  extractClipboardText,
  extractDroppedFilePaths,
  formatDroppedFilePaths,
  hasFileTransferPayload,
  hasBinaryClipboardPayload,
} from './terminalPaste'

interface ClipboardStub {
  getData: (type: string) => string
  items?: ArrayLike<{ kind: string; type: string; getAsFile?: () => File | null }>
  types?: ArrayLike<string>
  files?: ArrayLike<File>
}

function createClipboardData(data: {
  plainText?: string
  html?: string
  uriList?: string
  items?: ArrayLike<{ kind: string; type: string; getAsFile?: () => File | null }>
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

describe('extractDroppedFilePaths', () => {
  it('resolves absolute paths from dropped files', () => {
    const droppedFile = new File(['report'], 'report.txt', {
      type: 'text/plain',
    })

    const resolveFilePath = vi
      .fn<(file: File) => string>()
      .mockReturnValue('C:\\work\\report.txt')

    expect(
      extractDroppedFilePaths(
        {
          getData: () => '',
          files: [droppedFile],
        },
        resolveFilePath,
      ),
    ).toEqual(['C:\\work\\report.txt'])
    expect(resolveFilePath).toHaveBeenCalledWith(droppedFile)
  })
})

describe('hasFileTransferPayload', () => {
  it('detects file drags from transfer types before files are populated', () => {
    expect(
      hasFileTransferPayload({
        getData: () => '',
        types: ['Files'],
      }),
    ).toBe(true)
  })
})

describe('formatDroppedFilePaths', () => {
  it('quotes each dropped file path before pasting into the terminal', () => {
    expect(
      formatDroppedFilePaths([
        'C:\\Users\\hduan10\\Documents\\My Notes\\draft.txt',
        'C:\\temp\\plain.txt',
      ]),
    ).toBe(
      '"C:\\Users\\hduan10\\Documents\\My Notes\\draft.txt" "C:\\temp\\plain.txt"',
    )
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
      hasSelection: () => false,
      getSelection: () => '',
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
      hasSelection: () => false,
      getSelection: () => '',
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

  it('persists pasted clipboard images and pastes the saved path into the terminal', async () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const pastedImage = new File(['png'], 'clipboard.png', {
      type: 'image/png',
    })
    const paste = vi.fn()
    const persistFile = vi
      .fn<(file: File) => Promise<string>>()
      .mockResolvedValue('C:\\temp\\clipboard.png')
    const detach = attachPlainTextPasteHandler(
      {
        element,
        textarea,
        paste,
        hasSelection: () => false,
        getSelection: () => '',
      },
      {
        persistFile,
      },
    )

    const pasteEvent = new Event('paste', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardData({
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => pastedImage,
          },
        ],
        types: ['Files'],
      }),
    })

    textarea.dispatchEvent(pasteEvent)
    await waitFor(() => {
      expect(persistFile).toHaveBeenCalledWith(pastedImage)
      expect(paste).toHaveBeenCalledWith('"C:\\temp\\clipboard.png"')
    })
    expect(pasteEvent.defaultPrevented).toBe(true)

    detach()
  })

  it('pastes dropped file paths into the terminal', async () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const droppedFile = new File(['report'], 'report.txt', {
      type: 'text/plain',
    })

    const paste = vi.fn()
    const detach = attachPlainTextPasteHandler(
      {
        element,
        textarea,
        paste,
        hasSelection: () => false,
        getSelection: () => '',
      },
      {
        resolveFilePath: () => 'C:\\work\\report.txt',
      },
    )

    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: {
        getData: () => '',
        files: [droppedFile],
        items: [{ kind: 'file', type: 'text/plain' }],
        types: ['Files'],
      } satisfies ClipboardStub,
    })

    textarea.dispatchEvent(dropEvent)
    await waitFor(() => {
      expect(paste).toHaveBeenCalledWith('"C:\\work\\report.txt"')
    })
    expect(dropEvent.defaultPrevented).toBe(true)

    detach()
  })

  it('accepts a file drag on dragover when only the Files type is present', () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const detach = attachPlainTextPasteHandler({
      element,
      textarea,
      paste: vi.fn(),
      hasSelection: () => false,
      getSelection: () => '',
    })

    const dragOverEvent = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(dragOverEvent, 'dataTransfer', {
      value: {
        getData: () => '',
        files: [],
        items: [],
        types: ['Files'],
        dropEffect: 'none',
      } satisfies ClipboardStub & { dropEffect: string },
    })

    textarea.dispatchEvent(dragOverEvent)

    expect(dragOverEvent.defaultPrevented).toBe(true)
    expect(
      (dragOverEvent as DragEvent).dataTransfer?.dropEffect,
    ).toBe('copy')

    detach()
  })

  it('copies the selected terminal text on Ctrl+C without sending input', async () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText,
      },
    })

    const paste = vi.fn()
    const detach = attachPlainTextPasteHandler({
      element,
      textarea,
      paste,
      hasSelection: () => true,
      getSelection: () => 'copied line',
    })

    const keydownEvent = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })

    textarea.dispatchEvent(keydownEvent)
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('copied line')
    expect(paste).not.toHaveBeenCalled()
    expect(keydownEvent.defaultPrevented).toBe(true)

    detach()
  })

  it('pastes clipboard text on Ctrl+V', async () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const readText = vi.fn().mockResolvedValue('clipboard text')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText,
      },
    })

    const paste = vi.fn()
    const detach = attachPlainTextPasteHandler({
      element,
      textarea,
      paste,
      hasSelection: () => false,
      getSelection: () => '',
    })

    const keydownEvent = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })

    textarea.dispatchEvent(keydownEvent)
    await Promise.resolve()
    await Promise.resolve()

    expect(readText).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledWith('clipboard text')
    expect(keydownEvent.defaultPrevented).toBe(true)

    detach()
  })

  it('pastes clipboard image paths on Ctrl+V when Clipboard.read is available', async () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const readText = vi.fn().mockResolvedValue('')
    const read = vi.fn().mockResolvedValue([
      {
        types: ['image/png'],
        getType: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
      },
    ])
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText,
        read,
      },
    })

    const paste = vi.fn()
    const persistFile = vi
      .fn<(file: File) => Promise<string>>()
      .mockResolvedValue('C:\\temp\\clipboard.png')
    const detach = attachPlainTextPasteHandler(
      {
        element,
        textarea,
        paste,
        hasSelection: () => false,
        getSelection: () => '',
      },
      {
        persistFile,
      },
    )

    const keydownEvent = new KeyboardEvent('keydown', {
      key: 'v',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })

    textarea.dispatchEvent(keydownEvent)
    await waitFor(() => {
      expect(readText).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledTimes(1)
      expect(persistFile).toHaveBeenCalledTimes(1)
      expect(paste).toHaveBeenCalledWith('"C:\\temp\\clipboard.png"')
    })
    expect(keydownEvent.defaultPrevented).toBe(true)

    detach()
  })
})

describe('terminalPaste edge cases', () => {
  it('formatDroppedFilePaths escapes double quotes in paths', () => {
    expect(formatDroppedFilePaths(['C:\\path with "quotes"\\file.txt']))
      .toBe('"C:\\path with \\"quotes\\"\\file.txt"')
  })

  it('formatDroppedFilePaths handles empty array', () => {
    expect(formatDroppedFilePaths([])).toBe('')
  })

  it('formatDroppedFilePaths joins multiple paths with spaces', () => {
    expect(formatDroppedFilePaths(['C:\\a.txt', 'C:\\b.txt']))
      .toBe('"C:\\a.txt" "C:\\b.txt"')
  })

  it('extractClipboardText returns null for null/undefined clipboard', () => {
    expect(extractClipboardText(null)).toBeNull()
    expect(extractClipboardText(undefined)).toBeNull()
  })

  it('extractClipboardText prefers plain text over HTML', () => {
    const data = createClipboardData({
      plainText: 'plain',
      html: '<b>html</b>',
    })
    expect(extractClipboardText(data as ClipboardStub)).toBe('plain')
  })

  it('extractClipboardText falls back to uri-list', () => {
    const data = createClipboardData({
      uriList: 'https://example.com',
    })
    expect(extractClipboardText(data as ClipboardStub)).toBe('https://example.com')
  })

  it('extractClipboardText returns null when all fields empty', () => {
    const data = createClipboardData({})
    expect(extractClipboardText(data as ClipboardStub)).toBeNull()
  })

  it('hasBinaryClipboardPayload returns false for null', () => {
    expect(hasBinaryClipboardPayload(null)).toBe(false)
    expect(hasBinaryClipboardPayload(undefined)).toBe(false)
  })

  it('hasBinaryClipboardPayload detects image type in types array', () => {
    const data = createClipboardData({
      types: ['image/png'],
    })
    expect(hasBinaryClipboardPayload(data as ClipboardStub)).toBe(true)
  })

  it('hasBinaryClipboardPayload detects Files type', () => {
    const data = createClipboardData({
      types: ['Files'],
    })
    expect(hasBinaryClipboardPayload(data as ClipboardStub)).toBe(true)
  })

  it('hasFileTransferPayload returns false for null', () => {
    expect(hasFileTransferPayload(null)).toBe(false)
    expect(hasFileTransferPayload(undefined)).toBe(false)
  })

  it('hasFileTransferPayload detects files array', () => {
    const data = {
      ...createClipboardData({}),
      files: [new File(['data'], 'test.txt')],
    }
    expect(hasFileTransferPayload(data as ClipboardStub)).toBe(true)
  })

  it('extractDroppedFilePaths returns empty for null inputs', () => {
    expect(extractDroppedFilePaths(null, null)).toEqual([])
    expect(extractDroppedFilePaths(undefined, undefined)).toEqual([])
  })

  it('extractDroppedFilePaths filters empty resolved paths', () => {
    const file = new File(['data'], 'test.txt')
    const data = {
      ...createClipboardData({}),
      files: [file],
    }
    const resolver = () => ''
    expect(extractDroppedFilePaths(data as ClipboardStub, resolver)).toEqual([])
  })

  it('extractDroppedFilePaths resolves file paths', () => {
    const file = new File(['data'], 'test.txt')
    const data = {
      ...createClipboardData({}),
      files: [file],
    }
    const resolver = () => 'C:\\resolved\\test.txt'
    expect(extractDroppedFilePaths(data as ClipboardStub, resolver)).toEqual(['C:\\resolved\\test.txt'])
  })

  it('detach function removes all event listeners', () => {
    const element = document.createElement('div')
    const textarea = document.createElement('textarea')
    element.append(textarea)

    const paste = vi.fn()
    const detach = attachPlainTextPasteHandler({
      element,
      textarea,
      paste,
      hasSelection: () => false,
      getSelection: () => '',
    })

    detach()

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardData({ plainText: 'should not paste' }),
    })
    textarea.dispatchEvent(pasteEvent)
    expect(paste).not.toHaveBeenCalled()
  })

  it('attachPlainTextPasteHandler returns no-op when no elements', () => {
    const detach = attachPlainTextPasteHandler({
      element: null as unknown as HTMLElement,
      textarea: null as unknown as HTMLTextAreaElement,
      paste: vi.fn(),
      hasSelection: () => false,
      getSelection: () => '',
    })
    expect(detach).toBeInstanceOf(Function)
    detach()
  })
})
