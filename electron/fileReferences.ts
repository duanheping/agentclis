import { stat } from 'node:fs/promises'
import os from 'node:os'

import type { shell as electronShell } from 'electron'

import { parseFileReferenceTarget } from '../src/shared/fileReferences'

interface OpenFileReferenceOptions {
  baseDir?: string
  statPath?: (filePath: string) => Promise<unknown>
}

export async function openFileReferenceTarget(
  target: string,
  shell: Pick<typeof electronShell, 'openPath'>,
  options: OpenFileReferenceOptions = {},
): Promise<void> {
  const parsedTarget = parseFileReferenceTarget(target, {
    homeDir: os.homedir(),
    baseDir: options.baseDir,
  })
  if (!parsedTarget) {
    throw new Error(
      [
        'File reference must use an absolute, home-relative, or session-relative path.',
        `target="${target}"`,
        options.baseDir ? `baseDir="${options.baseDir}"` : null,
      ].filter(Boolean).join(' '),
    )
  }

  await ensureFileReferencePathExists(
    parsedTarget.raw,
    parsedTarget.path,
    options.baseDir,
    options.statPath ?? stat,
  )

  const message = await shell.openPath(parsedTarget.path)
  if (message) {
    throw new Error(
      `Failed to open file reference (${formatFileReferenceContext(
        parsedTarget.raw,
        parsedTarget.path,
        options.baseDir,
      )}): ${message}`,
    )
  }
}

async function ensureFileReferencePathExists(
  target: string,
  resolvedPath: string,
  baseDir: string | undefined,
  statPath: (filePath: string) => Promise<unknown>,
): Promise<void> {
  try {
    await statPath(resolvedPath)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `File reference path does not exist (${formatFileReferenceContext(
          target,
          resolvedPath,
          baseDir,
        )})`,
      )
    }

    throw new Error(
      `Unable to inspect file reference (${formatFileReferenceContext(
        target,
        resolvedPath,
        baseDir,
      )}): ${getErrorMessage(error)}`,
    )
  }
}

function formatFileReferenceContext(
  target: string,
  resolvedPath: string,
  baseDir: string | undefined,
): string {
  return [
    `target="${target}"`,
    `resolvedPath="${resolvedPath}"`,
    baseDir ? `baseDir="${baseDir}"` : null,
  ].filter(Boolean).join(', ')
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  )
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
