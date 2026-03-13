import os from 'node:os'

import type { shell as electronShell } from 'electron'

import { parseFileReferenceTarget } from '../src/shared/fileReferences'

export async function openFileReferenceTarget(
  target: string,
  shell: Pick<typeof electronShell, 'openPath'>,
): Promise<void> {
  const parsedTarget = parseFileReferenceTarget(target, {
    homeDir: os.homedir(),
  })
  if (!parsedTarget) {
    throw new Error('File reference must use an absolute or home-relative path.')
  }

  const message = await shell.openPath(parsedTarget.path)
  if (message) {
    throw new Error(message)
  }
}
