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
  terminal: TerminalPasteBinding,
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

  for (const target of targets) {
    target.addEventListener('paste', handlePaste, { capture: true })
  }

  return () => {
    for (const target of targets) {
      target.removeEventListener('paste', handlePaste, { capture: true })
    }
  }
}
