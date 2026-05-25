import os from 'node:os'

import type { shell as electronShell } from 'electron'

import { parseFileReferenceTarget } from '../src/shared/fileReferences'

interface OpenFileReferenceOptions {
  baseDir?: string
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
      'File reference must use an absolute, home-relative, or session-relative path.',
    )
  }

  const message = await shell.openPath(parsedTarget.path)
  if (message) {
    throw new Error(message)
  }
}
