import type { Terminal } from '@xterm/xterm'

interface ClipboardItemLike {
  kind: string
  type: string
}

interface ClipboardDataLike {
  getData(type: string): string
  items?: ArrayLike<ClipboardItemLike>
  types?: ArrayLike<string>
}

type TerminalPasteBinding = Pick<Terminal, 'element' | 'textarea' | 'paste'>
type TerminalClipboardBinding = TerminalPasteBinding &
  Pick<Terminal, 'getSelection' | 'hasSelection'>

function matchesKey(
  event: KeyboardEvent,
  expected: string,
): boolean {
  return event.key.toLowerCase() === expected.toLowerCase()
}

function isPasteShortcut(event: KeyboardEvent): boolean {
  if (event.shiftKey && matchesKey(event, 'Insert')) {
    return true
  }

  const hasPrimaryModifier = event.ctrlKey || event.metaKey
  return hasPrimaryModifier && matchesKey(event, 'v')
}

function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey && matchesKey(event, 'Insert')) {
    return true
  }

  const hasPrimaryModifier = event.ctrlKey || event.metaKey
  return hasPrimaryModifier && !event.shiftKey && matchesKey(event, 'c')
}

async function readClipboardText(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    return null
  }

  try {
    const text = await navigator.clipboard.readText()
    return text || null
  } catch {
    return null
  }
}

function writeClipboardText(text: string): void {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return
  }

  void navigator.clipboard.writeText(text).catch(() => {})
}

function htmlToText(html: string): string {
  const container = document.createElement('div')
  container.innerHTML = html

  return container.innerText || container.textContent || ''
}

export function extractClipboardText(
  clipboardData: ClipboardDataLike | null | undefined,
): string | null {
  if (!clipboardData) {
    return null
  }

  const plainText = clipboardData.getData('text/plain')
  if (plainText) {
    return plainText
  }

  const html = clipboardData.getData('text/html')
  if (html) {
    const fallbackText = htmlToText(html)
    if (fallbackText) {
      return fallbackText
    }
  }

  const uriList = clipboardData.getData('text/uri-list')
  return uriList || null
}

export function hasBinaryClipboardPayload(
  clipboardData: ClipboardDataLike | null | undefined,
): boolean {
  if (!clipboardData) {
    return false
  }

  const items = Array.from(clipboardData.items ?? [])
  if (
    items.some(
      (item) => item.kind === 'file' || item.type.toLowerCase().startsWith('image/'),
    )
  ) {
    return true
  }

  return Array.from(clipboardData.types ?? []).some((type) => {
    const normalizedType = type.toLowerCase()
    return normalizedType === 'files' || normalizedType.startsWith('image/')
  })
}

export function attachPlainTextPasteHandler(
  terminal: TerminalClipboardBinding,
): () => void {
  const targets = [terminal.element, terminal.textarea].filter(
    (target): target is HTMLElement => target instanceof HTMLElement,
  )

  if (targets.length === 0) {
    return () => {}
  }

  const handlePaste = (event: Event) => {
    const pasteEvent = event as ClipboardEvent
    const text = extractClipboardText(pasteEvent.clipboardData)

    if (text !== null) {
      pasteEvent.preventDefault()
      pasteEvent.stopPropagation()
      terminal.paste(text)
      return
    }

    if (hasBinaryClipboardPayload(pasteEvent.clipboardData)) {
      pasteEvent.preventDefault()
      pasteEvent.stopPropagation()
    }
  }

  const handleKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent

    if (isCopyShortcut(keyboardEvent) && terminal.hasSelection()) {
      const selectedText = terminal.getSelection()
      if (!selectedText) {
        return
      }

      keyboardEvent.preventDefault()
      keyboardEvent.stopPropagation()
      writeClipboardText(selectedText)
      return
    }

    if (!isPasteShortcut(keyboardEvent)) {
      return
    }

    keyboardEvent.preventDefault()
    keyboardEvent.stopPropagation()

    void readClipboardText().then((text) => {
      if (text !== null) {
        terminal.paste(text)
      }
    })
  }

  for (const target of targets) {
    target.addEventListener('paste', handlePaste, { capture: true })
    target.addEventListener('keydown', handleKeyDown, { capture: true })
  }

  return () => {
    for (const target of targets) {
      target.removeEventListener('paste', handlePaste, { capture: true })
      target.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }
}
