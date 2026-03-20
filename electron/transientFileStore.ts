import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { PersistTransientFileInput } from '../src/shared/ipc'

const FILE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

function sanitizeBaseName(value: string): string {
  const normalized = value.trim().replace(/\.[^.]+$/u, '')
  const safeName = normalized.replace(/[^a-z0-9._-]+/giu, '-').replace(/-+/g, '-')
  return safeName.replace(/^[-.]+|[-.]+$/g, '')
}

function resolveFileExtension(name: string | undefined, type: string | undefined): string {
  const extensionFromName = path.extname(name?.trim() ?? '')
  if (extensionFromName) {
    return extensionFromName
  }

  const normalizedType = type?.trim().toLowerCase() ?? ''
  return FILE_EXTENSION_BY_MIME[normalizedType] ?? ''
}

function resolveFileBaseName(
  name: string | undefined,
  type: string | undefined,
): string {
  const sanitized = sanitizeBaseName(name ?? '')
  if (sanitized) {
    return sanitized
  }

  if (type?.trim().toLowerCase().startsWith('image/')) {
    return 'pasted-image'
  }

  return 'pasted-file'
}

export class TransientFileStore {
  private rootDirPromise: Promise<string> | null = null

  async persist(input: PersistTransientFileInput): Promise<string> {
    const rootDir = await this.ensureRootDir()
    const filePath = path.join(
      rootDir,
      `${resolveFileBaseName(input.name, input.type)}-${crypto.randomUUID()}${resolveFileExtension(input.name, input.type)}`,
    )

    await writeFile(filePath, new Uint8Array(input.data))
    return filePath
  }

  async dispose(): Promise<void> {
    const rootDirPromise = this.rootDirPromise
    this.rootDirPromise = null

    if (!rootDirPromise) {
      return
    }

    const rootDir = await rootDirPromise.catch(() => null)
    if (!rootDir) {
      return
    }

    await rm(rootDir, { recursive: true, force: true }).catch(() => undefined)
  }

  private async ensureRootDir(): Promise<string> {
    if (!this.rootDirPromise) {
      this.rootDirPromise = mkdtemp(path.join(os.tmpdir(), 'agenclis-paste-'))
    }

    return this.rootDirPromise
  }
}
