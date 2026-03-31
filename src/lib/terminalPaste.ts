import type { Terminal } from '@xterm/xterm'

interface ClipboardItemLike {
  kind: string
  type: string
  getAsFile?: () => File | null
}

interface ClipboardDataLike {
  getData(type: string): string
  items?: ArrayLike<ClipboardItemLike>
  types?: ArrayLike<string>
}

interface ClipboardReadItemLike {
  types: ArrayLike<string>
  getType(type: string): Promise<Blob>
}

interface TransferDataLike extends ClipboardDataLike {
  files?: ArrayLike<File>
}

type TerminalPasteBinding = Pick<Terminal, 'element' | 'textarea' | 'paste'>
type TerminalClipboardBinding = TerminalPasteBinding &
  Pick<Terminal, 'getSelection' | 'hasSelection'>
type FilePathResolver = (file: File) => string | null | undefined
type FilePathPersistor = (file: File) => Promise<string | null | undefined>

const FILE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

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

function getClipboardBinding() {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard
}

async function readClipboardText(): Promise<string | null> {
  const clipboard = getClipboardBinding()
  if (!clipboard?.readText) {
    return null
  }

  try {
    const text = await clipboard.readText()
    return text || null
  } catch {
    return null
  }
}

function buildClipboardFileName(type: string): string {
  const normalizedType = type.trim().toLowerCase()
  return `clipboard${FILE_EXTENSION_BY_MIME[normalizedType] ?? ''}`
}

async function readClipboardFiles(): Promise<File[]> {
  const clipboard = getClipboardBinding()
  if (!clipboard?.read) {
    return []
  }

  try {
    const items = await clipboard.read()
    const files: File[] = []

    for (const item of items as ClipboardReadItemLike[]) {
      const candidateTypes = Array.from(item.types ?? []).filter((type) => {
        return !type.toLowerCase().startsWith('text/')
      })
      const fileType =
        candidateTypes.find((type) => type.toLowerCase().startsWith('image/')) ??
        candidateTypes[0]

      if (!fileType) {
        continue
      }

      const blob = await item.getType(fileType)
      const normalizedType = blob.type || fileType
      files.push(
        new File([blob], buildClipboardFileName(normalizedType), {
          type: normalizedType,
          lastModified: Date.now(),
        }),
      )
    }

    return files
  } catch {
    return []
  }
}

