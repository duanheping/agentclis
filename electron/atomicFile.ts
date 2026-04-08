import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const RENAME_RETRY_DELAYS = [10, 50, 100]

async function renameWithRetry(
  source: string,
  target: string,
): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS.length; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        (code === 'EPERM' || code === 'EACCES') &&
        attempt < RENAME_RETRY_DELAYS.length
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, RENAME_RETRY_DELAYS[attempt]),
        )
        continue
      }
      throw error
    }
  }
}

export async function writeUtf8FileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  )

  try {
    await writeFile(tempPath, content, 'utf8')
    await renameWithRetry(tempPath, filePath)
  } catch {
    // Rename failed after retries (Windows AV/indexer lock).
    // Fall back to direct write — not atomic but avoids data loss.
    await rm(tempPath, { force: true })
    await writeFile(filePath, content, 'utf8')
  }
}
