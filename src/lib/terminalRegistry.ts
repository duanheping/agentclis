interface TerminalHandle {
  write: (chunk: string) => void
  writeReplay?: (chunk: string) => void
  clear: () => void
  fit: () => void
  focus: () => void
}

export function buildWindowsCommandPromptTerminalId(sessionId: string): string {
  return `${sessionId}:windows-cmd`
}

class TerminalRegistry {
  private readonly handles = new Map<string, TerminalHandle>()
  private readonly bufferedOutput = new Map<string, string[]>()

  register(id: string, handle: TerminalHandle, replayChunks: string[] = []): void {
    this.handles.set(id, handle)

    const pendingChunks = this.bufferedOutput.get(id) ?? []
    const overlapLength = findReplayOverlap(replayChunks, pendingChunks)
    const replayText = replayChunks.join('')
    const pendingText = pendingChunks.slice(overlapLength).join('')
    const replayWriter = handle.writeReplay ?? handle.write

    if (replayText) {
      replayWriter(replayText)
    }

    if (pendingText) {
      handle.write(pendingText)
    }

    this.bufferedOutput.delete(id)
  }

  unregister(id: string): void {
    this.handles.delete(id)
  }

  write(id: string, chunk: string): void {
    const handle = this.handles.get(id)
    if (handle) {
      handle.write(chunk)
      return
    }

    const pendingChunks = this.bufferedOutput.get(id) ?? []
    pendingChunks.push(chunk)

    if (pendingChunks.length > 240) {
      pendingChunks.shift()
    }

    this.bufferedOutput.set(id, pendingChunks)
  }

  clear(id: string): void {
    this.bufferedOutput.delete(id)
    this.handles.get(id)?.clear()
  }

  fit(id: string): void {
    this.handles.get(id)?.fit()
  }

  focus(id: string): void {
    this.handles.get(id)?.focus()
  }

  forget(id: string): void {
    this.bufferedOutput.delete(id)
    this.handles.delete(id)
  }
}

export const terminalRegistry = new TerminalRegistry()

function findReplayOverlap(
  replayChunks: string[],
  pendingChunks: string[],
): number {
  const maxOverlap = Math.min(replayChunks.length, pendingChunks.length)

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    let matches = true

    for (let index = 0; index < overlap; index += 1) {
      if (
        replayChunks[replayChunks.length - overlap + index] !==
        pendingChunks[index]
      ) {
        matches = false
        break
      }
    }

    if (matches) {
      return overlap
    }
  }

  return 0
}