function writeClipboardText(text: string): void {
  const clipboard = getClipboardBinding()
  if (!clipboard?.writeText) {
    return
  }

  void clipboard.writeText(text).catch(() => {})
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

export function hasFileTransferPayload(
  transferData: TransferDataLike | null | undefined,
): boolean {
  if (!transferData) {
    return false
  }

  if ((transferData.files?.length ?? 0) > 0) {
    return true
  }

  const items = Array.from(transferData.items ?? [])
  if (items.some((item) => item.kind === 'file')) {
    return true
  }

  return Array.from(transferData.types ?? []).some(
    (type) => type.toLowerCase() === 'files',
  )
}

function extractTransferFiles(
  transferData: TransferDataLike | null | undefined,
): File[] {
  if (!transferData) {
    return []
  }

  const directFiles = Array.from(transferData.files ?? [])
  if (directFiles.length > 0) {
    return directFiles
  }

  return Array.from(transferData.items ?? [])
    .map((item) => item.getAsFile?.() ?? null)
    .filter((file): file is File => file instanceof File)
}

async function resolveFilePaths(
  files: ArrayLike<File>,
  resolveFilePath: FilePathResolver | null | undefined,
  persistFile: FilePathPersistor | null | undefined,
): Promise<string[]> {
  const resolvedPaths = await Promise.all(
    Array.from(files).map(async (file) => {
      const filePath = resolveFilePath?.(file)?.trim()
      if (filePath) {
        return filePath
      }

      const persistedPath = (await persistFile?.(file))?.trim()
      return persistedPath || ''
    }),
  )

  return resolvedPaths.filter((filePath) => filePath.length > 0)
}

export function extractDroppedFilePaths(
  transferData: TransferDataLike | null | undefined,
  resolveFilePath: FilePathResolver | null | undefined,
): string[] {
  if (!transferData || !resolveFilePath) {
    return []
  }

  return extractTransferFiles(transferData)
    .map((file) => resolveFilePath(file)?.trim() ?? '')
    .filter((path) => path.length > 0)
}

export function formatDroppedFilePaths(paths: ArrayLike<string>): string {
  return Array.from(paths)
    .map((path) => `"${path.replaceAll('"', '\\"')}"`)
    .join(' ')
}

export function attachPlainTextPasteHandler(
  terminal: TerminalClipboardBinding,
  options: {
    resolveFilePath?: FilePathResolver
    persistFile?: FilePathPersistor
  } = {},
): () => void {
  const { resolveFilePath, persistFile } = options
  const targets = [terminal.element, terminal.textarea].filter(
    (target): target is HTMLElement => target instanceof HTMLElement,
  )

  if (targets.length === 0) {
    return () => {}
  }

  // Token tracking for async paste/drop operations. Any new paste, drop,
  // or non-paste keystroke invalidates the current token so that a slow
  // clipboard read or file-persist IPC cannot paste into the terminal
  // after the user has already moved on (e.g. pressed Enter to submit).
  let activePasteToken: object | null = null

  function invalidatePasteToken(): void {
    activePasteToken = null
  }

  function createPasteToken(): object {
    const token = {}
    activePasteToken = token
    return token
  }

  function isPasteTokenValid(token: object): boolean {
    return activePasteToken === token
  }

  const handlePaste = (event: Event) => {
    const pasteEvent = event as ClipboardEvent
    invalidatePasteToken()
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
      const token = createPasteToken()
      void resolveFilePaths(
        extractTransferFiles(pasteEvent.clipboardData),
        resolveFilePath,
        persistFile,
      )
        .then((filePaths) => {
          if (isPasteTokenValid(token) && filePaths.length > 0) {
            terminal.paste(formatDroppedFilePaths(filePaths))
          }
        })
        .catch(() => {})
    }
  }

  const handleDragOver = (event: Event) => {
    const dragEvent = event as DragEvent
    if (!hasFileTransferPayload(dragEvent.dataTransfer)) {
      return
    }

    dragEvent.preventDefault()
    dragEvent.stopPropagation()
    if (dragEvent.dataTransfer) {
      dragEvent.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = (event: Event) => {
    const dragEvent = event as DragEvent
    invalidatePasteToken()
    if (hasFileTransferPayload(dragEvent.dataTransfer)) {
      dragEvent.preventDefault()
      dragEvent.stopPropagation()
      const token = createPasteToken()
      void resolveFilePaths(
        extractTransferFiles(dragEvent.dataTransfer),
        resolveFilePath,
        persistFile,
      )
        .then((filePaths) => {
          if (isPasteTokenValid(token) && filePaths.length > 0) {
            terminal.paste(formatDroppedFilePaths(filePaths))
          }
        })
        .catch(() => {})
      return
    }

    const text = extractClipboardText(dragEvent.dataTransfer)
    if (text !== null) {
      dragEvent.preventDefault()
      dragEvent.stopPropagation()
      terminal.paste(text)
      return
    }

    if (hasBinaryClipboardPayload(dragEvent.dataTransfer)) {
      dragEvent.preventDefault()
      dragEvent.stopPropagation()
    }
  }

  const handleKeyDown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent

    if (isCopyShortcut(keyboardEvent)) {
      invalidatePasteToken()
      if (!terminal.hasSelection()) {
        return
      }

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
      // Any non-paste keystroke invalidates pending async paste operations
      // so a slow clipboard read cannot paste after the user moved on.
      invalidatePasteToken()
      return
    }

    keyboardEvent.preventDefault()
    keyboardEvent.stopPropagation()

    const token = createPasteToken()

    void (async () => {
      const text = await readClipboardText()
      if (!isPasteTokenValid(token)) return

      if (text !== null) {
        terminal.paste(text)
        return
      }

      const clipboardFiles = await readClipboardFiles()
      if (!isPasteTokenValid(token)) return
      if (clipboardFiles.length === 0) {
        return
      }

      const filePaths = await resolveFilePaths(
        clipboardFiles,
        resolveFilePath,
        persistFile,
      )
      if (!isPasteTokenValid(token)) return
      if (filePaths.length > 0) {
        terminal.paste(formatDroppedFilePaths(filePaths))
      }
    })()
  }

  for (const target of targets) {
    target.addEventListener('paste', handlePaste, { capture: true })
    target.addEventListener('dragover', handleDragOver, { capture: true })
    target.addEventListener('drop', handleDrop, { capture: true })
    target.addEventListener('keydown', handleKeyDown, { capture: true })
  }

  return () => {
    for (const target of targets) {
      target.removeEventListener('paste', handlePaste, { capture: true })
      target.removeEventListener('dragover', handleDragOver, { capture: true })
      target.removeEventListener('drop', handleDrop, { capture: true })
      target.removeEventListener('keydown', handleKeyDown, { capture: true })
    }
  }
}
