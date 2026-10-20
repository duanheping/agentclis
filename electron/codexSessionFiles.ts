import { createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'

/** Read only the metadata prefix, including Codex's compressed older rollouts. */
export async function readCodexSessionPrefix(
  filePath: string,
  byteLimit = 4096,
): Promise<string> {
  const input = createReadStream(filePath)
  const output = filePath.endsWith('.zst')
    ? input.pipe(createZstdDecompress())
    : input
  if (output !== input) {
    input.on('error', (error) => output.destroy(error))
  }

  const prefix = Buffer.alloc(byteLimit)
  let bytesRead = 0
  try {
    for await (const chunk of output) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytesRead += buffer.copy(prefix, bytesRead, 0, byteLimit - bytesRead)
      if (bytesRead === byteLimit) {
        break
      }
    }

    return prefix.toString('utf8', 0, bytesRead)
  } finally {
    input.destroy()
    output.destroy()
  }
}
