import type { shell as electronShell } from 'electron'

import { parseExternalLinkTarget } from '../src/shared/externalLinks'

export async function openExternalLinkTarget(
  target: string,
  shell: Pick<typeof electronShell, 'openExternal'>,
): Promise<void> {
  const parsedTarget = parseExternalLinkTarget(target)
  if (!parsedTarget) {
    throw new Error('External link must use an absolute http or https URL.')
  }

  await shell.openExternal(parsedTarget.url)
}
